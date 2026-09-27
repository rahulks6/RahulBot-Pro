import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storagePaths } from '../config/env.ts';
import type { Studio } from '../app/studio.ts';
import { AppError } from '../lib/errors.ts';
import { folderBytes } from './model-store.ts';
import { freeGb } from './system-health.ts';

/**
 * Disk usage and SAFE cleanup. Only temporary / cache data can be cleared here; projects,
 * approved references, final exports and model files are never deleted by these actions
 * (model files are removed one by one in the Model Manager, with confirmation).
 */
export interface DiskArea {
  key: string;
  label: string;
  path: string;
  bytes: number;
  freeGb: number | null;
  clearable: boolean;
  note: string;
}

export type CleanupTarget = 'render_temp' | 'download_cache' | 'worker_jobs';

export function diskUsage(s: Studio): DiskArea[] {
  const p = storagePaths(s.env);
  const exportsBytes =
    s.db.scalar<number>("SELECT COALESCE(SUM(size_bytes), 0) FROM generated_assets WHERE kind = 'master'") ??
    0;
  const media = folderBytes(p.generatedAssets);
  const area = (
    key: string,
    label: string,
    path: string,
    bytes: number,
    clearable: boolean,
    note: string,
  ) => ({
    key,
    label,
    path,
    bytes,
    freeGb: freeGb(path),
    clearable,
    note,
  });
  return [
    area(
      'models',
      'AI models',
      p.modelCache,
      folderBytes(p.modelCache),
      false,
      'Delete per model in the Model Manager.',
    ),
    area(
      'projects',
      'Projects (generated media)',
      p.generatedAssets,
      Math.max(0, media - exportsBytes),
      false,
      'Images, clips, audio and references. Never deleted automatically.',
    ),
    area(
      'exports',
      'Final exports',
      p.generatedAssets,
      exportsBytes,
      false,
      'Finished videos. Never deleted automatically.',
    ),
    area(
      'download_cache',
      'Download cache',
      p.downloadCache,
      folderBytes(p.downloadCache),
      true,
      'Cloud results waiting to be checked; safe to clear when no cloud GPU is running.',
    ),
    area(
      'worker_jobs',
      'Local worker job files',
      join(s.env.dataDir, 'worker', 'jobs'),
      folderBytes(join(s.env.dataDir, 'worker', 'jobs')),
      true,
      'Copies of finished outputs already stored in the project; safe to clear.',
    ),
    area(
      'render_temp',
      'Render temp',
      p.tempRender,
      Math.max(0, folderBytes(p.tempRender) - folderBytes(p.downloadCache)),
      true,
      'BUILD FINAL work folders; safe to clear when no build is running.',
    ),
    area('logs', 'Logs', join(s.env.dataDir, 'logs'), folderBytes(join(s.env.dataDir, 'logs')), false, ''),
    area(
      'backups',
      'Database backups',
      join(s.env.dataDir, 'backups'),
      folderBytes(join(s.env.dataDir, 'backups')),
      false,
      'Automatic copies taken before upgrades (newest 5 kept).',
    ),
  ];
}

function clearChildren(dir: string, keep: (name: string) => boolean = () => false): number {
  if (!existsSync(dir)) return 0;
  let freed = 0;
  for (const name of readdirSync(dir)) {
    if (keep(name)) continue;
    const path = join(dir, name);
    freed += folderBytes(path) || 0;
    rmSync(path, { recursive: true, force: true });
  }
  return freed;
}

/** Clear one temporary area; refused while something is using it. Returns bytes freed. */
export function cleanup(s: Studio, target: CleanupTarget): number {
  const p = storagePaths(s.env);
  if (target === 'render_temp') {
    const building =
      s.db.scalar<number>("SELECT COUNT(*) FROM exports WHERE status IN ('building', 'validating')") ?? 0;
    if (building)
      throw new AppError('CONFLICT', 'A BUILD FINAL is running; clear the render temp afterwards.');
    // The download cache may live inside the temp folder: keep it (it has its own button).
    const dl = p.downloadCache.startsWith(p.tempRender)
      ? p.downloadCache.slice(p.tempRender.length + 1).split(/[\\/]/)[0]
      : '';
    return clearChildren(p.tempRender, (n) => n === dl);
  }
  if (target === 'download_cache') {
    if (s.gpuRepo.active().length)
      throw new AppError('CONFLICT', 'A GPU session is running; try again when it has finished.');
    return clearChildren(p.downloadCache);
  }
  // worker_jobs: only finished jobs (their outputs were already copied into the project).
  const dir = join(s.env.dataDir, 'worker', 'jobs');
  return clearChildren(dir, (name) => {
    try {
      const status = (JSON.parse(readFileSync(join(dir, name, 'job.json'), 'utf8')) as { status?: string })
        .status;
      return !['complete', 'failed', 'cancelled'].includes(status ?? '');
    } catch {
      return true; // unknown folders are kept
    }
  });
}
