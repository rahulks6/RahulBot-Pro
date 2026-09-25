import type { StudioCore } from '../app/studio.ts';
import type { Row } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { validateStorageKey } from '../storage/storage.ts';

/**
 * Project backup / restore (spec §63).
 *
 * The backup is one JSON document containing every project-owned row
 * (metadata, story, characters, locations, props, styles, prompts,
 * references, generation history, audio configuration, timeline, quality
 * reports) and — for a full backup — the media files as base64.
 * Restore always creates a NEW project with fresh ids, inside one
 * transaction, so a bad file can never corrupt existing data.
 */
export const BACKUP_FORMAT = 'ai-story-studio/project-backup';
export const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

interface TableSpec {
  table: string;
  prefix: string;
  /** Columns referencing other rows: column → referenced table. */
  fks: Record<string, string>;
  /** Columns holding storage keys (rewritten on restore). */
  keys?: string[];
  /** SQL selecting this project's rows; `?` is the project id. */
  select: string;
  noId?: boolean;
}

const STORY_IDS = 'SELECT id FROM stories WHERE project_id = ?';
const SCENE_IDS = `SELECT id FROM scenes WHERE story_id IN (${STORY_IDS})`;
const SHOT_IDS = `SELECT id FROM shots WHERE scene_id IN (${SCENE_IDS})`;
const CHAR_IDS = 'SELECT id FROM characters WHERE project_id = ?';

