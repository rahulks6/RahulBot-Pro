import type { StudioCore } from '../app/studio.ts';
import type { GeneratedAsset } from '../domain/types.ts';
import { jaccard, tokenize } from './quality/text-similarity.ts';

export interface ReuseSuggestion {
  asset: GeneratedAsset;
  score: number;
  reasons: string[];
}

/**
 * Asset reuse suggestions (spec §38). Before expensive generation, look for
 * approved, reusable clips/images from shots with the same location and cast
 * and a similar action. Suggestions are only offered — never applied
 * automatically — so quality is never traded for savings without a human.
 */
export function suggestReuse(s: StudioCore, shotId: string, limit = 5): ReuseSuggestion[] {
  const shot = s.stories.getShot(shotId);
  const scene = s.stories.getScene(shot.scene_id);
  const projectId = s.stories.projectIdForStory(scene.story_id);
  const cast = new Set(s.stories.shotCharacters(shotId).map((c) => c.character_id));
  const locationId = shot.location_id ?? scene.location_id;
  const words = new Set(tokenize(`${shot.action} ${shot.framing} ${shot.emotion}`));
  const candidates = s.db.all<GeneratedAsset & { shot_id: string }>(
    `SELECT g.*, a.shot_id FROM generated_assets g JOIN generation_attempts a ON a.output_asset_id = g.id
     WHERE g.project_id = ? AND g.approval = 'approved' AND g.reusable = 1 AND a.shot_id IS NOT NULL AND a.shot_id != ?
       AND g.kind IN ('image', 'video', 'upscaled_video')`,
    projectId,
    shotId,
  );
  const out: ReuseSuggestion[] = [];
  for (const c of candidates) {
    const other = s.stories.getShot(c.shot_id);
    const otherScene = s.stories.getScene(other.scene_id);
    const reasons: string[] = [];
    let score = 0;
    if (locationId && (other.location_id ?? otherScene.location_id) === locationId) {
      score += 0.35;
      reasons.push('same location');
    }
    const otherCast = new Set(s.stories.shotCharacters(other.id).map((x) => x.character_id));
    const castMatch = cast.size === otherCast.size && [...cast].every((id) => otherCast.has(id));
    if (castMatch) {
      score += 0.35;
      reasons.push(cast.size ? 'same characters' : 'no characters in either shot');
    }
    const sim = jaccard(words, new Set(tokenize(`${other.action} ${other.framing} ${other.emotion}`)));
    score += 0.3 * sim;
    if (sim > 0.3) reasons.push(`similar action/framing (${Math.round(sim * 100)}%)`);
    if (c.continuity_tag) reasons.push(`series ${c.continuity_tag} asset`);
    if (score >= 0.5) out.push({ asset: c, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
