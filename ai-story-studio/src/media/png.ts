import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** RGB pixel painter callback: returns [r, g, b] (0..255) for pixel (x, y). */
export type Painter = (x: number, y: number) => readonly [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Minimal truecolour PNG encoder (used only for clearly-labelled mock images). */
export function encodePng(width: number, height: number, paint: Painter): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PngInfo {
  width: number;
  height: number;
}

/** Read width/height from a PNG header; returns undefined for non-PNG data. */
export function readPngInfo(data: Uint8Array): PngInfo | undefined {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    return undefined;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Decode PNGs written by `encodePng` (8-bit truecolour, filter type 0 only).
 * Used by the mock upscaler; real upscaling is done by open-source models later.
 */
export function decodeSimplePng(data: Uint8Array): { width: number; height: number; rgb: Buffer } {
  const info = readPngInfo(data);
  if (!info) throw new Error('Not a PNG');
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && (buf[offset + 16] !== 8 || buf[offset + 17] !== 2)) {
      throw new Error('Unsupported PNG format');
    }
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + len));
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = info.width * 3 + 1;
  const rgb = Buffer.alloc(info.width * info.height * 3);
  for (let y = 0; y < info.height; y++) {
    if (raw[y * stride] !== 0) throw new Error('Unsupported PNG filter');
    raw.copy(rgb, y * info.width * 3, y * stride + 1, y * stride + stride);
  }
  return { width: info.width, height: info.height, rgb };
}