/** Order matters: referenced tables first. */
const TABLES: TableSpec[] = [
  {
    table: 'style_presets',
    prefix: 'sty',
    fks: { project_id: 'projects' },
    select: `SELECT * FROM style_presets WHERE project_id = ? OR id IN (SELECT default_style_id FROM projects WHERE id = ?1) OR id IN (SELECT style_id FROM shots WHERE scene_id IN (${SCENE_IDS.replaceAll('?', '?1')}))`,
  },
  {
    table: 'projects',
    prefix: 'prj',
    fks: { default_style_id: 'style_presets', narrator_voice_id: 'voice_profiles' },
    select: 'SELECT * FROM projects WHERE id = ?',
  },
  {
    table: 'reference_assets',
    prefix: 'ref',
    fks: { project_id: 'projects', owner_id: '*' },
    keys: ['storage_key'],
    select: 'SELECT * FROM reference_assets WHERE project_id = ?',
  },
  {
    table: 'voice_profiles',
    prefix: 'vox',
    fks: { project_id: 'projects', reference_asset_id: 'reference_assets' },
    select: 'SELECT * FROM voice_profiles WHERE project_id = ?',
  },
  {
    table: 'characters',
    prefix: 'chr',
    fks: { project_id: 'projects', voice_profile_id: 'voice_profiles' },
    select: CHAR_IDS.replace('SELECT id', 'SELECT *'),
  },
  {
    table: 'character_variants',
    prefix: 'var',
    fks: { character_id: 'characters' },
    select: `SELECT * FROM character_variants WHERE character_id IN (${CHAR_IDS})`,
  },
  {
    table: 'character_references',
    prefix: 'cref',
    fks: {
      character_id: 'characters',
      variant_id: 'character_variants',
      reference_asset_id: 'reference_assets',
    },
    select: `SELECT * FROM character_references WHERE character_id IN (${CHAR_IDS})`,
  },
  {
    table: 'locations',
    prefix: 'loc',
    fks: { project_id: 'projects' },
    select: 'SELECT * FROM locations WHERE project_id = ?',
  },
  {
    table: 'props',
    prefix: 'prp',
    fks: { project_id: 'projects' },
    select: 'SELECT * FROM props WHERE project_id = ?',
  },
  {
    table: 'prop_characters',
    prefix: '',
    noId: true,
    fks: { prop_id: 'props', character_id: 'characters' },
    select: 'SELECT * FROM prop_characters WHERE prop_id IN (SELECT id FROM props WHERE project_id = ?)',
  },
  {
    table: 'stories',
    prefix: 'sto',
    fks: { project_id: 'projects' },
    select: 'SELECT * FROM stories WHERE project_id = ?',
  },
  {
    table: 'scenes',
    prefix: 'scn',
    fks: { story_id: 'stories', location_id: 'locations' },
    select: `SELECT * FROM scenes WHERE story_id IN (${STORY_IDS})`,
  },
  {
    table: 'generated_assets',
    prefix: 'ast',
    fks: { project_id: 'projects', source_asset_id: 'generated_assets' },
    keys: ['storage_key'],
    select: 'SELECT * FROM generated_assets WHERE project_id = ? ORDER BY created_at',
  },
  {
    table: 'shots',
    prefix: 'sht',
    fks: {
      scene_id: 'scenes',
      location_id: 'locations',
      style_id: 'style_presets',
      approved_image_asset_id: 'generated_assets',
      approved_video_asset_id: 'generated_assets',
      lipsync_video_asset_id: 'generated_assets',
    },
    select: `SELECT * FROM shots WHERE scene_id IN (${SCENE_IDS})`,
  },
  {
    table: 'shot_characters',
    prefix: '',
    noId: true,
    fks: { shot_id: 'shots', character_id: 'characters', variant_id: 'character_variants' },
    select: `SELECT * FROM shot_characters WHERE shot_id IN (${SHOT_IDS})`,
  },
  {
    table: 'shot_props',
    prefix: '',
    noId: true,
    fks: { shot_id: 'shots', prop_id: 'props' },
    select: `SELECT * FROM shot_props WHERE shot_id IN (${SHOT_IDS})`,
  },
  {
    table: 'shot_sfx',
    prefix: 'sfx',
    fks: { shot_id: 'shots' },
    select: `SELECT * FROM shot_sfx WHERE shot_id IN (${SHOT_IDS})`,
  },
  {
    table: 'audio_assets',
    prefix: 'aud',
    fks: {
      project_id: 'projects',
      generated_asset_id: 'generated_assets',
      voice_profile_id: 'voice_profiles',
      character_id: 'characters',
    },
    select: 'SELECT * FROM audio_assets WHERE project_id = ?',
  },
  {
    table: 'dialogue_lines',
    prefix: 'dlg',
    fks: { shot_id: 'shots', character_id: 'characters', audio_asset_id: 'audio_assets' },
    select: `SELECT * FROM dialogue_lines WHERE shot_id IN (${SHOT_IDS})`,
  },
  {
    table: 'narration_lines',
    prefix: 'nar',
    fks: { scene_id: 'scenes', shot_id: 'shots', audio_asset_id: 'audio_assets' },
    select: `SELECT * FROM narration_lines WHERE scene_id IN (${SCENE_IDS})`,
  },
  {
    table: 'asset_usages',
    prefix: 'use',
    fks: { asset_id: 'generated_assets', story_id: 'stories', shot_id: 'shots' },
    select:
      'SELECT * FROM asset_usages WHERE asset_id IN (SELECT id FROM generated_assets WHERE project_id = ?)',
  },
  {
    table: 'generation_jobs',
    prefix: 'job',
    fks: { project_id: 'projects', story_id: 'stories', shot_id: 'shots', target_id: '*' },
    select: 'SELECT * FROM generation_jobs WHERE project_id = ?',
  },
  {
    table: 'generation_attempts',
    prefix: 'att',
    fks: {
      job_id: 'generation_jobs',
      project_id: 'projects',
      shot_id: 'shots',
      output_asset_id: 'generated_assets',
      gpu_instance_id: 'gpu_instances',
    },
    select: 'SELECT * FROM generation_attempts WHERE project_id = ?',
  },
  {
    table: 'usage_records',
    prefix: 'usg',
    fks: {
      gpu_instance_id: 'gpu_instances',
      job_id: 'generation_jobs',
      attempt_id: 'generation_attempts',
      project_id: 'projects',
      story_id: 'stories',
      shot_id: 'shots',
    },
    select: 'SELECT * FROM usage_records WHERE project_id = ?',
  },
  {
    table: 'timelines',
    prefix: 'tl',
    fks: { story_id: 'stories' },
    select: `SELECT * FROM timelines WHERE story_id IN (${STORY_IDS})`,
  },
  {
    table: 'timeline_items',
    prefix: 'tli',
    fks: { timeline_id: 'timelines', asset_id: 'generated_assets', source_id: '*' },
    select: `SELECT * FROM timeline_items WHERE timeline_id IN (SELECT id FROM timelines WHERE story_id IN (${STORY_IDS}))`,
  },
  {
    table: 'exports',
    prefix: 'exp',
    fks: { story_id: 'stories', master_asset_id: 'generated_assets', mix_asset_id: 'generated_assets' },
    select: `SELECT * FROM exports WHERE story_id IN (${STORY_IDS})`,
  },
  {
    table: 'quality_reports',
    prefix: 'qr',
    fks: { story_id: 'stories', export_id: 'exports' },
    select: `SELECT * FROM quality_reports WHERE story_id IN (${STORY_IDS})`,
  },
  {
    table: 'similarity_reports',
    prefix: 'sim',
    fks: { story_id: 'stories', compared_story_id: 'stories' },
    select: `SELECT * FROM similarity_reports WHERE story_id IN (${STORY_IDS}) AND compared_story_id IN (${STORY_IDS.replace('?', '?1')})`,
  },
  {
    table: 'review_checklist_items',
    prefix: 'rci',
    fks: { story_id: 'stories' },
    select: `SELECT * FROM review_checklist_items WHERE story_id IN (${STORY_IDS})`,
  },
];

