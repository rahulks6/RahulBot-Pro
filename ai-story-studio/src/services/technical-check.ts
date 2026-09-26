import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool, type FfmpegTools } from '../media/ffmpeg.ts';
import { readPngInfo } from '../media/png.ts';

/**
 * Automatic TECHNICAL approval of generated pictures and clips (not artistic judgement):
 *
 *   picture — decodes, a usable size (≥ 256 px), not one flat colour, not almost black / white
 *   clip    — decodes without errors, lasts ≥ 1 s, the picture moves (not frozen), not mostly black
 *
 * What passes is approved automatically so the production can continue; what fails is regenerated
 * (retry policy) and, if it keeps failing, shown to the person as "needs attention". Placeholder
 * media (developer test mode) is not real media and is not inspected.
 */
export interface CheckResult {
  ok: boolean;
  problems: string[];
  /** Measurements recorded with the result (size, duration, brightness…). */
  measured: Record<string, number | string>;
}

export class TechnicalCheck {
  private readonly ff: FfmpegTools | null;
  private readonly tempDir: string;

  constructor(ff: FfmpegTools | null, tempDir: string) {
    this.ff = ff;
    this.tempDir = tempDir;
  }

  private async withFile<T>(data: Uint8Array, ext: string, fn: (path: string) => Promise<T>): Promise<T> {
    mkdirSync(this.tempDir, { recursive: true });
    const dir = mkdtempSync(join(this.tempDir, 'check-'));
    const path = join(dir, `media.${ext}`);
    try {
      writeFileSync(path, data);
      return await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async image(data: Uint8Array, ext: string): Promise<CheckResult> {
    const problems: string[] = [];
    const measured: CheckResult['measured'] = {};
    if (!this.ff) {
      const info = ext === 'png' ? readPngInfo(data) : undefined;
      if (info) {
        measured['width'] = info.width;
        measured['height'] = info.height;
        if (Math.min(info.width, info.height) < 256)
          problems.push(`too small (${info.width}×${info.height})`);
      } else measured['note'] = 'not inspected (FFmpeg is not installed)';
      return { ok: problems.length === 0, problems, measured };
    }
    const ff = this.ff;
    return this.withFile(data, ext, async (path) => {
      try {
        const probe = JSON.parse(
          (await runTool(ff.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path])).stdout,
        ) as { streams?: Array<{ width?: number; height?: number }> };
        const s = probe.streams?.[0];
        measured['width'] = s?.width ?? 0;
        measured['height'] = s?.height ?? 0;
        if (!s?.width || !s.height) problems.push('not a readable picture');
        else if (Math.min(s.width, s.height) < 256) problems.push(`too small (${s.width}×${s.height})`);
        const stats = await runTool(ff.ffmpeg, [
          '-v',
          'info',
          '-i',
          path,
          '-vf',
          'signalstats,metadata=print',
          '-f',
          'null',
          '-',
        ]);
        const val = (k: string) =>
          Number(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`).exec(stats.stderr)?.[1] ?? NaN);
        const yavg = val('YAVG');
        const range = val('YMAX') - val('YMIN');
        measured['brightness'] = Math.round(yavg);
        measured['contrast'] = Math.round(range);
        if (Number.isFinite(range) && range < 12) problems.push('one flat colour (no picture)');
        if (Number.isFinite(yavg) && (yavg < 6 || yavg > 250))
          problems.push(yavg < 6 ? 'almost black' : 'almost white');
      } catch (err) {
        problems.push(`cannot be decoded (${(err as Error).message.slice(0, 120)})`);
      }
      return { ok: problems.length === 0, problems, measured };
    });
  }

  async clip(data: Uint8Array): Promise<CheckResult> {
    const problems: string[] = [];
    const measured: CheckResult['measured'] = {};
    if (!this.ff)
      return { ok: true, problems, measured: { note: 'not inspected (FFmpeg is not installed)' } };
    const ff = this.ff;
    return this.withFile(data, 'mp4', async (path) => {
      try {
        const probe = JSON.parse(
          (await runTool(ff.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))
            .stdout,
        ) as {
          streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const v = probe.streams?.find((x) => x.codec_type === 'video');
        const duration = Number(probe.format?.duration ?? 0);
        measured['duration_sec'] = Math.round(duration * 100) / 100;
        measured['size'] = `${v?.width ?? 0}×${v?.height ?? 0}`;
        if (!v) problems.push('no video stream');
        if (duration < 1) problems.push(`too short (${duration.toFixed(2)} s)`);
        const decode = await runTool(ff.ffmpeg, ['-v', 'error', '-i', path, '-f', 'null', '-']);
        if (decode.stderr.trim()) problems.push(`decode errors: ${decode.stderr.trim().slice(0, 160)}`);
        if (duration >= 1) {
          const freeze = await runTool(ff.ffmpeg, [
            '-v',
            'info',
            '-i',
            path,
            '-vf',
            `freezedetect=n=0.003:d=${Math.max(0.5, duration - 0.3).toFixed(2)}`,
            '-an',
            '-f',
            'null',
            '-',
          ]);
          if (/freeze_start/.test(freeze.stderr)) problems.push('the picture does not move');
          const black = await runTool(ff.ffmpeg, [
            '-v',
            'info',
            '-i',
            path,
            '-vf',
            'blackdetect=d=0.3:pic_th=0.98',
            '-an',
            '-f',
            'null',
            '-',
          ]);
          const blackSec = [...black.stderr.matchAll(/black_duration:([\d.]+)/g)].reduce(
            (t, m) => t + Number(m[1]),
            0,
          );
          measured['black_sec'] = Math.round(blackSec * 10) / 10;
          if (blackSec > duration * 0.5) problems.push('mostly black');
        }
      } catch (err) {
        problems.push(`cannot be decoded (${(err as Error).message.slice(0, 120)})`);
      }
      return { ok: problems.length === 0, problems, measured };
    });
  }
}
