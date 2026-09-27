import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transition } from '../domain/enums.ts';
import { AppError } from '../lib/errors.ts';
import { runTool, type FfmpegTools } from '../media/ffmpeg.ts';
import type { EncodingSettings } from './settings.ts';

/**
 * Episode assembly with FFmpeg (spec §22, §34, §51).
 *
 * 1. Each timeline shot becomes a normalised segment: exact size (cover +
 *    centre crop, which also reframes 16:9 footage for 9:16 Shorts), exact
 *    fps, exact slot duration (last frame held when speech runs longer),
 *    trim-in, fade-to-black edges. Mock stills get a slow push-in.
 * 2. Segments are joined with cuts or crossfades. A crossfade overlaps into
 *    extra frames rendered on the outgoing shot, so the total length (and
 *    audio sync) never changes.
 * 3. Title cards are drawn with drawtext from text files (no escaping issues).
 * 4. Audio: two-pass EBU R128 loudnorm to the target LUFS / true peak, 48 kHz
 *    stereo AAC.
 * 5. Mux → MP4 (H.264 + AAC, faststart).
 */
export interface AssemblySegment {
  kind: 'video' | 'still';
  path: string;
  durationSec: number;
  trimInSec: number;
  /** Transition INTO this segment from the previous one. */
  transition: Transition;
}

export interface AssemblyTitle {
  text: string;
  startSec: number;
  durationSec: number;
}

export interface AssemblyInput {
  segments: AssemblySegment[];
  titles: AssemblyTitle[];
  mixWavPath: string;
  width: number;
  height: number;
  fps: number;
  workDir: string;
  encoding: EncodingSettings;
  signal?: AbortSignal;
}

export interface LoudnessReport {
  inputLufs: number | null;
  outputLufs: number | null;
  outputTruePeakDb: number | null;
  normalised: boolean;
}

export interface AssemblyOutput {
  masterPath: string;
  durationSec: number;
  loudness: LoudnessReport;
  transitions: { crossfades: number; fades: number };
  titlesDrawn: number;
  warnings: string[];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Parse the last JSON object printed by loudnorm to stderr. */
export function parseLoudnormJson(stderr: string): Record<string, string> | undefined {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch {
    return undefined;
  }
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : null;
};

export class EpisodeAssembler {
  private readonly tools: FfmpegTools;
  private readonly font: string | undefined;

  constructor(tools: FfmpegTools, font?: string) {
    this.tools = tools;
    this.font = font;
  }

