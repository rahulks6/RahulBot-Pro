import type { Database } from '../db/database.ts';
import type { Approval, AssetKind, AudioLayer } from '../domain/enums.ts';
import type { AudioAsset, GeneratedAsset, ReferenceAsset } from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { StorageProvider } from '../storage/storage.ts';
import { flag, nowIso, requireRow } from './base.ts';

export interface NewAsset {
  projectId: string;
  kind: AssetKind;
  data: Uint8Array;
  ext: string;
  mime: string;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  fps?: number | null;
  sourceAssetId?: string | null;
  isNativeResolution?: boolean;
  isMock: boolean;
  label?: string;
  tags?: string;
}

export interface AssetFilter {
  projectId?: string;
  kind?: string;
  approval?: string;
  search?: string;
  reusableOnly?: boolean;
  limit?: number;
}

/** Folder per asset kind inside a project's storage area. */
const FOLDERS: Record<AssetKind, string> = {
  image: 'images',
  video: 'clips',
  audio: 'audio',
  upscaled_image: 'images',
  upscaled_video: 'clips',
  lipsync_video: 'clips',
  mix: 'mixes',
  master: 'masters',
};

export class AssetRepository {
  private readonly db: Database;
  private readonly storage: StorageProvider;

  constructor(db: Database, storage: StorageProvider) {
    this.db = db;
    this.storage = storage;
  }

  /** Write the file first, then record it. Assets are append-only; nothing is overwritten. */
  async create(a: NewAsset): Promise<GeneratedAsset> {
    const id = newId('ast');
    const key = `projects/${a.projectId}/${FOLDERS[a.kind]}/${id}.${a.ext}`;
    const stored = await this.storage.put(key, a.data);
    this.db.insert('generated_assets', {
      id,
      project_id: a.projectId,
      kind: a.kind,
      storage_key: key,
      mime: a.mime,
      width: a.width ?? null,
      height: a.height ?? null,
      duration_sec: a.durationSec ?? null,
      fps: a.fps ?? null,
      source_asset_id: a.sourceAssetId ?? null,
      is_native_resolution: flag(a.isNativeResolution ?? true),
      is_mock: flag(a.isMock),
      checksum: stored.checksum,
      size_bytes: stored.sizeBytes,
      label: a.label ?? '',
      tags: a.tags ?? '',
      created_at: nowIso(),
    });
    return this.get(id);
  }

  get(id: string): GeneratedAsset {
    return requireRow<GeneratedAsset>(this.db, 'generated_assets', id, 'Asset');
  }

  find(id: string | null | undefined): GeneratedAsset | undefined {
    if (!id) return undefined;
    return this.db.get<GeneratedAsset>('SELECT * FROM generated_assets WHERE id = ?', id);
  }

  findByKey(storageKey: string): GeneratedAsset | undefined {
    return this.db.get<GeneratedAsset>('SELECT * FROM generated_assets WHERE storage_key = ?', storageKey);
  }

  async read(id: string): Promise<Buffer> {
    return this.storage.get(this.get(id).storage_key);
  }

