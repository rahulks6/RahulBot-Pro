import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * What is installed in the model folder (MODEL_CACHE_PATH), read straight from the
 * Hugging Face cache layout — no worker, network or Python needed:
 *
 *   models--ORG--NAME/refs/<revision>        commit id of the installed snapshot
 *   models--ORG--NAME/snapshots/<commit>/…   the files (links into blobs/, or copies on Windows)
 *   models--ORG--NAME/blobs/*.incomplete     a download that was interrupted (resumable)
 */
export type InstallState = 'builtin' | 'not_installed' | 'partial' | 'installed';

export interface RepoSpec {
  repo: string;
  revision?: string;
  allowPatterns?: string[];
  ignorePatterns?: string[];
  /** Files that must exist for the model to load (checked in the snapshot). */
  required?: string[];
}

export interface RepoState {
  repo: string;
  state: InstallState;
  bytes: number;
  path: string;
  commit: string | null;
  missing: string[];
  /** Interrupted download files (resumed by the next Install). */
  incomplete: number;
}

export function repoFolder(cacheDir: string, repo: string): string {
  return join(cacheDir, `models--${repo.replace('/', '--')}`);
}

/** Bytes of real data (blobs + non-link snapshot files), without following links. */
export function folderBytes(path: string): number {
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        try {
          total += lstatSync(p).size;
        } catch {
          // a file removed while scanning
        }
      }
    }
  };
  walk(path, 0);
  return total;
}

export function repoState(cacheDir: string, spec: RepoSpec): RepoState {
  const path = repoFolder(cacheDir, spec.repo);
  const base: RepoState = {
    repo: spec.repo,
    state: 'not_installed',
    bytes: 0,
    path,
    commit: null,
    missing: [],
    incomplete: 0,
  };
  if (!existsSync(path)) return base;
  const bytes = folderBytes(path);
  let incomplete = 0;
  try {
    incomplete = readdirSync(join(path, 'blobs')).filter((f) => f.endsWith('.incomplete')).length;
  } catch {
    incomplete = 0;
  }
  const rev = spec.revision || 'main';
  let commit: string | null = null;
  try {
    commit = readFileSync(join(path, 'refs', rev), 'utf8').trim() || null;
  } catch {
    // a commit id can also be used directly as the revision
    commit = existsSync(join(path, 'snapshots', rev)) ? rev : null;
  }
  const snap = commit ? join(path, 'snapshots', commit) : null;
  const required = [
    ...(spec.required ?? []),
    // Exact (wildcard-free) allow patterns name files the download must contain.
    ...(spec.allowPatterns ?? []).filter((p) => !/[*?[]/.test(p)),
  ];
  const missing = snap ? required.filter((f) => !existsSync(join(snap, f))) : required;
  const hasFiles = snap !== null && existsSync(snap) && readdirSync(snap).length > 0;
  const complete = hasFiles && incomplete === 0 && missing.length === 0;
  return {
    ...base,
    state: complete ? 'installed' : 'partial',
    bytes,
    commit,
    missing: snap ? missing : ['snapshot'],
    incomplete,
  };
}

/** Files that must be present for an adapter to load, beyond the exact allow patterns. */
export function requiredFiles(adapter: string, params: Record<string, unknown>): string[] {
  if (adapter === 'diffusers_image' || adapter === 'diffusers_i2v' || adapter === 'stable_audio')
    return ['model_index.json'];
  if (adapter === 'kokoro_tts') return ['config.json'];
  if (adapter === 'spandrel_upscale' && typeof params['hf_filename'] === 'string')
    return [params['hf_filename']];
  return [];
}
