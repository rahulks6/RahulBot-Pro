import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError } from '../lib/errors.ts';

/**
 * Local FFmpeg / FFprobe (spec §19 "cheapest location": assembly and audio
 * mastering run on the app machine's CPU, never on a rented GPU).
 * Commands are argument arrays executed WITHOUT a shell.
 */
export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  version: string;
}

function works(bin: string): string | undefined {
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 10_000 });
    if (r.status !== 0) return undefined;
    return r.stdout.toString().split('\n')[0];
  } catch {
    return undefined;
  }
}

let cached: FfmpegTools | null | undefined;

/** Locate FFmpeg: FFMPEG_PATH / FFPROBE_PATH, else the PATH. Returns null when unavailable. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env, useCache = true): FfmpegTools | null {
  if (useCache && cached !== undefined) return cached;
  const ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = env.FFPROBE_PATH || 'ffprobe';
  const version = works(ffmpeg);
  const result = version && works(ffprobe) ? { ffmpeg, ffprobe, version } : null;
  if (useCache) cached = result;
  return result;
}

export function resetFfmpegCache(): void {
  cached = undefined;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function runTool(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 30 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          const lines = String(stderr ?? '').split('\n');
          // Surface the lines that explain the failure, not encoder statistics.
          const relevant = lines.filter((l) =>
            /error|invalid|fail|mismatch|do not match|no such|unable|cannot/i.test(l),
          );
          const tail = (relevant.length ? relevant.slice(0, 6).join('\n') : lines.slice(-8).join('\n')).slice(
            -900,
          );
          reject(
            new AppError(
              'FFMPEG_FAILED',
              `${bin.split(/[\\/]/).pop()} failed (${(err.message.split('\n')[0] ?? '').slice(0, 300)}): ${tail}`.trim(),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** A TrueType font for title cards: TITLE_FONT_FILE, else common system locations. */
export function findTitleFont(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.TITLE_FONT_FILE,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    'C:\\\\Windows\\\\Fonts\\\\arialbd.ttf',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p));
}
