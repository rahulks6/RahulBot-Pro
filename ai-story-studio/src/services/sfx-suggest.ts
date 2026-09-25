import type { Location, Scene, Shot } from '../domain/types.ts';

/**
 * Scene audio intelligence (spec §31–§32): suggest SFX and ambience from
 * scene/shot metadata. Suggestions are stored unapproved and require review.
 */
const SFX_RULES: Array<{ match: RegExp; tags: string[] }> = [
  { match: /\b(walk|walking|steps?|run|running|hurr(y|ies)|tiptoe)/, tags: ['footsteps'] },
  { match: /\brain(y|ing)?\b|storm|drizzle/, tags: ['rain'] },
  { match: /thunder|storm|lightning/, tags: ['thunder'] },
  { match: /\bbirds?\b|chirp|morning in the (forest|park)/, tags: ['birds'] },
  { match: /\bdoor|knock/, tags: ['door'] },
  { match: /magic|spell|sparkl|glow|wand|fairy|enchant/, tags: ['magic sparkle'] },
  { match: /\bwind(y)?\b|breeze|gust/, tags: ['wind'] },
  { match: /river|stream|splash|water|ocean|wave|lake/, tags: ['water'] },
  { match: /\bdog|bark|puppy/, tags: ['dog bark'] },
  { match: /\bcat\b|meow|kitten/, tags: ['cat meow'] },
  { match: /\bcar\b|truck|bus|engine|vehicle|train/, tags: ['vehicle'] },
  { match: /crowd|cheer|audience|market|party/, tags: ['crowd'] },
  { match: /rocket|spaceship|launch/, tags: ['spaceship hum'] },
];

const AMBIENCE_RULES: Array<{ match: RegExp; tag: string }> = [
  { match: /rain|storm/, tag: 'rain' },
  { match: /forest|woods|jungle|tree/, tag: 'forest' },
  { match: /ocean|beach|sea|shore/, tag: 'ocean' },
  { match: /city|street|town|market/, tag: 'city' },
  { match: /night|moon|stars/, tag: 'night insects' },
  { match: /classroom|school/, tag: 'classroom' },
  { match: /space|spaceship|station|galaxy/, tag: 'spaceship hum' },
  { match: /wind|mountain|cliff|desert/, tag: 'wind' },
  { match: /crowd|stadium|festival/, tag: 'crowd' },
];

const text = (...parts: Array<string | null | undefined>): string =>
  parts.filter(Boolean).join(' ').toLowerCase();

export function suggestShotSfx(
  shot: Shot,
  scene: Scene,
  location: Location | null,
  existing: string[],
): string[] {
  const t = text(
    shot.action,
    shot.title,
    shot.emotion,
    shot.ambience_notes,
    scene.summary,
    location?.weather,
  );
  const have = new Set(existing.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const rule of SFX_RULES) {
    if (rule.match.test(t))
      for (const tag of rule.tags) if (!have.has(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function suggestAmbience(scene: Scene, location: Location | null): string | undefined {
  const t = text(
    scene.summary,
    scene.title,
    scene.time_of_day,
    location?.environment,
    location?.description,
    location?.weather,
    location?.name,
  );
  return AMBIENCE_RULES.find((r) => r.match.test(t))?.tag;
}

export function suggestMusicMood(scene: Scene): string | undefined {
  const t = text(scene.summary, scene.title);
  if (/scar|dark|lost|danger|chase|storm|worried|nervous/.test(t)) return 'gentle suspense';
  if (/celebrat|party|win|hooray|festival/.test(t)) return 'celebration';
  if (/magic|discover|glow|secret|wonder/.test(t)) return 'magical discovery';
  if (/sleep|night|bed|dream/.test(t)) return 'gentle bedtime';
  if (/adventure|explore|journey|set off/.test(t)) return 'happy adventure';
  return undefined;
}
