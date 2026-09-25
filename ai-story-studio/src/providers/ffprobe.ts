import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StorageProvider } from '../storage/storage.ts';
import type { MediaProbe, ProbeResult } from './types.ts';

const run = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [a, b] = rate.split('/').map(Number);
  return b ? (a ?? 0) / b : (a ?? 0);
}

/**
 * Real media probe using the local `ffprobe` binary. Arguments are passed as
 * an array (no shell), and only paths resolved by the storage provider are
 * probed. Used for real MP4 masters from Phase 4 onwards; available now for
 * manually supplied files.
 */
export class FfprobeMediaProbe implements MediaProbe {
  readonly id = 'ffprobe';
  private readonly storage: StorageProvider;
  private readonly binary: string;

  constructor(storage: StorageProvider, binary = 'ffprobe') {
    this.storage = storage;
    this.binary = binary;
  }

  async probe(storageKey: string): Promise<ProbeResult> {
    const base: ProbeResult = {
      exists: false,
      readable: false,
      decodes: false,
      container: '',
      durationSec: 0,
      isMock: false,
      notes: [],
    };
    if (!(await this.storage.exists(storageKey))) return { ...base, notes: ['file does not exist'] };
    const path = this.storage.localPath(storageKey);
    let info: { streams?: FfprobeStream[]; format?: { format_name?: string; duration?: string } };
    try {
      const { stdout } = await run(
        this.binary,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      info = JSON.parse(stdout) as typeof info;
    } catch (err) {
      return { ...base, exists: true, notes: [`ffprobe failed: ${(err as Error).message}`] };
    }
    const v = info.streams?.find((s) => s.codec_type === 'video');
    const a = info.streams?.find((s) => s.codec_type === 'audio');
    let decodes = true;
    let peakDb = -Infinity;
    try {
      // Full decode pass; volumedetect reports the peak level for clipping checks.
      const { stderr } = await run(
        this.binary.replace(/ffprobe$/, 'ffmpeg'),
        ['-v', 'info', '-nostats', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
        { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const m = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
      if (m?.[1]) peakDb = Number(m[1]);
    } catch (err) {
      decodes = false;
      base.notes.push(`decode failed: ${(err as Error).message}`);
    }
    return {
      exists: true,
      readable: true,
      decodes,
      container: info.format?.format_name ?? '',
      durationSec: Number(info.format?.duration ?? 0),
      ...(v
        ? {
            video: {
              codec: v.codec_name ?? '',
              width: v.width ?? 0,
              height: v.height ?? 0,
              fps: parseRate(v.avg_frame_rate),
            },
          }
        : {}),
      ...(a
        ? {
            audio: {
              codec: a.codec_name ?? '',
              sampleRate: Number(a.sample_rate ?? 0),
              channels: a.channels ?? 0,
              peakDb,
              clippedSamples: peakDb >= -0.01 ? 1 : 0,
            },
          }
        : {}),
      isMock: false,
      notes: base.notes,
    };
  }
}
