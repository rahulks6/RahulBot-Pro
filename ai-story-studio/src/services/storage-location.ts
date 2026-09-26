import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Studio } from '../app/studio.ts';
import { setEnvValues } from '../config/env-file.ts';
import { storagePaths } from '../config/env.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { folderBytes } from './model-store.ts';
import { freeGb } from './system-health.ts';

/**
 * AI STORAGE LOCATION: one folder (e.g. D:\AI-Story-Studio-Data) holds everything AI Story Studio
 * makes and needs: the database, the encrypted secrets, models, cache, projects, character
 * pictures, videos, Shorts, captions, thumbnails, exports and temp files.
 *
 * Changing it COPIES the data to the new folder, points .env at it, and asks for a restart. The old
 * folder is never deleted by the app (projects, character references and exports are only removed
 * by an explicit action of the person).
 */
export interface StorageArea {
  key: string;
  label: string;
  folder: string;
  bytes: number;
  note: string;
}

const kindOf = (rel: string): string => {
  const parts = rel.split(/[\\/]/);
  if (parts[0] === 'projects') {
    const folder = parts[2] ?? '';
    if (folder === 'references') return 'characters';
    if (folder === 'masters') return 'exports';
    return 'assets';
  }
  if (parts[0] === 'videos') {
    const name = parts[parts.length - 1] ?? '';
    if (/\.(srt|vtt)$/i.test(name)) return 'captions';
    if (/thumbnail/i.test(name)) return 'thumbnails';
    if (/^short-/i.test(name)) return 'shorts';
    return 'videos';
  }
  return 'assets';
};

/** Bytes of the generated-media folder split by what the files are. */
function mediaBreakdown(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        const k = kindOf(relative(root, p));
        out[k] = (out[k] ?? 0) + statSync(p).size;
      }
    }
  };
  walk(root, 0);
  return out;
}

export function storageOverview(s: Studio): {
  location: string;
  freeGb: number | null;
  areas: StorageArea[];
} {
  const p = storagePaths(s.env);
  const media = mediaBreakdown(p.generatedAssets);
  const dl = folderBytes(p.downloadCache);
  const jobs = folderBytes(join(s.env.dataDir, 'worker', 'jobs'));
  const tmp = Math.max(0, folderBytes(p.tempRender) - (p.downloadCache.startsWith(p.tempRender) ? dl : 0));
  const dbBytes = existsSync(join(s.env.dataDir, 'studio.sqlite'))
    ? statSync(join(s.env.dataDir, 'studio.sqlite')).size
    : 0;
  const at = (path: string) => relativeOrFull(s.env.dataDir, path);
  const area = (key: string, label: string, folder: string, bytes: number, note: string): StorageArea => ({
    key,
    label,
    folder,
    bytes,
    note,
  });
  return {
    location: s.env.dataDir,
    freeGb: freeGb(s.env.dataDir),
    areas: [
      area('models', 'Models', at(p.modelCache), folderBytes(p.modelCache), 'Only for LOCAL GPU mode.'),
      area('cache', 'Cache', at(p.downloadCache), dl + jobs, 'Safe to clear (Disk page).'),
      area(
        'projects',
        'Projects',
        'studio.sqlite + backups',
        dbBytes + folderBytes(join(s.env.dataDir, 'backups')),
        'Your stories, scenes and settings.',
      ),
      area(
        'characters',
        'Characters',
        at(join(p.generatedAssets, 'projects')),
        media['characters'] ?? 0,
        'Character reference pictures. Never deleted automatically.',
      ),
      area(
        'assets',
        'Assets',
        at(join(p.generatedAssets, 'projects')),
        media['assets'] ?? 0,
        'Pictures, clips, voices and music.',
      ),
      area('videos', 'Videos', at(join(p.generatedAssets, 'videos')), media['videos'] ?? 0, ''),
      area('shorts', 'Shorts', at(join(p.generatedAssets, 'videos')), media['shorts'] ?? 0, ''),
      area('captions', 'Captions', at(join(p.generatedAssets, 'videos')), media['captions'] ?? 0, ''),
      area('thumbnails', 'Thumbnails', at(join(p.generatedAssets, 'videos')), media['thumbnails'] ?? 0, ''),
      area(
        'exports',
        'Exports',
        at(join(p.generatedAssets, 'projects')),
        media['exports'] ?? 0,
        'Finished full videos. Never deleted automatically.',
      ),
      area('temp', 'Temp', at(p.tempRender), tmp, 'Work files; safe to clear when nothing is being made.'),
    ],
  };
}

/** `child` is strictly inside `parent`. */
function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return !!r && !r.startsWith('..') && !isAbsolute(r);
}

function relativeOrFull(root: string, path: string): string {
  const r = relative(root, path);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : path;
}

export interface MoveState {
  state: 'copying' | 'done' | 'failed';
  from: string;
  to: string;
  totalBytes: number;
  error: string | null;
  backup: string | null;
}

/** What is copied to a new location (everything that is not throw-away). */
const COPY = ['studio.sqlite', 'secrets.json', 'secrets.key', 'storage', 'models', 'backups'];

export class StorageMover {
  private readonly s: Studio;
  private readonly envFile: () => string;
  state: MoveState | null = null;

  constructor(s: Studio, envFile: () => string) {
    this.s = s;
    this.envFile = envFile;
  }

