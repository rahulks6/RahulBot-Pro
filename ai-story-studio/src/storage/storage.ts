import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppError } from '../lib/errors.ts';

export interface StoredObject {
  key: string;
  sizeBytes: number;
  checksum: string;
}

/**
 * Storage abstraction (spec §47). Phase 1 ships LocalStorageProvider; an
 * S3-compatible provider can implement the same interface later. GPU worker
 * disks are treated as disposable: every generated file is downloaded and
 * stored here before a GPU is terminated.
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Uint8Array | string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<StoredObject>;
  /** Store a local file (e.g. an encoded master) without loading it into memory. */
  putFile(key: string, sourcePath: string): Promise<StoredObject>;
  /** Local filesystem path for streaming (local provider only). */
  localPath(key: string): string;
}

// Keys: relative, lowercase-ish path segments; no traversal, no absolute paths,
// no hidden files, limited extension set.
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)*$/;
export const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'wav', 'mp3', 'mp4', 'json', 'txt']);
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export function validateStorageKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) {
    throw new AppError('FORBIDDEN', 'Invalid storage key');
  }
  if (
    !KEY_PATTERN.test(key) ||
    key.split('/').some((seg) => seg === '..' || seg === '.' || seg.startsWith('.'))
  ) {
    throw new AppError('FORBIDDEN', `Invalid storage key: ${key}`);
  }
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new AppError('FORBIDDEN', `File extension not allowed: .${ext}`);
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  localPath(key: string): string {
    validateStorageKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new AppError('FORBIDDEN', 'Path escapes storage root');
    return full;
  }

  async put(key: string, data: Uint8Array | string): Promise<StoredObject> {
    const path = this.localPath(key);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new AppError('STORAGE_FAILED', 'Object too large');
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (err) {
      throw new AppError('STORAGE_FAILED', `Failed to write ${key}: ${(err as Error).message}`);
    }
    return { key, sizeBytes: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.localPath(key));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('NOT_FOUND', `Stored object not found: ${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async putFile(key: string, sourcePath: string): Promise<StoredObject> {
    const dst = this.localPath(key);
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(sourcePath, dst);
    } catch (err) {
      throw new AppError('STORAGE_FAILED', `Failed to store ${key}: ${(err as Error).message}`);
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(dst)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { key, sizeBytes: size, checksum: hash.digest('hex') };
  }

  async copy(fromKey: string, toKey: string): Promise<StoredObject> {
    const src = this.localPath(fromKey);
    const dst = this.localPath(toKey);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const data = await readFile(dst);
    return {
      key: toKey,
      sizeBytes: data.byteLength,
      checksum: createHash('sha256').update(data).digest('hex'),
    };
  }
}

export function mimeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'mp4':
      return 'video/mp4';
    case 'json':
      return 'application/json';
    default:
      return 'text/plain; charset=utf-8';
  }
}
