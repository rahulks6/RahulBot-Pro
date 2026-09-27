import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AppError } from '../../lib/errors.ts';

/**
 * The AI worker's code, as the app ships it (worker/ in the install folder), packed for a
 * bootstrap pod: `ais_worker/**`, `models.cloud.json`, `requirements-cloud.txt`. The archive is
 * deterministic (sorted names, fixed times and owners), so its SHA-256 identifies the exact code a
 * pod is allowed to run: the app fixes that checksum when it creates the pod.
 */
export interface WorkerBundle {
  data: Buffer;
  sha256: string;
  files: number;
}

/** Python one-liner that starts the bootstrap script passed in AIS_BOOTSTRAP. */
export const BOOTSTRAP_ENTRYPOINT = [
  'python',
  '-c',
  "import base64,os;exec(compile(base64.b64decode(os.environ['AIS_BOOTSTRAP']),'ais_bootstrap','exec'))",
];

function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (value: string, offset: number, length: number): void => {
    h.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8');
  };
  const octal = (n: number, length: number): string => `${n.toString(8).padStart(length - 1, '0')}\0`;
  if (Buffer.byteLength(name) > 100) {
    // ustar prefix/name split at a slash.
    const cut = name.lastIndexOf('/', 155);
    put(name.slice(cut + 1), 0, 100);
    put(name.slice(0, cut), 345, 155);
  } else put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** Minimal deterministic tar (regular files only) → gzip. */
export function tarGz(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    parts.push(tarHeader(e.name, e.data.length, 0o644), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

const cache = new Map<string, WorkerBundle>();

export function workerBundle(workerDir: string): WorkerBundle {
  const hit = cache.get(workerDir);
  if (hit) return hit;
  const pkg = join(workerDir, 'ais_worker');
  if (!existsSync(pkg))
    throw new AppError(
      'PRECONDITION_FAILED',
      `The AI worker code is missing (${pkg}). Reinstall AI Story Studio.`,
    );
  const entries: Array<{ name: string; data: Buffer }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '__pycache__' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(py|json|txt)$/.test(name))
        entries.push({ name: relative(workerDir, path).split(sep).join('/'), data: readFileSync(path) });
    }
  };
  walk(pkg);
  for (const f of ['models.cloud.json', 'requirements-cloud.txt'])
    entries.push({ name: f, data: readFileSync(join(workerDir, f)) });
  const data = tarGz(entries);
  const bundle = { data, sha256: createHash('sha256').update(data).digest('hex'), files: entries.length };
  cache.set(workerDir, bundle);
  return bundle;
}

/** The bootstrap script (worker/bootstrap/ais_bootstrap.py), base64 for the pod environment. */
export function bootstrapScript(workerDir: string): string {
  return readFileSync(join(workerDir, 'bootstrap', 'ais_bootstrap.py')).toString('base64');
}
