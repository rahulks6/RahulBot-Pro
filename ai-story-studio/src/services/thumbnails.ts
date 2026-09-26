import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTitleFont, runTool, type FfmpegTools } from '../media/ffmpeg.ts';

/**
 * Thumbnail candidates: strong frames of the video (approved pictures) with the title on them,
 * 1280×720 for the episode and 1080×1920 for a Short, JPEG under YouTube's 2 MB limit. The person
 * picks one, asks for others, or uploads their own. Without FFmpeg the picture is used as it is.
 */
export interface ThumbInput {
  image: Uint8Array;
  ext: string;
  title: string;
  vertical: boolean;
}

/** FFmpeg filter-argument escaping for a path (Windows drive letters included). */
export function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function renderThumbnail(
  ff: FfmpegTools | null,
  tempDir: string,
  t: ThumbInput,
): Promise<{ data: Buffer; ext: string }> {
  if (!ff) return { data: Buffer.from(t.image), ext: t.ext };
  mkdirSync(tempDir, { recursive: true });
  const dir = mkdtempSync(join(tempDir, 'thumb-'));
  try {
    writeFileSync(join(dir, `in.${t.ext}`), t.image);
    writeFileSync(join(dir, 'title.txt'), wrapTitle(t.title, t.vertical ? 18 : 28));
    const [W, H] = t.vertical ? [1080, 1920] : [1280, 720];
    const font = findTitleFont();
    const filters = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`];
    if (font)
      filters.push(
        `drawtext=fontfile='${filterPath(font)}':textfile=title.txt:fontsize=${t.vertical ? 84 : 64}:fontcolor=white:borderw=6:bordercolor=black@0.85:line_spacing=10:x=(w-text_w)/2:y=h-text_h-${t.vertical ? 260 : 60}`,
      );
    await runTool(
      ff.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-i',
        `in.${t.ext}`,
        '-vf',
        filters.join(','),
        '-frames:v',
        '1',
        '-q:v',
        '3',
        'thumb.jpg',
      ],
      { cwd: dir },
    );
    return { data: readFileSync(join(dir, 'thumb.jpg')), ext: 'jpg' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Title on at most three lines. */
export function wrapTitle(title: string, width: number): string {
  const words = title.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\n');
}

/**
 * Burns captions into a Short. Uses FFmpeg's subtitles filter (libass); returns null when this
 * FFmpeg cannot do it, so the Short is kept without burned-in captions (the caption files remain).
 */
export async function burnCaptions(
  ff: FfmpegTools,
  tempDir: string,
  video: Uint8Array,
  srt: string,
): Promise<Buffer | null> {
  mkdirSync(tempDir, { recursive: true });
  const dir = mkdtempSync(join(tempDir, 'captions-'));
  try {
    writeFileSync(join(dir, 'in.mp4'), video);
    writeFileSync(join(dir, 'captions.srt'), srt);
    await runTool(
      ff.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-i',
        'in.mp4',
        '-vf',
        "subtitles=captions.srt:force_style='Fontsize=14,Outline=2,Shadow=0,Alignment=2,MarginV=90'",
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        'out.mp4',
      ],
      { cwd: dir },
    );
    return readFileSync(join(dir, 'out.mp4'));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
