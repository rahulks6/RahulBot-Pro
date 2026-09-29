/**
 * Hand-built, spec-valid media fixtures for media upload tests — no test
 * asset binaries committed to the repo, and no image/video library
 * available to generate them (see backend/README.md). Each function writes
 * real bytes per the format's published spec, not placeholder data.
 */
import * as zlib from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** A real, valid single-color PNG at the given dimensions (8-bit RGB, no interlacing). */
export function buildTestPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = 200; // R
      raw[px + 1] = 30; // G
      raw[px + 2] = 30; // B
    }
  }
  const idat = chunk("IDAT", zlib.deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * A structurally valid JPEG marker stream: SOI, APP0/JFIF, a baseline SOF0
 * declaring the given dimensions, then EOI. Real segment framing per the
 * JPEG spec — just without actual entropy-coded scan data, since nothing
 * in this codebase decodes pixels (only the dimension parser in
 * validation.ts reads up through SOF0, which this satisfies).
 */
export function buildTestJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);

  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const app0Length = Buffer.alloc(2);
  app0Length.writeUInt16BE(jfif.length + 2, 0);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), app0Length, jfif]);

  const sof0Data = Buffer.alloc(15);
  sof0Data[0] = 8; // precision
  sof0Data.writeUInt16BE(height, 1);
  sof0Data.writeUInt16BE(width, 3);
  sof0Data[5] = 1; // number of components
  sof0Data[6] = 1; // component id
  sof0Data[7] = 0x11; // sampling factors
  sof0Data[8] = 0; // quant table id
  const sof0Length = Buffer.alloc(2);
  sof0Length.writeUInt16BE(sof0Data.length + 2, 0);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), sof0Length, sof0Data]);

  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([soi, app0, sof0, eoi]);
}

/** Minimal ISO-BMFF container: just enough of an "ftyp" box to pass the MP4/MOV magic-byte check. */
export function buildTestMp4(): Buffer {
  const majorBrand = Buffer.from("isom", "ascii");
  const minorVersion = Buffer.alloc(4);
  const compatibleBrands = Buffer.from("isomiso2mp41", "ascii");
  const body = Buffer.concat([majorBrand, minorVersion, compatibleBrands]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length, 0);
  return Buffer.concat([size, Buffer.from("ftyp", "ascii"), body]);
}
