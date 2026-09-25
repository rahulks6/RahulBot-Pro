/**
 * 16-bit PCM mono WAV encode/decode plus small DSP helpers. Used by the mock
 * audio providers and by the preview mixer. Real mixing/encoding of the final
 * master uses FFmpeg in later phases.
 */
export const DEFAULT_SAMPLE_RATE = 22_050;

export interface PcmAudio {
  sampleRate: number;
  /** Mono samples in the range [-1, 1] (values outside are clipped on encode). */
  samples: Float32Array;
}

export function encodeWav(audio: PcmAudio): Buffer {
  const { sampleRate, samples } = audio;
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** Decode a 16-bit PCM WAV (mono, or multi-channel downmixed to mono). */
export function decodeWav(data: Uint8Array): PcmAudio {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
    } else if (id === 'data') {
      const frames = Math.floor(Math.min(size, buf.length - body) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (f * channels + c) * 2) / 32768;
        samples[f] = sum / channels;
      }
      if (!sampleRate) throw new Error('WAV missing fmt chunk');
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV missing data chunk');
}

export function durationOf(audio: PcmAudio): number {
  return audio.samples.length / audio.sampleRate;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

export interface LevelStats {
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  /** Samples at or beyond full scale (|s| >= 0.999). */
  clippedSamples: number;
}

export function levels(samples: Float32Array, from = 0, to = samples.length): LevelStats {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  const end = Math.min(to, samples.length);
  const start = Math.max(0, from);
  for (let i = start; i < end; i++) {
    const s = samples[i] ?? 0;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += s * s;
  }
  const n = Math.max(1, end - start);
  const rms = Math.sqrt(sumSq / n);
  return { peak, peakDb: gainToDb(peak), rms, rmsDb: gainToDb(rms), clippedSamples: clipped };
}
