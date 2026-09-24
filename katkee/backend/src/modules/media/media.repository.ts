import { nullable, queryOne } from "../../db/psql";
import type { MediaKind, ValidatedMedia } from "./validation";

export interface MediaRecord {
  id: string;
  ownerId: string;
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksumSha256: string;
  storageKey: string;
  status: "processing" | "ready" | "failed";
  createdAt: string;
}

function mapRow(row: Record<string, string | null>): MediaRecord {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    kind: row.kind as MediaKind,
    mimeType: row.mime_type as string,
    byteSize: Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    checksumSha256: row.checksum_sha256 as string,
    storageKey: row.storage_key as string,
    status: row.status as MediaRecord["status"],
    createdAt: row.created_at as string,
  };
}

export async function createMedia(input: {
  ownerId: string;
  kind: MediaKind;
  storageKey: string;
  byteSize: number;
  checksumSha256: string;
  validated: ValidatedMedia;
}): Promise<MediaRecord> {
  const row = await queryOne(
    `INSERT INTO media (owner_id, kind, mime_type, byte_size, width, height, duration_ms, checksum_sha256, storage_key, status)
     VALUES (:'owner_id', :'kind', :'mime_type', :'byte_size', ${nullable("width", "integer")}, ${nullable("height", "integer")}, ${nullable("duration_ms", "integer")}, :'checksum', :'storage_key', 'ready')
     RETURNING id, owner_id, kind, mime_type, byte_size, width, height, duration_ms, checksum_sha256, storage_key, status, created_at`,
    {
      owner_id: input.ownerId,
      kind: input.kind,
      mime_type: input.validated.mimeType,
      byte_size: input.byteSize,
      width: input.validated.width,
      height: input.validated.height,
      duration_ms: input.validated.durationMs,
      checksum: input.checksumSha256,
      storage_key: input.storageKey,
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapRow(row);
}

export async function findMediaById(id: string): Promise<MediaRecord | null> {
  const row = await queryOne(
    `SELECT id, owner_id, kind, mime_type, byte_size, width, height, duration_ms, checksum_sha256, storage_key, status, created_at
     FROM media WHERE id = :'id'`,
    { id },
  );
  return row ? mapRow(row) : null;
}