  /** Problems with a proposed folder (empty list = it can be used). */
  check(target: string): { problems: string[]; path: string; needGb: number; freeGb: number | null } {
    const problems: string[] = [];
    const t = target.trim();
    const path = resolve(t);
    const current = resolve(this.s.env.dataDir);
    const p = storagePaths(this.s.env);
    const need =
      COPY.reduce((sum, n) => sum + folderBytes(join(this.s.env.dataDir, n)), 0) +
      (inside(current, p.generatedAssets) ? 0 : folderBytes(p.generatedAssets)) +
      (inside(current, p.modelCache) ? 0 : folderBytes(p.modelCache));
    const needGb = need / 1024 ** 3;
    if (!t) problems.push('Enter a folder, for example D:\\AI-Story-Studio-Data.');
    else if (!isAbsolute(t))
      problems.push(
        'Enter the full path, starting with the drive letter (for example D:\\AI-Story-Studio-Data).',
      );
    else if (path === current) problems.push('That is already the AI storage location.');
    else if (inside(current, path)) problems.push('Choose a folder outside the current storage location.');
    else if (inside(path, current))
      problems.push('Choose a folder that does not contain the current storage location.');
    let free: number | null = null;
    if (!problems.length) {
      if (existsSync(path) && readdirSync(path).length)
        problems.push('That folder is not empty. Choose a new or empty folder.');
      else
        try {
          mkdirSync(path, { recursive: true });
          const probe = join(path, '.ais-write-test');
          writeFileSync(probe, 'ok');
          rmSync(probe);
          free = freeGb(path);
          if (free !== null && free < needGb + 2)
            problems.push(
              `Not enough free space there: ${free.toFixed(1)} GB free, about ${(needGb + 2).toFixed(1)} GB needed.`,
            );
        } catch (err) {
          problems.push(`AI Story Studio cannot write there (${(err as Error).message}).`);
        }
    }
    return { problems, path, needGb, freeGb: free };
  }

  private busy(): string | null {
    if (this.s.orchestrator.runningVideoId()) return 'a video is being made';
    if (this.s.gpuRepo.active().some((i) => i.is_mock === 0)) return 'a cloud GPU is running';
    if (this.s.videos.publications().some((p) => p.status === 'uploading' || p.status === 'approved'))
      return 'a YouTube upload is running';
    const building =
      this.s.db.scalar<number>("SELECT COUNT(*) FROM exports WHERE status IN ('building', 'validating')") ??
      0;
    if (building) return 'a final video is being built';
    return null;
  }

  /** Copy everything to `target` in the background; then .env points there and a restart is needed. */
  start(target: string): MoveState {
    if (this.state?.state === 'copying') throw new AppError('CONFLICT', 'The copy is already running.');
    const busy = this.busy();
    if (busy) throw new AppError('CONFLICT', `Wait until nothing is running (${busy}), then try again.`);
    const c = this.check(target);
    if (c.problems.length) throw new AppError('VALIDATION_FAILED', c.problems.join(' '));
    const from = this.s.env.dataDir;
    const state: MoveState = {
      state: 'copying',
      from,
      to: c.path,
      totalBytes: Math.round(c.needGb * 1024 ** 3),
      error: null,
      backup: null,
    };
    this.state = state;
    this.s.restartRequired = 'The AI storage location is being changed.';
    this.s.logger.info('storage location copy started', { to: c.path });
    void this.copy(state).catch((err: unknown) => {
      state.state = 'failed';
      state.error = toAppError(err).message;
      this.s.restartRequired = null;
      this.s.logger.error('storage location copy failed', { error: state.error });
    });
    return state;
  }

  private async copy(st: MoveState): Promise<void> {
    const p = storagePaths(this.s.env);
    mkdirSync(st.to, { recursive: true });
    // A consistent copy of the live database (the app keeps running while it copies).
    this.s.db.run('VACUUM INTO ?', join(st.to, 'studio.sqlite'));
    for (const name of ['secrets.json', 'secrets.key'])
      if (existsSync(join(st.from, name))) copyFileSync(join(st.from, name), join(st.to, name));
    await cp(p.generatedAssets, join(st.to, 'storage'), {
      recursive: true,
      force: false,
      errorOnExist: false,
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (existsSync(p.modelCache)) await cp(p.modelCache, join(st.to, 'models'), { recursive: true });
    if (existsSync(join(st.from, 'backups')))
      await cp(join(st.from, 'backups'), join(st.to, 'backups'), { recursive: true });
    // Folders for everything the app makes from now on.
    for (const dir of ['storage', 'models', 'tmp', 'logs', 'backups'])
      mkdirSync(join(st.to, dir), { recursive: true });
    const names: Record<string, string> = {
      generatedAssets: 'GENERATED_ASSETS_PATH',
      tempRender: 'TEMP_RENDER_PATH',
      downloadCache: 'DOWNLOAD_CACHE_PATH',
      modelCache: 'MODEL_CACHE_PATH',
    };
    const overrides = Object.keys(this.s.env.paths ?? {}).map((k) => names[k]!);
    st.backup = setEnvValues(
      this.envFile(),
      {
        DATA_DIR: st.to,
        // Separate heavy-file folders (if any were set) now live inside the new location too.
        ...Object.fromEntries(overrides.map((n) => [n, ''])),
      },
      this.s.clock.now(),
    );
    st.state = 'done';
    this.s.restartRequired =
      'The AI storage location was changed. Close AI Story Studio and start it again to use the new folder.';
    this.s.logger.info('storage location copied', { to: st.to });
  }
}
