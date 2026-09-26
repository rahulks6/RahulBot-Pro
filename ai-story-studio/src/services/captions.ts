import type { StudioCore } from '../app/studio.ts';
import type { TimelineService } from './timeline.ts';

/**
 * Captions (SRT + WebVTT) from the finished timeline: every narration and dialogue line with the
 * exact start and length it has in the video. Lines are wrapped at 42 characters, at most two lines
 * per caption; longer lines become several captions timed by their share of the words.
 */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

const MAX_LINE = 42;

/** Split text into caption blocks of at most two lines of MAX_LINE characters. */
export function blocks(text: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > MAX_LINE) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 2) out.push(lines.slice(i, i + 2).join('\n'));
  return out;
}

export function cuesFor(
  s: Pick<StudioCore, 'stories' | 'characters'>,
  timeline: TimelineService,
  storyId: string,
  opts: { speakerNames?: boolean } = {},
): Cue[] {
  const view = timeline.view(storyId);
  if (!view) return [];
  const cues: Cue[] = [];
  const speech = view.items
    .filter((i) => (i.track === 'dialogue' || i.track === 'narration') && i.source_id)
    .sort((a, b) => a.start_sec - b.start_sec);
  for (const item of speech) {
    let text = '';
    if (item.source_type === 'dialogue') {
      const d = s.stories.getDialogue(item.source_id);
      const who = opts.speakerNames && d.character_id ? `${s.characters.get(d.character_id).name}: ` : '';
      text = who + d.text;
    } else if (item.source_type === 'narration') text = s.stories.getNarration(item.source_id).text;
    if (!text.trim()) continue;
    const parts = blocks(text);
    const words = parts.map((p) => p.split(/\s+/).length);
    const total = words.reduce((a, b) => a + b, 0);
    let t = item.start_sec;
    parts.forEach((p, i) => {
      const len = (item.duration_sec * words[i]!) / total;
      cues.push({ start: t, end: t + len, text: p });
      t += len;
    });
  }
  // Never overlap: a caption ends when the next one starts.
  for (let i = 0; i < cues.length - 1; i++) cues[i]!.end = Math.min(cues[i]!.end, cues[i + 1]!.start);
  return cues.filter((c) => c.end - c.start >= 0.2);
}

function stamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
}