  private ff(args: string[], signal?: AbortSignal, timeoutMs?: number) {
    return runTool(this.tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
      ...(signal ? { signal } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  async assemble(input: AssemblyInput): Promise<AssemblyOutput> {
    const { width: W, height: H, fps, encoding: enc } = input;
    if (input.segments.length === 0) throw new AppError('PRECONDITION_FAILED', 'Nothing to assemble');
    await mkdir(input.workDir, { recursive: true });
    const warnings: string[] = [];

    // Crossfade durations into each segment (0 = no crossfade).
    const xfade = input.segments.map((seg, i) => {
      if (i === 0 || seg.transition !== 'crossfade') return 0;
      const prev = input.segments[i - 1]!;
      return r3(Math.min(enc.crossfadeSec, prev.durationSec / 2, seg.durationSec / 2));
    });
    const fade = enc.fadeBlackSec;

    // 1. Normalised segments.
    const segPaths: string[] = [];
    const lengths: number[] = [];
    for (const [i, seg] of input.segments.entries()) {
      const next = input.segments[i + 1];
      const T = r3(seg.durationSec + (xfade[i + 1] ?? 0));
      const frames = Math.max(1, Math.round(T * fps));
      const fades: string[] = [];
      if (i > 0 && seg.transition === 'fade_black') fades.push(`fade=t=in:st=0:d=${Math.min(fade, T / 2)}`);
      if (next?.transition === 'fade_black')
        fades.push(`fade=t=out:st=${r3(Math.max(0, T - Math.min(fade, T / 2)))}:d=${Math.min(fade, T / 2)}`);
      const out = join(input.workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
      const encodeArgs = [
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(Math.max(0, enc.videoCrf - 2)),
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
      ];
      if (seg.kind === 'video') {
        const vf = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
          'setsar=1',
          `fps=${fps}`,
          `tpad=stop_mode=clone:stop_duration=${T}`,
          ...fades,
          'format=yuv420p',
        ];
        await this.ff(
          [
            ...(seg.trimInSec > 0 ? ['-ss', String(seg.trimInSec)] : []),
            '-i',
            seg.path,
            '-vf',
            vf.join(','),
            '-t',
            String(T),
            ...encodeArgs,
            out,
          ],
          input.signal,
        );
      } else {
        const vf = [
          `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
          `crop=${W * 2}:${H * 2}`,
          `zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps}`,
          'setsar=1',
          ...fades,
          'format=yuv420p',
        ];
        await this.ff(
          ['-i', seg.path, '-vf', vf.join(','), '-frames:v', String(frames), ...encodeArgs, out],
          input.signal,
        );
      }
      segPaths.push(out);
      lengths.push(frames / fps);
    }

    // 2. Join + 3. titles.
    // concat outputs the AV_TIME_BASE timebase and xfade needs equal timebases on
    // both inputs, so every input is normalised to it first.
    const filters: string[] = segPaths.map((_, k) => `[${k}:v]settb=AVTB[s${k}]`);
    let label = '[s0]';
    let length = lengths[0]!;
    let crossfades = 0;
    for (let k = 1; k < segPaths.length; k++) {
      const outLabel = `[v${k}]`;
      const d = xfade[k] ?? 0;
      if (d > 0) {
        filters.push(
          `${label}[s${k}]xfade=transition=fade:duration=${d}:offset=${r3(length - d)}${outLabel}`,
        );
        length = length + lengths[k]! - d;
        crossfades++;
      } else {
        filters.push(`${label}[s${k}]concat=n=2:v=1:a=0${outLabel}`);
        length += lengths[k]!;
      }
      label = outLabel;
    }
    let titlesDrawn = 0;
    if (input.titles.length && !this.font)
      warnings.push('No TrueType font found for title cards (set TITLE_FONT_FILE); titles were skipped.');
    if (this.font) {
      for (const [i, t] of input.titles.entries()) {
        const file = join(input.workDir, `title_${i}.txt`);
        await writeFile(file, t.text.slice(0, 300));
        const enable = `between(t\\,${r3(t.startSec)}\\,${r3(t.startSec + t.durationSec)})`;
        const outLabel = `[t${i}]`;
        filters.push(
          `${label}drawtext=fontfile='${this.font}':textfile='${file}':expansion=none:fontcolor=white:fontsize=${Math.round(Math.min(W, H) / 12)}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(Math.min(W, H) / 40)}:x=(w-text_w)/2:y=h*0.78-text_h:enable='${enable}'${outLabel}`,
        );
        label = outLabel;
        titlesDrawn++;
      }
    }
    const video = join(input.workDir, 'video.mp4');
    const inputs = segPaths.flatMap((p) => ['-i', p]);
    const encode = [
      '-c:v',
      'libx264',
      '-preset',
      enc.preset,
      '-crf',
      String(enc.videoCrf),
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-an',
      '-t',
      String(r3(length)),
    ];
    await this.ff(
      [...inputs, '-filter_complex', filters.join(';'), '-map', label, ...encode, video],
      input.signal,
      60 * 60_000,
    );

    // 4. Loudness (two-pass loudnorm) + AAC.
    const audio = join(input.workDir, 'audio.m4a');
    const target = `I=${enc.targetLufs}:TP=${enc.truePeakDb}:LRA=11`;
    const pass1 = await this.ff(
      ['-i', input.mixWavPath, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
      input.signal,
    );
    const m = parseLoudnormJson(pass1.stderr);
    const inputI = num(m?.['input_i']);
    const aac = [
      '-ac',
      '2',
      '-ar',
      enc.sampleRate,
      '-c:a',
      'aac',
      '-b:a',
      `${enc.audioBitrateKbps}k`,
      '-t',
      String(r3(length)),
    ];
    let loudness: LoudnessReport = {
      inputLufs: inputI,
      outputLufs: null,
      outputTruePeakDb: null,
      normalised: false,
    };
    if (m && inputI !== null && inputI > -70) {
      const measured = `measured_I=${m['input_i']}:measured_TP=${m['input_tp']}:measured_LRA=${m['input_lra']}:measured_thresh=${m['input_thresh']}:offset=${m['target_offset']}`;
      const pass2 = await this.ff(
        [
          '-i',
          input.mixWavPath,
          '-af',
          `loudnorm=${target}:${measured}:linear=true:print_format=json,aresample=${enc.sampleRate}`,
          ...aac,
          audio,
        ],
        input.signal,
      );
      const o = parseLoudnormJson(pass2.stderr);
      loudness = {
        inputLufs: inputI,
        outputLufs: num(o?.['output_i']),
        outputTruePeakDb: num(o?.['output_tp']),
        normalised: true,
      };
    } else {
      warnings.push('The mix is (almost) silent; loudness normalisation was skipped.');
      await this.ff(['-i', input.mixWavPath, ...aac, audio], input.signal);
    }

    // 5. Mux.
    const master = join(input.workDir, 'master.mp4');
    await this.ff(
      [
        '-i',
        video,
        '-i',
        audio,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-t',
        String(r3(length)),
        '-movflags',
        '+faststart',
        master,
      ],
      input.signal,
    );
    return {
      masterPath: master,
      durationSec: r3(length),
      loudness,
      transitions: {
        crossfades,
        fades: input.segments.filter((s, i) => i > 0 && s.transition === 'fade_black').length,
      },
      titlesDrawn,
      warnings,
    };
  }
}
