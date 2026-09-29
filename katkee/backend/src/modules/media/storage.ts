/**
 * Object storage abstraction. `LocalDiskMediaStorage` is the only
 * implementation today — no S3/GCS credentials or SDK are available in
 * this sandbox — but every call site goes through this interface, so
 * swapping in a real object-store client later touches only this file.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface MediaStorage {
  write(key: string, data: Buffer): Promise<void>;
  /** Atomically (same filesystem) adopts a file written by newTempFilePath() as the object at `key`. */
  commitTempFile(key: string, tempFilePath: string): Promise<void>;
  newTempFilePath(): Promise<string>;
  readStream(key: string): fs.ReadStream;
  exists(key: string): Promise<boolean>;
  sizeOf(key: string): Promise<number>;
}

export class LocalDiskMediaStorage implements MediaStorage {
  constructor(private readonly rootDir: string) {}

  private resolvePath(key: string): string {
    // Keys are always server-generated UUIDs (see media.service.ts) — this
    // guard exists so a future caller can't be tricked into path traversal
    // by an attacker-controlled key.
    if (!/^[a-f0-9-]+$/i.test(key)) {
      throw new Error(`Invalid media storage key: ${key}`);
    }
    return path.join(this.rootDir, key.slice(0, 2), key);
  }

  async write(key: string, data: Buffer): Promise<void> {
    const filePath = this.resolvePath(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, data, { flag: "wx" }); // wx: never silently overwrite
  }

  async newTempFilePath(): Promise<string> {
    const tmpDir = path.join(this.rootDir, "tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    return path.join(tmpDir, randomUUID());
  }

  async commitTempFile(key: string, tempFilePath: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsp.rename(tempFilePath, filePath);
    } catch (err) {
      // Cross-device rename (EXDEV) — fall back to copy + remove.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fsp.copyFile(tempFilePath, filePath);
      await fsp.unlink(tempFilePath);
    }
  }

  readStream(key: string): fs.ReadStream {
    return fs.createReadStream(this.resolvePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(key: string): Promise<number> {
    const stat = await fsp.stat(this.resolvePath(key));
    return stat.size;
  }
}
