import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import { appRoot } from '../lib/paths.ts';

/**
 * Model registry for cloud generation (Phase 5).
 *
 * The catalog (`worker/models.cloud.json`) is the same file baked into the
 * worker image, so the app and the worker agree on ids and versions. Your
 * choices — which models are enabled and which conditional licences you have
 * acknowledged — are stored locally and sent to each new GPU session as
 * WORKER_ENABLED_MODELS / WORKER_LICENSE_ACK. Non-commercial models are not in
 * the cloud catalog, and a model with an unknown licence can never be enabled.
 */
export const MODEL_CATEGORIES = [
  'text',
  'image',
  'video',
  'tts',
  'music',
  'sfx',
  'upscale',
  'lipsync',
] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export interface CatalogModel {
  id: string;
  name: string;
  type: ModelCategory;
  backend: string;
  repo: string;
  revision: string;
  minVramGb: number;
  recommendedVramGb: number;
  precision: string;
  storageGb: number;
  license: string;
  licenseUrl: string;
  licenseNotes: string;
  commercialUse: 'allowed' | 'conditional' | 'non_commercial' | 'unknown';
  capabilities: string[];
  defaultEnabled: boolean;
  isDefault: boolean;
  /** Local catalog: VRAM with sequential CPU offload (0 = same as minVramGb). */
  offloadMinVramGb: number;
  /** Adapter parameters from the catalog (e.g. hf_filename, presets). */
  params: Record<string, unknown>;
  /** Model Manager download: file patterns for the main repository. */
  download: { allowPatterns?: string[]; ignorePatterns?: string[] };
  /** Additional repositories the model needs (e.g. IP-Adapter weights). */
  extraDownloads: Array<{ repo: string; allowPatterns?: string[]; ignorePatterns?: string[] }>;
}

export interface ModelState extends CatalogModel {
  enabled: boolean;
  licenseAcknowledged: boolean;
  /** Usable = enabled and its licence allows it (conditional needs acknowledgement). */
  usable: boolean;
  blockedReason: string | null;
  /** From the running worker: weights already in the cache (null = unknown, no GPU running). */
  cached: boolean | null;
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

function patterns(v: unknown): { allowPatterns?: string[]; ignorePatterns?: string[] } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const allow = strings(o['allow_patterns']);
  const ignore = strings(o['ignore_patterns']);
  return { ...(allow ? { allowPatterns: allow } : {}), ...(ignore ? { ignorePatterns: ignore } : {}) };
}

interface Overrides {
  enabled: Record<string, boolean>;
  licenseAck: string[];
}

const META_KEY = 'model_overrides';

export class ModelManager {
  private readonly db: Database;
  readonly catalogPath: string;
  private readonly metaKey: string;
  private catalog: CatalogModel[] | undefined;
  /** Filled while a cloud worker is bound: id → cached flag. */
  cachedState = new Map<string, boolean>();

  constructor(
    db: Database,
    catalogPath = join(appRoot(), 'worker', 'models.cloud.json'),
    /** Where enabled/licence choices are stored (the local catalog keeps its own). */
    metaKey = META_KEY,
  ) {
    this.db = db;
    this.catalogPath = catalogPath;
    this.metaKey = metaKey;
  }

  models(): CatalogModel[] {
    if (this.catalog) return this.catalog;
    if (!existsSync(this.catalogPath)) return (this.catalog = []);
    const raw = parseJson<{ models?: Array<Record<string, unknown>> }>(
      readFileSync(this.catalogPath, 'utf8'),
      {},
    );
    const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
    const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.catalog = (raw.models ?? [])
      .filter((m) => (MODEL_CATEGORIES as readonly string[]).includes(s(m['kind'])))
      .map((m) => ({
        id: s(m['id']),
        name: s(m['display_name'], s(m['id'])),
        type: s(m['kind']) as ModelCategory,
        backend: s(m['adapter']),
        repo: s(m['repo']),
        revision: s(m['revision'], 'main') || 'n/a',
        minVramGb: n(m['min_vram_gb']),
        recommendedVramGb: n(m['recommended_vram_gb'], n(m['min_vram_gb'])),
        precision: s(m['precision'], 'n/a'),
        storageGb: n(m['storage_gb']),
        license: s(m['license']),
        licenseUrl: s(m['license_url']),
        licenseNotes: s(m['license_notes']),
        commercialUse: (['allowed', 'conditional', 'non_commercial', 'unknown'].includes(
          s(m['commercial_use']),
        )
          ? s(m['commercial_use'])
          : 'unknown') as CatalogModel['commercialUse'],
        capabilities: Array.isArray(m['capabilities']) ? (m['capabilities'] as unknown[]).map(String) : [],
        defaultEnabled: m['enabled'] === true,
        isDefault: m['default'] === true,
        offloadMinVramGb: n(m['offload_min_vram_gb'], n(m['min_vram_gb'])),
        params: (m['params'] && typeof m['params'] === 'object' ? m['params'] : {}) as Record<
          string,
          unknown
        >,
        download: patterns(m['download']),
        extraDownloads: (Array.isArray(m['extra_downloads']) ? (m['extra_downloads'] as unknown[]) : [])
          .map((d) => ({ repo: s((d as Record<string, unknown>)['repo']), ...patterns(d) }))
          .filter((d) => d.repo.includes('/')),
      }));
    return this.catalog;
  }

