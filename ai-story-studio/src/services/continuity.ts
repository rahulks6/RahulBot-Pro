import type { EpisodeNotes, SeriesBrief, StoryScript } from '../domain/script.ts';
import type { EpisodeFeatures } from '../repositories/series.ts';

/**
 * Continuity helpers for a series: duplicate-story detection between episodes and a rule-based
 * continuity check of a new script against canon. Deterministic (no AI), so they are fully
 * tested; an LLM review can be added on top later.
 */

const STOP = new Set(
  'a an the and or but of to in on at for with by from into onto is are was were be been it its this that these those their his her they them he she we you i our your as up out over under about after before again very just so than then there here what who how when where why which one two three new old big small little'.split(
    ' ',
  ),
);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, '')),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** How much each story feature counts towards "this is the same story again". */
const WEIGHTS: Record<keyof EpisodeFeatures, number> = {
  problem: 0.3,
  resolution: 0.2,
  setpiece: 0.15,
  science: 0.12,
  villain: 0.1,
  setting: 0.08,
  lesson: 0.05,
};

export interface SimilarEpisode {
  episodeId: string;
  number: number;
  score: number;
  fields: string[];
}

/**
 * Similarity (0..1) of a new episode's features to each earlier one. Only fields both episodes
 * describe are compared (weights renormalised), so an episode is never "similar" on empty fields.
 */
export function similarEpisodes(
  features: Partial<EpisodeFeatures>,
  previous: Array<{ id: string; number: number; features: Partial<EpisodeFeatures> }>,
): SimilarEpisode[] {
  const out: SimilarEpisode[] = [];
  for (const p of previous) {
    let sum = 0;
    let weight = 0;
    const fields: string[] = [];
    for (const [k, w] of Object.entries(WEIGHTS) as Array<[keyof EpisodeFeatures, number]>) {
      const a = features[k]?.trim();
      const b = p.features[k]?.trim();
      if (!a || !b) continue;
      const s = jaccard(tokens(a), tokens(b));
      sum += s * w;
      weight += w;
      if (s >= 0.5) fields.push(k);
    }
    if (weight >= 0.4) out.push({ episodeId: p.id, number: p.number, score: sum / weight, fields });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Above this, a premise is "too similar" and is written again (callbacks and sequels stay allowed). */
export const DUPLICATE_THRESHOLD = 0.5;

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[m]![n]!;
}

export interface ContinuityIssue {
  severity: 'fixed' | 'warn' | 'error';
  message: string;
}

/**
 * Checks a new script against canon. Safe, simple contradictions are fixed in place (a canon
 * character's name misspelled); ambiguous ones are reported for the person to decide.
 */
export function checkContinuity(script: StoryScript, brief: SeriesBrief): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const canon = brief.characters.map((c) => c.name);
  const lower = new Map(canon.map((n) => [n.toLowerCase(), n]));
  // 1. Misspelled canon names → the canon spelling everywhere in the script.
  const renames = new Map<string, string>();
  for (const c of script.characters) {
    if (lower.has(c.name.toLowerCase())) {
      const right = lower.get(c.name.toLowerCase())!;
      if (right !== c.name) renames.set(c.name, right);
      continue;
    }
    const near = canon.find((n) => {
      const dist = levenshtein(n.toLowerCase(), c.name.toLowerCase());
      return dist > 0 && dist <= (n.length >= 6 ? 2 : 1);
    });
    if (near) renames.set(c.name, near);
    else
      issues.push({
        severity: 'warn',
        message: `New character "${c.name}" (becomes canon only when you approve the episode).`,
      });
  }
  if (renames.size) {
    const fix = (s: string): string => {
      let out = s;
      for (const [from, to] of renames)
        out = out.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to);
      return out;
    };
    for (const c of script.characters) c.name = renames.get(c.name) ?? c.name;
    for (const sc of script.scenes)
      for (const sh of sc.shots) {
        sh.characters = sh.characters.map((n) => renames.get(n) ?? n);
        sh.visual = fix(sh.visual);
        if (sh.narration) sh.narration = fix(sh.narration);
        for (const d of sh.dialogue ?? []) {
          d.character = renames.get(d.character) ?? d.character;
          d.line = fix(d.line);
        }
      }
    for (const [from, to] of renames)
      issues.push({
        severity: 'fixed',
        message: `"${from}" is the canon character "${to}": name corrected.`,
      });
  }
  // 2. Canon looks: a canon character must not be redescribed with a different look.
  for (const c of script.characters) {
    const known = brief.characters.find((k) => k.name === c.name);
    if (known && known.look) c.description = known.look;
  }
  // 3. Things canon says are gone/destroyed/unavailable must not appear as if unchanged.
  const gone = brief.facts.filter(
    (f) =>
      /\b(destroyed|gone|lost|left the team|no longer|broken beyond|vanished)\b/i.test(f.fact) && f.subject,
  );
  const scriptText = JSON.stringify(script.scenes).toLowerCase();
  for (const f of gone)
    if (scriptText.includes(f.subject.toLowerCase()))
      issues.push({
        severity: 'error',
        message: `Canon says: "${f.fact}" — but "${f.subject}" appears in this script. Check whether the story explains it.`,
      });
  // 4. Locations: unknown ones are new (proposed canon); the canon name spelling is enforced.
  const places = new Map(brief.locations.map((l) => [l.name.toLowerCase(), l.name]));
  for (const l of script.locations) {
    const right = places.get(l.name.toLowerCase());
    if (right && right !== l.name) {
      for (const sc of script.scenes) if (sc.location === l.name) sc.location = right;
      issues.push({ severity: 'fixed', message: `Location "${l.name}" spelled as canon "${right}".` });
      l.name = right;
    } else if (!right)
      issues.push({ severity: 'warn', message: `New location "${l.name}" (canon after approval).` });
  }
  return issues;
}

/** Proposed canon facts from the writer's notes (they stay 'proposed' until the episode is approved). */
export function proposedFacts(
  notes: EpisodeNotes | undefined,
): Array<{ kind: string; subject: string; fact: string }> {
  if (!notes) return [];
  const allowed = new Set([
    'event',
    'relationship',
    'discovery',
    'new_character',
    'new_location',
    'object_state',
    'character_state',
    'mystery_open',
    'mystery_resolved',
  ]);
  const facts = (notes.canon ?? [])
    .filter((f) => f.fact?.trim())
    .map((f) => ({
      kind: allowed.has(f.kind) ? f.kind : 'event',
      subject: (f.subject ?? '').slice(0, 80),
      fact: f.fact.trim().slice(0, 400),
    }));
  for (const m of notes.opened ?? [])
    if (m.trim()) facts.push({ kind: 'mystery_open', subject: '', fact: m.slice(0, 400) });
  for (const m of notes.resolved ?? [])
    if (m.trim()) facts.push({ kind: 'mystery_resolved', subject: '', fact: m.slice(0, 400) });
  return facts.slice(0, 30);
}
