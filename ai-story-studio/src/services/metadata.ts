/**
 * YouTube metadata drafted from the story: title, description (with chapters when YouTube would
 * accept them), tags, category and language. It is a DRAFT: the person reviews and edits it on the
 * Publish page. Two things are never decided silently: the audience ("made for kids") is left for
 * the person to choose, and the synthetic-content disclosure is ON because the pictures, animation
 * and voices are made by AI.
 */
export interface YoutubeMetadata {
  title: string;
  description: string;
  tags: string[];
  /** YouTube category id: 1 Film & Animation, 27 Education, 24 Entertainment. */
  categoryId: string;
  defaultLanguage: string;
  /** null = not chosen yet; the person must choose before uploading. */
  madeForKids: boolean | null;
  containsSyntheticMedia: boolean;
}

export interface Chapter {
  startSec: number;
  title: string;
}

const LIMIT_TITLE = 100;
const LIMIT_DESCRIPTION = 5000;
const LIMIT_TAGS_CHARS = 480;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** YouTube shows chapters only when the first starts at 0:00, there are ≥ 3, and each is ≥ 10 s. */
export function validChapters(chapters: Chapter[], totalSec: number): Chapter[] {
  if (chapters.length < 3 || chapters[0]!.startSec !== 0) return [];
  for (let i = 0; i < chapters.length; i++) {
    const end = i + 1 < chapters.length ? chapters[i + 1]!.startSec : totalSec;
    if (end - chapters[i]!.startSec < 10) return [];
  }
  return chapters;
}

export function tagsFrom(words: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const w of words.map((x) => x.trim().replace(/[<>",]/g, '')).filter(Boolean)) {
    if (out.some((t) => t.toLowerCase() === w.toLowerCase())) continue;
    if (used + w.length + 1 > LIMIT_TAGS_CHARS) break;
    out.push(w.slice(0, 60));
    used += w.length + 1;
  }
  return out;
}

const DISCLOSURE =
  'This story was made with AI Story Studio: the pictures, animation and voices are AI-generated (synthetic).';

export function episodeMetadata(i: {
  title: string;
  logline: string;
  moral: string;
  characters: string[];
  style: string;
  language: string;
  chapters: Chapter[];
  totalSec: number;
}): YoutubeMetadata {
  const chapters = validChapters(i.chapters, i.totalSec);
  const description = [
    i.logline,
    i.moral ? `\nMoral: ${i.moral}` : '',
    chapters.length
      ? `\nChapters:\n${chapters.map((c) => `${stamp(c.startSec)} ${c.title}`).join('\n')}`
      : '',
    `\n${DISCLOSURE}`,
    `\n#animation #story ${i.characters
      .slice(0, 3)
      .map((c) => `#${c.replace(/[^\p{L}\p{N}]+/gu, '')}`)
      .join(' ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    title: clip(i.title, LIMIT_TITLE),
    description: clip(description, LIMIT_DESCRIPTION),
    tags: tagsFrom([
      ...i.characters,
      i.style,
      'animated story',
      'animation',
      'story time',
      'cartoon',
      i.title,
    ]),
    categoryId: '1',
    defaultLanguage: i.language.split('-')[0] || 'en',
    madeForKids: null,
    containsSyntheticMedia: true,
  };
}

export function shortMetadata(i: {
  episodeTitle: string;
  hook: string;
  characters: string[];
  language: string;
  index: number;
  count: number;
}): YoutubeMetadata {
  const base = i.hook && i.hook.length <= 70 ? i.hook : i.episodeTitle;
  return {
    title: clip(
      `${base}${i.count > 1 && base === i.episodeTitle ? ` (part ${i.index + 1})` : ''} #Shorts`,
      LIMIT_TITLE,
    ),
    description: clip(`From "${i.episodeTitle}".\n\n${DISCLOSURE}\n\n#Shorts #animation`, LIMIT_DESCRIPTION),
    tags: tagsFrom(['Shorts', ...i.characters, 'animation', 'animated story', i.episodeTitle]),
    categoryId: '1',
    defaultLanguage: i.language.split('-')[0] || 'en',
    madeForKids: null,
    containsSyntheticMedia: true,
  };
}