  private overrides(): Overrides {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', this.metaKey);
    const o = parseJson<Partial<Overrides>>(row?.value, {});
    return { enabled: o.enabled ?? {}, licenseAck: o.licenseAck ?? [] };
  }

  private save(o: Overrides): void {
    this.db.run(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      this.metaKey,
      JSON.stringify(o),
    );
  }

  states(): ModelState[] {
    const o = this.overrides();
    return this.models().map((m) => {
      const enabled = o.enabled[m.id] ?? m.defaultEnabled;
      const licenseAcknowledged = o.licenseAck.includes(m.id);
      let blockedReason: string | null = null;
      if (m.commercialUse === 'non_commercial' || m.commercialUse === 'unknown')
        blockedReason = `licence ${m.commercialUse === 'unknown' ? 'unknown' : 'forbids commercial use'}`;
      else if (m.commercialUse === 'conditional' && !licenseAcknowledged)
        blockedReason = 'conditional licence not acknowledged yet';
      else if (!enabled) blockedReason = 'disabled';
      return {
        ...m,
        enabled,
        licenseAcknowledged,
        usable: blockedReason === null,
        blockedReason,
        cached: this.cachedState.has(m.id) ? this.cachedState.get(m.id)! : null,
      };
    });
  }

  setEnabled(id: string, enabled: boolean): void {
    const m = this.models().find((x) => x.id === id);
    if (!m) throw new AppError('NOT_FOUND', `Unknown model ${id}`);
    if (enabled && (m.commercialUse === 'non_commercial' || m.commercialUse === 'unknown'))
      throw new AppError(
        'FORBIDDEN',
        `${m.name} cannot be enabled: its licence does not allow our published videos.`,
      );
    const o = this.overrides();
    this.save({ ...o, enabled: { ...o.enabled, [id]: enabled } });
  }

  acknowledgeLicense(id: string, acknowledged: boolean): void {
    const m = this.models().find((x) => x.id === id);
    if (!m) throw new AppError('NOT_FOUND', `Unknown model ${id}`);
    if (m.commercialUse !== 'conditional')
      throw new AppError('PRECONDITION_FAILED', `${m.name} has no conditional licence to acknowledge.`);
    const o = this.overrides();
    const set = new Set(o.licenseAck);
    if (acknowledged) set.add(id);
    else set.delete(id);
    this.save({ ...o, licenseAck: [...set] });
  }

  /** The model used for a category: the usable default, else the first usable one. */
  selected(type: ModelCategory): ModelState | undefined {
    const usable = this.states().filter((m) => m.type === type && m.usable);
    return usable.find((m) => m.isDefault) ?? usable[0];
  }

  /** Environment for a new worker session (`include` narrows it, e.g. to installed models). */
  workerEnv(include: (m: ModelState) => boolean = () => true): Record<string, string> {
    const states = this.states();
    return {
      WORKER_ENABLED_MODELS: states
        .filter((m) => m.usable && include(m))
        .map((m) => m.id)
        .join(','),
      WORKER_LICENSE_ACK: states
        .filter((m) => m.licenseAcknowledged)
        .map((m) => m.id)
        .join(','),
    };
  }

  /** Minimum VRAM needed by the models a batch will use. */
  minVramFor(types: ModelCategory[]): number {
    return Math.max(0, ...types.map((t) => this.selected(t)?.minVramGb ?? 0));
  }
}
