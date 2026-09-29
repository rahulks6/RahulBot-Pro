import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { IncomingMessage } from "node:http";
import { HttpError } from "../../http/errors";
import type { MediaStorage } from "./storage";
import { MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, validateMedia, type MediaKind } from "./validation";
import * as mediaRepo from "./media.repository";
import type { MediaRecord } from "./media.repository";

// Enough to reach past a camera JPEG's EXIF/thumbnail segments to its
// Start-Of-Frame marker in the overwhelming majority of real files, while
// staying far below the 25/200 MiB upload caps.
const VALIDATION_PREFIX_BYTES = 2 * 1024 * 1024;

class TooLargeError extends Error {}

/** Hashes and counts bytes as they stream through, aborting early past `maxBytes` instead of buffering the whole upload to find out. */
class SizeLimitingHasher extends Transform {
  private byteCount = 0;
  private readonly hash = createHash("sha256");

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.byteCount += chunk.length;
    if (this.byteCount > this.maxBytes) {
      callback(new TooLargeError());
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  get size(): number {
    return this.byteCount;
  }

  digestHex(): string {
    return this.hash.digest("hex");
  }
}

async function readPrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

async function cleanupQuietly(filePath: string): Promise<void> {
  await fsp.unlink(filePath).catch(() => undefined);
}

export async function receiveUpload(
  req: IncomingMessage,
  ownerId: string,
  kind: MediaKind,
  storage: MediaStorage,
): Promise<MediaRecord> {
  const contentType = req.headers["content-type"];
  if (!contentType) throw new HttpError(400, "Content-Type header is required.");

  const maxBytes = kind === "photo" ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
  const tempPath = await storage.newTempFilePath();
  const limiter = new SizeLimitingHasher(maxBytes);

  try {
    await pipeline(req, limiter, fs.createWriteStream(tempPath));
  } catch (err) {
    await cleanupQuietly(tempPath);
    if (err instanceof TooLargeError) {
      throw new HttpError(413, `Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`);
    }
    throw new HttpError(400, "Upload failed or was interrupted.");
  }

  if (limiter.size === 0) {
    await cleanupQuietly(tempPath);
    throw new HttpError(400, "Empty upload.");
  }

  let validated;
  try {
    const prefix = await readPrefix(tempPath, VALIDATION_PREFIX_BYTES);
    validated = validateMedia(kind, prefix, contentType);
  } catch (err) {
    await cleanupQuietly(tempPath);
    throw err;
  }

  const storageKey = randomUUID();
  await storage.commitTempFile(storageKey, tempPath);

  return mediaRepo.createMedia({
    ownerId,
    kind,
    storageKey,
    byteSize: limiter.size,
    checksumSha256: limiter.digestHex(),
    validated,
  });
}
