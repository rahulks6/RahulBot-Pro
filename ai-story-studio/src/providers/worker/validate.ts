import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWav } from '../../media/wav.ts';
import { ProviderError } from '../types.ts';

/** What the worker said about an output file. */
export interface ExpectedFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

/** Smallest plausible real file per type (anything smaller is a truncated or empty result). */
const MIN_BYTES: Record<string, number> = {
  'image/png': 67,
  'image/jpeg': 125,
  'image/webp': 30,
  'audio/wav': 44 + 2 * 100, // header + at least 100 samples
  'video/mp4': 1024,
  'application/json': 2,
};

export function sniffMime(data: Uint8Array): string | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE')
    return 'audio/wav';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (b.length >= 1 && (b[0] === 0x7b || b[0] === 0x5b)) return 'application/json';
  return null;
}

export interface ValidationOptions {
  /** Directory for temporary partial files (DATA_DIR/tmp/downloads). */
  tmpDir?: string;
  /** Media readability check on a real file (ffprobe). Returns an error message, or null when readable. */
  probe?: (path: string, mime: string) => Promise<string | null>;
}

const reject = (name: string, why: string): ProviderError =>
  new ProviderError(
    'DOWNLOAD_FAILED',
    `Asset download failed validation (${name}: ${why}). The corrupted file was discarded.`,
  );

/**
 * Validate a downloaded worker output before it may become a project asset:
 * size, checksum, declared vs actual file type, minimum size, decodability
 * (WAV) and, for video, readability with ffprobe on a temporary partial file.
 * The partial file is always removed; the caller stores the verified bytes.
 */
export async function validateDownload(
  expected: ExpectedFile,
  data: Buffer,
  opts: ValidationOptions = {},
): Promise<void> {
  if (data.length === 0) throw reject(expected.name, 'empty file');
  if (data.length !== expected.size)
    throw reject(expected.name, `expected ${expected.size} bytes, got ${data.length}`);
  if (createHash('sha256').update(data).digest('hex') !== expected.sha256)
    throw reject(expected.name, 'checksum mismatch');
  const actual = sniffMime(data);
  const declared = expected.mime.includes('mock-') ? 'application/json' : expected.mime;
  if (actual !== declared)
    throw reject(expected.name, `declared ${expected.mime} but the content is ${actual ?? 'unknown'}`);
  const min = MIN_BYTES[declared] ?? 1;
  if (data.length < min) throw reject(expected.name, `only ${data.length} bytes`);
  if (declared === 'audio/wav') {
    try {
      const pcm = decodeWav(data);
      if (pcm.samples.length === 0) throw new Error('no samples');
    } catch (err) {
      throw reject(expected.name, `unreadable WAV (${(err as Error).message})`);
    }
  }
  if (declared === 'video/mp4' && opts.probe && opts.tmpDir) {
    await mkdir(opts.tmpDir, { recursive: true });
    const partial = join(
      opts.tmpDir,
      `${createHash('sha1')
        .update(expected.sha256 + Date.now())
        .digest('hex')
        .slice(0, 16)}.mp4.partial`,
    );
    try {
      await writeFile(partial, data);
      const problem = await opts.probe(partial, declared);
      if (problem) throw reject(expected.name, problem);
    } finally {
      await rm(partial, { force: true });
    }
  }
}