export interface ProjectBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  schemaVersion: number;
  includesMedia: boolean;
  projectName: string;
  tables: Record<string, Row[]>;
  media: Record<string, string>;
}

export async function exportProject(
  s: StudioCore,
  projectId: string,
  opts: { includeMedia: boolean },
): Promise<ProjectBackup> {
  const project = s.projects.get(projectId);
  const tables: Record<string, Row[]> = {};
  for (const spec of TABLES) {
    const sql = spec.select.replaceAll('?1', '?').replace(/\?/g, '?1');
    tables[spec.table] = s.db.all<Row>(sql, projectId);
  }
  const media: Record<string, string> = {};
  if (opts.includeMedia) {
    const keys = new Set<string>();
    for (const spec of TABLES)
      for (const col of spec.keys ?? [])
        for (const row of tables[spec.table] ?? []) keys.add(String(row[col]));
    for (const k of keys)
      if (await s.storage.exists(k)) media[k] = (await s.storage.get(k)).toString('base64');
  }
  s.logger.info('project exported', { project: projectId, includeMedia: opts.includeMedia });
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    schemaVersion: s.db.scalar<number>('SELECT MAX(version) FROM schema_migrations') ?? 0,
    includesMedia: opts.includeMedia,
    projectName: project.name,
    tables,
    media,
  };
}

