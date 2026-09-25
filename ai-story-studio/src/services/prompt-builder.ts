import type {
  Character,
  CharacterVariant,
  Location,
  Project,
  Prop,
  Scene,
  Shot,
  StylePreset,
} from '../domain/types.ts';
import type { ReferenceInput } from '../providers/types.ts';
import { parseJson } from '../lib/json.ts';

/**
 * Prompt Builder (spec §17). Combines style, Character Lock (+variant),
 * Location Lock, props, scene, action, emotion, camera, lighting, continuity
 * and negatives into the generation prompt, and explains where each part
 * came from. Manually locked prompts are used verbatim and never replaced.
 */
export interface PromptSection {
  label: string;
  source: string;
  text: string;
}

export interface CastMember {
  character: Character;
  variant: CharacterVariant | null;
  references: Array<{ storage_key: string; slot: string }>;
}

export interface PromptContext {
  project: Project;
  scene: Scene;
  shot: Shot;
  style: StylePreset | null;
  location: Location | null;
  cast: CastMember[];
  props: Prop[];
  locationReferences: Array<{ storage_key: string; label: string }>;
  previousShot: Shot | null;
}

export interface BuiltPrompt {
  /** Automatically composed prompts. */
  built: { image: string; motion: string; negative: string };
  /** What generation will actually use (manual text when locked). */
  final: { image: string; motion: string; negative: string };
  manual: { image: boolean; motion: boolean; negative: boolean };
  sections: PromptSection[];
  references: ReferenceInput[];
}

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function joinParts(parts: Array<string | null | undefined>, sep = ', '): string {
  return parts.map(clean).filter(Boolean).join(sep);
}

/** Merge comma-separated negative terms, removing duplicates (case-insensitive). */
export function mergeNegatives(...lists: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const term of clean(list).split(',')) {
      const t = term.trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        out.push(t);
      }
    }
  }
  return out.join(', ');
}

/** Canonical character fields: the lock snapshot when locked, live fields otherwise. */
export function canonicalCharacter(c: Character): Character {
  if (!c.locked) return c;
  const snap = parseJson<{ fields?: Record<string, unknown> } | undefined>(c.lock_snapshot_json, undefined);
  return snap?.fields ? ({ ...c, ...snap.fields } as Character) : c;
}

export function describeCharacter(member: CastMember): string {
  const c = canonicalCharacter(member.character);
  const v = member.variant;
  const who = joinParts([c.species, c.age ? `age ${c.age}` : ''], ', ');
  const clothing = v?.clothing_override ? v.clothing_override : c.clothing;
  const body = joinParts([
    c.prompt,
    c.face && `face: ${c.face}`,
    c.hair && `hair/fur: ${c.hair}`,
    c.eyes && `eyes: ${c.eyes}`,
    c.body && `body: ${c.body}`,
    c.proportions && `proportions: ${c.proportions}`,
    clothing && `wearing ${clothing}`,
    c.accessories && `accessories: ${c.accessories}`,
    c.colors && `colours: ${c.colors}`,
    v?.prompt_additions,
  ]);
  return `${c.name}${who ? ` (${who})` : ''}${body ? `: ${body}` : ''}`;
}

export function buildPrompt(ctx: PromptContext): BuiltPrompt {
  const { shot, scene, style, location, cast, props } = ctx;
  const sections: PromptSection[] = [];
  const add = (label: string, source: string, text: string): void => {
    if (clean(text)) sections.push({ label, source, text: clean(text) });
  };

  if (style)
    add('Style', `style:${style.name}`, joinParts([style.style_prompt, style.rendering, style.colors]));
  for (const m of cast) {
    add(
      m.variant ? `Character (${m.variant.name})` : 'Character',
      `character:${m.character.name}${m.character.locked ? ' [locked]' : ''}`,
      describeCharacter(m),
    );
  }
  if (location) {
    const loc = location.locked ? canonicalLocation(location) : location;
    add(
      'Location',
      `location:${location.name}${location.locked ? ' [locked]' : ''}`,
      joinParts([
        loc.prompt || loc.description,
        loc.environment,
        loc.architecture,
        loc.important_objects && `featuring ${loc.important_objects}`,
        loc.colors && `palette: ${loc.colors}`,
        loc.weather,
        scene.time_of_day || loc.time_of_day,
      ]),
    );
  }
  for (const p of props)
    add(
      'Prop',
      `prop:${p.name}`,
      joinParts([p.prompt || p.description, p.scale && `scale: ${p.scale}`, p.colors]),
    );
  add('Scene', `scene:${scene.title}`, scene.summary);
  add('Action', 'shot', shot.action);
  add('Emotion', 'shot', shot.emotion && `mood/emotion: ${shot.emotion}`);
  add(
    'Camera',
    'shot',
    joinParts([shot.framing, shot.camera_angle && `${shot.camera_angle} angle`, style?.camera]),
  );
  add(
    'Lighting',
    shot.lighting ? 'shot' : 'location/style',
    shot.lighting || location?.lighting || style?.lighting || '',
  );
  if (ctx.previousShot && ctx.previousShot.location_id === shot.location_id) {
    add(
      'Continuity',
      'previous shot',
      'consistent setting, lighting and character appearance with the previous shot',
    );
  }
  if (!shot.image_prompt_locked && clean(shot.image_prompt))
    add('Shot notes', 'shot (manual additions)', shot.image_prompt);

  const builtImage = sections.map((s) => s.text).join('. ');
  const builtMotion = joinParts(
    [
      shot.camera_movement ? `camera: ${shot.camera_movement}` : 'subtle camera movement',
      shot.action,
      shot.emotion && `expressing ${shot.emotion}`,
      !shot.motion_prompt_locked ? shot.motion_prompt : '',
      'smooth natural motion, stable character identity',
    ],
    '; ',
  );
  const builtNegative = mergeNegatives(
    style?.negative_prompt,
    ...cast.map((m) => canonicalCharacter(m.character).negative_prompt),
    ...cast.map((m) => m.variant?.negative_additions),
    location?.negative_prompt,
    ...props.map((p) => p.negative_prompt),
    !shot.negative_prompt_locked ? shot.negative_prompt : '',
  );

  const references: ReferenceInput[] = [
    ...cast.flatMap((m) =>
      m.references.map((r) => ({
        role: 'character' as const,
        storageKey: r.storage_key,
        label: `${m.character.name} ${r.slot}`,
      })),
    ),
    ...ctx.locationReferences.map((r) => ({
      role: 'location' as const,
      storageKey: r.storage_key,
      label: r.label,
    })),
  ];

  return {
    built: { image: builtImage, motion: builtMotion, negative: builtNegative },
    final: {
      image: shot.image_prompt_locked ? clean(shot.image_prompt) : builtImage,
      motion: shot.motion_prompt_locked ? clean(shot.motion_prompt) : builtMotion,
      negative: shot.negative_prompt_locked ? clean(shot.negative_prompt) : builtNegative,
    },
    manual: {
      image: shot.image_prompt_locked === 1,
      motion: shot.motion_prompt_locked === 1,
      negative: shot.negative_prompt_locked === 1,
    },
    sections,
    references,
  };
}

function canonicalLocation(l: Location): Location {
  const snap = parseJson<{ fields?: Record<string, unknown> } | undefined>(l.lock_snapshot_json, undefined);
  return snap?.fields ? ({ ...l, ...snap.fields } as Location) : l;
}
