/**
 * Media validation using hand-parsed magic bytes and container structure —
 * no `file-type`/`sharp`/`ffprobe` package or binary is available in this
 * sandbox (npm/pip installs are blocked, and `apt-get install ffmpeg` was
 * also refused by the network policy — see backend/README.md). Everything
 * here reads real bytes against real published format specs; nothing is
 * guessed from a file extension or a client-supplied Content-Type alone.
 */
import { HttpError } from "../../http/errors";

export type MediaKind = "photo" | "video";

export interface ValidatedMedia {
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MiB

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC);
}

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** ISO base media file format (MP4/MOV): a top-level box whose type is "ftyp" at offset 4-8. */
function isIsoBmff(buf: Buffer): boolean {
  return buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp";
}

/** PNG: signature(8) + length(4) + "IHDR"(4) + width(4 BE) + height(4 BE). */
function readPngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new HttpError(422, "Malformed PNG: missing IHDR chunk.");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: a sequence of marker segments (0xFF, marker, 2-byte length, payload).
 * Scan until a Start-Of-Frame marker (0xC0–0xCF except the DHT/JPG-ext
 * markers 0xC4, 0xC8, 0xCC), whose payload is [precision(1), height(2 BE),
 * width(2 BE), ...].
 */
function readJpegDimensions(buf: Buffer): { width: number; height: number } {
  let offset = 2; // past the initial 0xFFD8
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      throw new HttpError(422, "Malformed JPEG: expected marker.");
    }
    const marker = buf[offset + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2; // markers with no payload
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) throw new HttpError(422, "Malformed JPEG: truncated SOF segment.");
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  throw new HttpError(422, "Malformed JPEG: no Start-Of-Frame segment found.");
}

export function validatePhoto(buf: Buffer, declaredContentType: string): ValidatedMedia {
  if (buf.length === 0) throw new HttpError(400, "Empty upload.");
  if (buf.length > MAX_PHOTO_BYTES) {
    throw new HttpError(413, `Photo exceeds the ${MAX_PHOTO_BYTES / (1024 * 1024)} MiB limit.`);
  }

  if (isPng(buf)) {
    if (declaredContentType !== "image/png") {
      throw new HttpError(415, `Content-Type ${declaredContentType} doesn't match the file's actual PNG data.`);
    }
    const { width, height } = readPngDimensions(buf);
    return { mimeType: "image/png", width, height, durationMs: null };
  }

  if (isJpeg(buf)) {
    if (declaredContentType !== "image/jpeg") {
      throw new HttpError(415, `Content-Type ${declaredContentType} doesn't match the file's actual JPEG data.`);
    }
    const { width, height } = readJpegDimensions(buf);
    return { mimeType: "image/jpeg", width, height, durationMs: null };
  }

  throw new HttpError(415, "Unsupported photo format — only JPEG and PNG are accepted.");
}

export function validateVideo(buf: Buffer, declaredContentType: string): ValidatedMedia {
  if (buf.length === 0) throw new HttpError(400, "Empty upload.");
  if (buf.length > MAX_VIDEO_BYTES) {
    throw new HttpError(413, `Video exceeds the ${MAX_VIDEO_BYTES / (1024 * 1024)} MiB limit.`);
  }

  if (!isIsoBmff(buf)) {
    throw new HttpError(415, "Unsupported video format — only MP4/MOV containers are accepted.");
  }
  if (declaredContentType !== "video/mp4" && declaredContentType !== "video/quicktime") {
    throw new HttpError(415, `Content-Type ${declaredContentType} doesn't match the file's actual MP4/MOV data.`);
  }

  // Width/height/duration require walking the moov→mvhd/tkhd atom tree (or a
  // real decoder) to do properly — deferred rather than guessed; see
  // media.service.ts. The container-format check above is real, not a stub.
  return { mimeType: declaredContentType, width: null, height: null, durationMs: null };
}

export function validateMedia(kind: MediaKind, buf: Buffer, declaredContentType: string): ValidatedMedia {
  return kind === "photo" ? validatePhoto(buf, declaredContentType) : validateVideo(buf, declaredContentType);
}