  list(filter: AssetFilter = {}): Array<GeneratedAsset & { usage_count: number }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.projectId) {
      where.push('a.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.kind) {
      where.push('a.kind = ?');
      params.push(filter.kind);
    }
    if (filter.approval) {
      where.push('a.approval = ?');
      params.push(filter.approval);
    }
    if (filter.reusableOnly) where.push('a.reusable = 1');
    if (filter.search) {
      where.push('(a.label LIKE ? OR a.tags LIKE ? OR a.id LIKE ?)');
      const like = `%${filter.search.replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT a.*, (SELECT COUNT(*) FROM asset_usages u WHERE u.asset_id = a.id) AS usage_count
      FROM generated_assets a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC LIMIT ?`;
    params.push(Math.min(500, filter.limit ?? 200));
    return this.db.all(sql, ...params);
  }

  setApproval(id: string, approval: Approval): void {
    this.get(id);
    this.db.run('UPDATE generated_assets SET approval = ? WHERE id = ?', approval, id);
  }

  setLibraryFlags(
    id: string,
    flags: { reusable?: boolean; continuityTag?: string; tags?: string; label?: string },
  ): void {
    const a = this.get(id);
    this.db.update('generated_assets', id, {
      reusable: flags.reusable === undefined ? a.reusable : flag(flags.reusable),
      continuity_tag: flags.continuityTag ?? a.continuity_tag,
      tags: flags.tags ?? a.tags,
      label: flags.label ?? a.label,
    });
  }

  recordUsage(assetId: string, context: string, storyId?: string | null, shotId?: string | null): void {
    this.db.insert('asset_usages', {
      id: newId('use'),
      asset_id: assetId,
      story_id: storyId ?? null,
      shot_id: shotId ?? null,
      context,
      created_at: nowIso(),
    });
  }

  usageCount(assetId: string): number {
    return this.db.scalar<number>('SELECT COUNT(*) FROM asset_usages WHERE asset_id = ?', assetId) ?? 0;
  }

  // --- Audio assets ---------------------------------------------------------------

  findAudioByCacheKey(
    projectId: string,
    cacheKey: string,
  ): (AudioAsset & { storage_key: string }) | undefined {
    return this.db.get(
      `SELECT au.*, g.storage_key FROM audio_assets au JOIN generated_assets g ON g.id = au.generated_asset_id
       WHERE au.project_id = ? AND au.cache_key = ? AND g.approval != 'rejected' ORDER BY au.created_at DESC LIMIT 1`,
      projectId,
      cacheKey,
    );
  }

  getAudio(id: string): AudioAsset {
    return requireRow<AudioAsset>(this.db, 'audio_assets', id, 'Audio asset');
  }

  findAudio(id: string | null | undefined): AudioAsset | undefined {
    if (!id) return undefined;
    return this.db.get<AudioAsset>('SELECT * FROM audio_assets WHERE id = ?', id);
  }

  createAudio(values: Omit<AudioAsset, 'id' | 'created_at'>): AudioAsset {
    const id = newId('aud');
    this.db.insert('audio_assets', { id, ...values, created_at: nowIso() });
    return this.getAudio(id);
  }

  listAudio(
    projectId: string,
    layer?: AudioLayer,
  ): Array<AudioAsset & { storage_key: string; approval: string }> {
    return this.db.all(
      `SELECT au.*, g.storage_key, g.approval FROM audio_assets au JOIN generated_assets g ON g.id = au.generated_asset_id
       WHERE au.project_id = ? ${layer ? 'AND au.layer = ?' : ''} ORDER BY au.created_at DESC`,
      ...(layer ? [projectId, layer] : [projectId]),
    );
  }

  // --- Reference assets -------------------------------------------------------------

  async createReference(
    projectId: string,
    ownerType: ReferenceAsset['owner_type'],
    ownerId: string,
    data: Uint8Array,
    ext: string,
    mime: string,
    label: string,
    isMock: boolean,
  ): Promise<ReferenceAsset> {
    if (!['png', 'jpg', 'jpeg', 'webp', 'wav'].includes(ext))
      throw new AppError('VALIDATION_FAILED', 'Unsupported reference file type');
    const id = newId('ref');
    const key = `projects/${projectId}/references/${id}.${ext}`;
    await this.storage.put(key, data);
    this.db.insert('reference_assets', {
      id,
      project_id: projectId,
      owner_type: ownerType,
      owner_id: ownerId,
      label,
      storage_key: key,
      mime,
      approved: 0,
      is_mock: flag(isMock),
      created_at: nowIso(),
    });
    return requireRow<ReferenceAsset>(this.db, 'reference_assets', id);
  }

  listReferences(ownerType: ReferenceAsset['owner_type'], ownerId: string): ReferenceAsset[] {
    return this.db.all<ReferenceAsset>(
      'SELECT * FROM reference_assets WHERE owner_type = ? AND owner_id = ? ORDER BY created_at',
      ownerType,
      ownerId,
    );
  }

  setReferenceApproved(id: string, approved: boolean): void {
    const ref = requireRow<ReferenceAsset>(this.db, 'reference_assets', id, 'Reference');
    if (ref.owner_type === 'location') {
      const loc = this.db.get<{ locked: number }>('SELECT locked FROM locations WHERE id = ?', ref.owner_id);
      if (loc?.locked) throw new AppError('LOCKED', 'Location is locked; its references are frozen.');
    }
    this.db.run('UPDATE reference_assets SET approved = ? WHERE id = ?', flag(approved), id);
  }
}