/** Restore a backup as a NEW project (fresh ids). Atomic: all or nothing. */
export async function importProject(
  s: StudioCore,
  input: string | unknown,
): Promise<{ projectId: string; rows: number; mediaFiles: number }> {
  if (typeof input === 'string' && Buffer.byteLength(input) > MAX_BACKUP_BYTES)
    throw new AppError('VALIDATION_FAILED', 'Backup file is too large');
  let backup: ProjectBackup;
  try {
    backup = (typeof input === 'string' ? JSON.parse(input) : input) as ProjectBackup;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Backup is not valid JSON');
  }
  if (
    !backup ||
    backup.format !== BACKUP_FORMAT ||
    backup.version !== 1 ||
    typeof backup.tables !== 'object'
  ) {
    throw new AppError('VALIDATION_FAILED', 'Not an AI Story Studio project backup');
  }
  const schemaVersion = s.db.scalar<number>('SELECT MAX(version) FROM schema_migrations') ?? 0;
  if (backup.schemaVersion > schemaVersion)
    throw new AppError('VALIDATION_FAILED', 'Backup was made by a newer version of AI Story Studio');
  const projects = backup.tables['projects'];
  if (!Array.isArray(projects) || projects.length !== 1)
    throw new AppError('VALIDATION_FAILED', 'Backup must contain exactly one project');

  // Column allow-list from the live schema: unknown columns are rejected, never interpolated.
  const columns = new Map<string, Set<string>>();
  for (const spec of TABLES) {
    columns.set(
      spec.table,
      new Set(s.db.all<{ name: string }>(`PRAGMA table_info(${spec.table})`).map((c) => c.name)),
    );
  }
  const idMap = new Map<string, string>();
  for (const spec of TABLES) {
    if (spec.noId) continue;
    for (const row of backup.tables[spec.table] ?? []) {
      const old = String(row['id'] ?? '');
      if (!/^[a-z]+_[a-z0-9]+$/.test(old))
        throw new AppError('VALIDATION_FAILED', `Invalid id in ${spec.table}`);
      // Global style presets referenced by the project are copied as project styles.
      idMap.set(old, newId(spec.prefix));
    }
  }
  const newProjectId = idMap.get(String(projects[0]!['id']))!;
  const keyMap = new Map<string, string>();
  const remapKey = (oldKey: string): string => {
    validateStorageKey(oldKey);
    const existing = keyMap.get(oldKey);
    if (existing) return existing;
    const parts = oldKey.split('/');
    const file = parts[parts.length - 1]!;
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const oldId = file.slice(0, file.lastIndexOf('.'));
    const folder = parts.length >= 2 ? parts[parts.length - 2]! : 'misc';
    const next = `projects/${newProjectId}/${folder}/${idMap.get(oldId) ?? newId('file')}.${ext}`;
    keyMap.set(oldKey, next);
    return next;
  };

  let rows = 0;
  const pendingMedia: Array<{ key: string; data: Buffer }> = [];
  s.db.transaction(() => {
    // Insert with deferred FK checks so cyclic references (project ↔ narrator voice) resolve.
    s.db.exec('PRAGMA defer_foreign_keys = ON');
    for (const spec of TABLES) {
      const allowed = columns.get(spec.table)!;
      for (const row of backup.tables[spec.table] ?? []) {
        const out: Record<string, string | number | null> = {};
        for (const [col, value] of Object.entries(row)) {
          if (!allowed.has(col))
            throw new AppError('VALIDATION_FAILED', `Unknown column ${spec.table}.${col}`);
          if (value !== null && !['string', 'number'].includes(typeof value))
            throw new AppError('VALIDATION_FAILED', `Invalid value in ${spec.table}.${col}`);
          out[col] = value as string | number | null;
        }
        if (!spec.noId) out['id'] = idMap.get(String(row['id']))!;
        for (const [col, ref] of Object.entries(spec.fks)) {
          const v = out[col];
          if (typeof v !== 'string' || v === '') continue;
          if (ref === '*') out[col] = remapComposite(v, idMap);
          else if (ref === 'gpu_instances')
            out[col] = null; // GPU instances are machine history, not project data
          else out[col] = idMap.get(v) ?? null;
        }
        if (spec.table === 'style_presets') out['project_id'] = newProjectId;
        for (const col of spec.keys ?? [])
          if (typeof out[col] === 'string') out[col] = remapKey(out[col] as string);
        s.db.insert(spec.table, out);
        rows++;
      }
    }
    const fkProblems = s.db.all('PRAGMA foreign_key_check');
    if (fkProblems.length > 0)
      throw new AppError('VALIDATION_FAILED', `Backup has ${fkProblems.length} broken reference(s)`);
  });

  if (backup.includesMedia && backup.media) {
    for (const [oldKey, b64] of Object.entries(backup.media)) {
      const key = keyMap.get(oldKey);
      if (!key || typeof b64 !== 'string') continue;
      let data = Buffer.from(b64, 'base64');
      // Mock clip/master manifests embed storage keys; point them at the restored files.
      if (key.endsWith('.json')) {
        let text = data.toString('utf8');
        for (const [from, to] of keyMap) text = text.split(from).join(to);
        data = Buffer.from(text, 'utf8');
      }
      pendingMedia.push({ key, data });
    }
    for (const m of pendingMedia) await s.storage.put(m.key, m.data);
  }
  s.logger.info('project imported from backup', { project: newProjectId, rows, media: pendingMedia.length });
  return { projectId: newProjectId, rows, mediaFiles: pendingMedia.length };
}

/** Remap ids embedded in composite text columns (e.g. "chr_x:view:front:"). */
function remapComposite(value: string, idMap: Map<string, string>): string {
  return value.replace(/[a-z]+_[a-z0-9]+/g, (m) => idMap.get(m) ?? m);
}
