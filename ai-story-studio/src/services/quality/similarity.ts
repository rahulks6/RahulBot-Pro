import type { Finding, SimilarityReport } from '../../domain/types.ts';
import type { QualitySettings } from '../settings.ts';
import {
  containment,
  normalizeTitle,
  pct,
  sequenceSimilarity,
  shingles,
  tokenize,
} from './text-similarity.ts';

/**
 * Everything the originality check compares for one episode. Built from the
 * database by QualityService; kept as plain data so it can be unit tested.
 */
export interface EpisodeFingerprint {
  storyId: string;
  title: string;
  label: string;
  storyText: string;
  dialogue: string[];
  narration: string[];
  prompts: string[];
  /** One token per shot: framing|angle|movement|location. */
  shotPlan: string[];
  /** One token per scene: location|mood. */
  sceneStructure: string[];
  /** Checksums of clips used (continuity-tagged assets excluded). */
  clipChecksums: string[];
  /** Checksums of audio used (continuity-tagged assets excluded). */
  audioChecksums: string[];
}

export type SimilarityRow = Omit<SimilarityReport, 'id' | 'story_id' | 'created_at'>;

/**
 * Compare a new episode with each previous episode of the same project.
 * Names of recurring characters/locations are ignored so that intentional
 * series continuity does not look like duplication. Findings are warnings
 * with explicit numbers — never predictions about platform decisions.
 */
export function compareEpisodes(
  current: EpisodeFingerprint,
  others: EpisodeFingerprint[],
  ignoreWords: ReadonlySet<string>,
  q: QualitySettings,
): { rows: SimilarityRow[]; findings: Finding[] } {
  const rows: SimilarityRow[] = [];
  const findings: Finding[] = [];
  const warn = q.similarityWarnPercent / 100;
  const high = q.similarityHighPercent / 100;
  const text = (parts: string[]) => shingles(tokenize(parts.join(' \n '), ignoreWords));
  const cur = {
    story: text([current.storyText]),
    dialogue: text(current.dialogue),
    narration: text(current.narration),
    prompts: text(current.prompts),
  };
  // Short lines repeated across episodes are likely catchphrases: reported as info, not warnings.
  const shortLines = new Set(
    current.dialogue.filter((d) => tokenize(d).length <= 6).map((d) => d.trim().toLowerCase()),
  );

  for (const other of others) {
    const story = containment(cur.story, text([other.storyText]));
    const dialogue = containment(cur.dialogue, text(other.dialogue));
    const narration = containment(cur.narration, text(other.narration));
    const prompts = containment(cur.prompts, text(other.prompts));
    const shotPlan = sequenceSimilarity(current.shotPlan, other.shotPlan);
    const structure = sequenceSimilarity(current.sceneStructure, other.sceneStructure);
    const otherClips = new Set(other.clipChecksums);
    const sharedClips = current.clipChecksums.filter((c) => otherClips.has(c));
    const otherAudio = new Set(other.audioChecksums);
    const sharedAudio = current.audioChecksums.filter((c) => otherAudio.has(c));
    const assetReuse = current.clipChecksums.length ? sharedClips.length / current.clipChecksums.length : 0;
    const titleDup =
      normalizeTitle(current.title) !== '' && normalizeTitle(current.title) === normalizeTitle(other.title);
    const rowFindings: Finding[] = [];
    const add = (code: string, score: number, what: string): void => {
      if (score >= warn) {
        rowFindings.push({
          code,
          severity: 'warn',
          message: `${current.label} shares ${pct(score)}% of its ${what} with ${other.label}${score >= high ? ' (very high)' : ''}.`,
          ref: other.storyId,
        });
      }
    };
    add('story_similarity', story, 'story text');
    add('dialogue_similarity', dialogue, 'dialogue');
    add('narration_similarity', narration, 'narration');
    add('prompt_similarity', prompts, 'image prompts');
    if (current.shotPlan.length >= 3)
      add('shot_plan_similarity', shotPlan, 'shot sequence (framing/angle/movement/location)');
    if (current.sceneStructure.length >= 3 && structure >= high) {
      rowFindings.push({
        code: 'structure_similarity',
        severity: 'warn',
        message: `${current.label} has a near-identical scene structure to ${other.label} (${pct(structure)}%).`,
        ref: other.storyId,
      });
    }
    if (assetReuse * 100 > q.maxClipReusePercent) {
      rowFindings.push({
        code: 'clip_reuse',
        severity: 'warn',
        message: `${sharedClips.length} of ${current.clipChecksums.length} clips (${pct(assetReuse)}%) are identical to clips in ${other.label}. Tag intentional intros/outros as continuity assets.`,
        ref: other.storyId,
      });
    }
    if (sharedAudio.length > 0) {
      rowFindings.push({
        code: 'audio_reuse',
        severity: sharedAudio.length > 3 ? 'warn' : 'info',
        message: `${sharedAudio.length} audio file(s) are identical to audio in ${other.label}.`,
        ref: other.storyId,
      });
    }
    if (titleDup)
      rowFindings.push({
        code: 'duplicate_title',
        severity: 'warn',
        message: `${current.label} has the same title as ${other.label}.`,
        ref: other.storyId,
      });
    // Exact reuse of longer lines is explained line by line.
    const otherLines = new Map(
      [
        ...other.narration.map((t) => ['narration', t] as const),
        ...other.dialogue.map((t) => ['dialogue', t] as const),
      ].map(([kind, t]) => [`${kind}:${t.trim().toLowerCase()}`, t] as const),
    );
    const reusedLines = [
      ...current.narration.map((t) => ['narration', t] as const),
      ...current.dialogue.map((t) => ['dialogue', t] as const),
    ].filter(([kind, t]) => tokenize(t).length > 6 && otherLines.has(`${kind}:${t.trim().toLowerCase()}`));
    for (const [kind, t] of reusedLines.slice(0, 5)) {
      rowFindings.push({
        code: 'repeated_line',
        severity: 'warn',
        message: `The ${kind} line "${t.length > 70 ? `${t.slice(0, 70)}…` : t}" also appears in ${other.label}.`,
        ref: other.storyId,
      });
    }
    const repeatedShort = other.dialogue.filter((d) => shortLines.has(d.trim().toLowerCase()));
    if (repeatedShort.length > 0) {
      rowFindings.push({
        code: 'catchphrase',
        severity: 'info',
        message: `Short line(s) also used in ${other.label} (possible catchphrase — fine if intentional): "${repeatedShort[0]}".`,
        ref: other.storyId,
      });
    }
    findings.push(...rowFindings);
    rows.push({
      compared_story_id: other.storyId,
      story_similarity: round(story),
      dialogue_similarity: round(dialogue),
      narration_similarity: round(narration),
      shot_plan_similarity: round(shotPlan),
      prompt_similarity: round(prompts),
      asset_reuse: round(assetReuse),
      repeated_clips: sharedClips.length,
      repeated_audio: sharedAudio.length,
      title_duplicate: titleDup ? 1 : 0,
      findings_json: JSON.stringify(rowFindings),
    });
  }
  if (others.length === 0)
    findings.push({
      code: 'no_previous_episodes',
      severity: 'info',
      message: 'No previous episodes in this project to compare with.',
    });
  return { rows, findings };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
