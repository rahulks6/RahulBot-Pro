import type { StudioCore } from '../app/studio.ts';
import type { FieldError } from '../lib/errors.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { sha256 } from '../lib/hash.ts';
import {
  array,
  boolean,
  enumOf,
  number,
  object,
  oneOfNumbers,
  optional,
  record,
  string,
  validate,
  type Infer,
} from '../lib/schema.ts';
import { ASPECT_RATIOS, EMOTIONS, FPS_VALUES, QUALITY_MODES, VOICE_PRESENTATIONS } from '../domain/enums.ts';

/**
 * Story Package (spec §9) — a documented JSON format (docs/STORY_PACKAGE.md)
 * that carries a whole episode: project, characters, locations, props,
 * style, scenes, shots, dialogue, narration, prompts, camera, music, SFX,
 * ambience and lip-sync requirements. Entities reference each other by
 * package-local `key`s. Import is validated first and then applied in ONE
 * transaction, so a failed import never leaves a half-imported project.
 */
export const STORY_PACKAGE_FORMAT = 'ai-story-studio/story-package';
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

const key = () =>
  string({
    min: 1,
    max: 64,
    pattern: /^[A-Za-z0-9_-]+$/,
    patternMessage: 'must use letters, digits, "-" or "_"',
  });
const txt = (max = 4000) => optional(string({ max }), '');
const lang = () =>
  optional(
    string({
      min: 2,
      max: 16,
      pattern: /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
      patternMessage: 'must be a language code',
    }),
    'en',
  );

const voiceSchema = object({
  name: optional(string({ max: 200 })),
  voiceModel: optional(string({ max: 120 }), 'mock-tts'),
  voiceIdentity: txt(200),
  language: lang(),
  presentation: optional(enumOf(VOICE_PRESENTATIONS), 'neutral'),
  pitch: optional(number({ min: -12, max: 12 }), 0),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  speakingStyle: txt(500),
  narrationStyle: txt(200),
  defaultEmotion: optional(enumOf(EMOTIONS), 'neutral'),
  settings: optional(record(), {}),
});

const styleSchema = object({
  key: key(),
  name: string({ min: 1, max: 200 }),
  stylePrompt: txt(),
  rendering: txt(1000),
  lighting: txt(1000),
  colors: txt(1000),
  camera: txt(1000),
  negativePrompt: txt(),
});

const variantSchema = object({
  key: key(),
  name: string({ min: 1, max: 200 }),
  description: txt(1000),
  clothingOverride: txt(1000),
  promptAdditions: txt(2000),
  negativeAdditions: txt(2000),
});

const characterSchema = object({
  key: key(),
  name: string({ min: 1, max: 200 }),
  species: txt(200),
  age: txt(100),
  role: txt(200),
  personality: txt(),
  appearance: txt(),
  face: txt(1000),
  hair: txt(1000),
  eyes: txt(500),
  body: txt(1000),
  proportions: txt(1000),
  clothing: txt(1000),
  accessories: txt(1000),
  colors: txt(500),
  prompt: txt(),
  negativePrompt: txt(),
  preferredSeeds: optional(array(number({ int: true, min: 0, max: 2 ** 32 - 1 }), { max: 20 }), []),
  voice: optional(voiceSchema),
  variants: optional(array(variantSchema, { max: 50 }), []),
});

const locationSchema = object({
  key: key(),
  name: string({ min: 1, max: 200 }),
  description: txt(),
  environment: txt(1000),
  architecture: txt(1000),
  importantObjects: txt(1000),
  colors: txt(500),
  lighting: txt(500),
  weather: txt(200),
  timeOfDay: txt(100),
  prompt: txt(),
  negativePrompt: txt(),
});

const propSchema = object({
  key: key(),
  name: string({ min: 1, max: 200 }),
  description: txt(),
  scale: txt(200),
  colors: txt(500),
  prompt: txt(),
  negativePrompt: txt(),
  characters: optional(array(key(), { max: 50 }), []),
});

const lineSchema = object({
  text: string({ min: 1, max: 5000 }),
  emotion: optional(enumOf(EMOTIONS), 'neutral'),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  language: optional(string({ min: 2, max: 16 })),
  required: optional(boolean(), true),
});

const dialogueSchema = object({
  character: key(),
  text: string({ min: 1, max: 2000 }),
  emotion: optional(enumOf(EMOTIONS), 'neutral'),
  delivery: txt(300),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  language: optional(string({ min: 2, max: 16 })),
  required: optional(boolean(), true),
});

const castSchema = object({ character: key(), variant: optional(key()) });

const shotSchema = object({
  key: key(),
  title: txt(300),
  action: txt(2000),
  emotion: txt(200),
  characters: optional(array(castSchema, { max: 20 }), []),
  props: optional(array(key(), { max: 20 }), []),
  location: optional(key()),
  style: optional(key()),
  camera: optional(object({ framing: txt(200), angle: txt(200), movement: txt(200) }), {
    framing: '',
    angle: '',
    movement: '',
  }),
  lighting: txt(500),
  imagePrompt: txt(),
  motionPrompt: txt(),
  negativePrompt: txt(),
  lockPrompts: optional(boolean(), false),
  durationSec: optional(number({ min: 0.5, max: 60 }), 5),
  fps: optional(oneOfNumbers(FPS_VALUES)),
  seed: optional(number({ int: true, min: 0, max: 2 ** 32 - 1 })),
  generationMode: optional(enumOf(QUALITY_MODES)),
  mouthVisible: optional(boolean(), false),
  lipSync: optional(boolean(), true),
  dialogue: optional(array(dialogueSchema, { max: 50 }), []),
  narration: optional(array(lineSchema, { max: 20 }), []),
  sfx: optional(
    array(
      object({
        tag: string({ min: 1, max: 60 }),
        offsetSec: optional(number({ min: 0, max: 60 }), 0),
        required: optional(boolean(), false),
      }),
      { max: 30 },
    ),
    [],
  ),
  musicNotes: txt(1000),
  ambienceNotes: txt(1000),
});

const sceneSchema = object({
  key: key(),
  title: string({ min: 1, max: 300 }),
  summary: txt(5000),
  location: optional(key()),
  timeOfDay: txt(100),
  music: optional(
    object({
      mood: txt(200),
      genre: txt(200),
      energy: optional(enumOf(['', 'low', 'medium', 'high'] as const), ''),
    }),
    { mood: '', genre: '', energy: '' as const },
  ),
  ambience: txt(500),
  narration: optional(array(lineSchema, { max: 50 }), []),
  shots: array(shotSchema, { min: 1, max: 200 }),
  notes: txt(),
});

export const storyPackageSchema = object({
  format: enumOf([STORY_PACKAGE_FORMAT] as const),
  version: enumOf(['1'] as const),
  project: optional(
    object({
      name: string({ min: 1, max: 200 }),
      series: txt(200),
      description: txt(),
      genre: txt(200),
      targetAudience: txt(200),
      aspectRatio: optional(enumOf(ASPECT_RATIOS), '16:9'),
      fps: optional(oneOfNumbers(FPS_VALUES), 24),
      defaultQuality: optional(enumOf(QUALITY_MODES), 'optimized'),
      defaultStyle: optional(string({ max: 200 })),
      productionNotes: txt(),
    }),
  ),
  styles: optional(array(styleSchema, { max: 20 }), []),
  narrator: optional(voiceSchema),
  characters: optional(array(characterSchema, { max: 100 }), []),
  locations: optional(array(locationSchema, { max: 100 }), []),
  props: optional(array(propSchema, { max: 200 }), []),
  story: object({
    title: string({ min: 1, max: 300 }),
    episodeNumber: optional(number({ int: true, min: 0, max: 100_000 })),
    synopsis: txt(5000),
    storyText: txt(100_000),
    moral: txt(1000),
    language: lang(),
    targetDurationSec: optional(number({ int: true, min: 5, max: 4 * 3600 }), 60),
    productionNotes: txt(),
  }),
  scenes: array(sceneSchema, { min: 1, max: 200 }),
});

export type StoryPackage = Infer<typeof storyPackageSchema>;

export interface PackageValidation {
  ok: boolean;
  errors: FieldError[];
  pkg?: StoryPackage;
}

/** Parse + validate (schema, then cross-references and uniqueness). Nothing is written. */
export function validateStoryPackage(input: string | unknown): PackageValidation {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_PACKAGE_BYTES) {
      return {
        ok: false,
        errors: [{ path: '', message: `Package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB` }],
      };
    }
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { ok: false, errors: [{ path: '', message: `Not valid JSON: ${(err as Error).message}` }] };
    }
  }
  // Versions are accepted as number or string in JSON.
  if (
    raw &&
    typeof raw === 'object' &&
    'version' in raw &&
    typeof (raw as { version: unknown }).version === 'number'
  ) {
    raw = { ...(raw as object), version: String((raw as { version: number }).version) };
  }
  const result = validate(storyPackageSchema, raw);
  if (!result.ok) return { ok: false, errors: result.errors };
  const pkg = result.value;
  const errors: FieldError[] = [];
  const unique = (items: Array<{ key: string }>, path: string): Set<string> => {
    const set = new Set<string>();
    items.forEach((it, i) => {
      if (set.has(it.key)) errors.push({ path: `${path}[${i}].key`, message: `duplicate key "${it.key}"` });
      set.add(it.key);
    });
    return set;
  };
  const styleKeys = unique(pkg.styles, 'styles');
  const charKeys = unique(pkg.characters, 'characters');
  const locKeys = unique(pkg.locations, 'locations');
  const propKeys = unique(pkg.props, 'props');
  const variantKeys = new Map(
    pkg.characters.map((c) => [c.key, new Set(c.variants.map((v) => v.key))] as const),
  );
  unique(pkg.scenes, 'scenes');
  const ref = (set: Set<string>, value: string | undefined, path: string, what: string): void => {
    if (value !== undefined && !set.has(value)) errors.push({ path, message: `unknown ${what} "${value}"` });
  };
  pkg.props.forEach((p, i) =>
    p.characters.forEach((c, j) => ref(charKeys, c, `props[${i}].characters[${j}]`, 'character')),
  );
  const shotKeys = new Set<string>();
  pkg.scenes.forEach((s, i) => {
    const sp = `scenes[${i}]`;
    ref(locKeys, s.location, `${sp}.location`, 'location');
    s.shots.forEach((sh, j) => {
      const p = `${sp}.shots[${j}]`;
      if (shotKeys.has(sh.key)) errors.push({ path: `${p}.key`, message: `duplicate shot key "${sh.key}"` });
      shotKeys.add(sh.key);
      ref(locKeys, sh.location, `${p}.location`, 'location');
      ref(styleKeys, sh.style, `${p}.style`, 'style');
      sh.props.forEach((k, n) => ref(propKeys, k, `${p}.props[${n}]`, 'prop'));
      sh.characters.forEach((c, n) => {
        ref(charKeys, c.character, `${p}.characters[${n}].character`, 'character');
        if (c.variant && !variantKeys.get(c.character)?.has(c.variant)) {
          errors.push({
            path: `${p}.characters[${n}].variant`,
            message: `unknown variant "${c.variant}" for character "${c.character}"`,
          });
        }
      });
      sh.dialogue.forEach((d, n) => {
        ref(charKeys, d.character, `${p}.dialogue[${n}].character`, 'character');
        if (!sh.characters.some((c) => c.character === d.character) && charKeys.has(d.character)) {
          // Off-screen speakers are allowed, but lip sync can only apply to visible characters.
          if (sh.mouthVisible)
            errors.push({
              path: `${p}.dialogue[${n}].character`,
              message: `"${d.character}" speaks with mouthVisible=true but is not in the shot's characters`,
            });
        }
      });
    });
  });
  // A narrator and a default style may instead come from the target project; that is checked at import.
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], pkg };
}

export interface ImportSummary {
  projectId: string;
  storyId: string;
  created: Record<string, number>;
  reused: string[];
  warnings: string[];
}

/**
 * Import a validated package into a new project (package.project required)
 * or into an existing project. Existing characters/locations/props with the
 * same name are reused as-is — locked assets are never modified.
 */
export function importStoryPackage(
  s: StudioCore,
  input: string | unknown,
  target: { projectId?: string } = {},
): ImportSummary {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const hash = sha256(text);
  const v = validateStoryPackage(input);
  if (!v.ok || !v.pkg) {
    s.reports.recordImport({
      project_id: target.projectId ?? null,
      story_id: null,
      status: 'failed',
      package_hash: hash,
      errors_json: JSON.stringify(v.errors),
      summary_json: '{}',
    });
    throw new AppError('VALIDATION_FAILED', 'Story Package is invalid', v.errors);
  }
  const pkg = v.pkg;
  try {
    const summary = s.db.transaction(() => apply(s, pkg, target));
    s.reports.recordImport({
      project_id: summary.projectId,
      story_id: summary.storyId,
      status: 'imported',
      package_hash: hash,
      errors_json: '[]',
      summary_json: JSON.stringify(summary),
    });
    s.logger.info('story package imported', {
      project: summary.projectId,
      story: summary.storyId,
      created: summary.created,
    });
    return summary;
  } catch (err) {
    const e = toAppError(err);
    const errors = e.details.length ? e.details : [{ path: '', message: e.message }];
    s.reports.recordImport({
      project_id: target.projectId ?? null,
      story_id: null,
      status: 'failed',
      package_hash: hash,
      errors_json: JSON.stringify(errors),
      summary_json: '{}',
    });
    throw new AppError(
      e.code === 'INTERNAL' ? 'VALIDATION_FAILED' : e.code,
      `Import failed and was rolled back: ${e.message}`,
      errors,
    );
  }
}

function apply(s: StudioCore, pkg: StoryPackage, target: { projectId?: string }): ImportSummary {
  const created: Record<string, number> = {};
  const bump = (k: string): void => {
    created[k] = (created[k] ?? 0) + 1;
  };
  const reused: string[] = [];
  const warnings: string[] = [];

  let projectId = target.projectId;
  if (projectId) {
    s.projects.get(projectId);
  } else {
    if (!pkg.project)
      throw new AppError(
        'VALIDATION_FAILED',
        'Package has no "project" block; choose an existing project to import into.',
        [{ path: 'project', message: 'is required when creating a new project' }],
      );
    const p = s.projects.create({
      name: pkg.project.name,
      series: pkg.project.series,
      description: pkg.project.description,
      genre: pkg.project.genre,
      target_audience: pkg.project.targetAudience,
      aspect_ratio: pkg.project.aspectRatio,
      fps: pkg.project.fps,
      default_quality: pkg.project.defaultQuality,
      production_notes: pkg.project.productionNotes,
    });
    projectId = p.id;
    bump('projects');
  }
  const pid = projectId;

  const styleIds = new Map<string, string>();
  for (const st of pkg.styles) {
    const existing = s.projects.listStyles(pid).find((x) => x.name.toLowerCase() === st.name.toLowerCase());
    if (existing) {
      styleIds.set(st.key, existing.id);
      reused.push(`style "${st.name}"`);
      continue;
    }
    const row = s.projects.createStyle(
      {
        name: st.name,
        style_prompt: st.stylePrompt,
        rendering: st.rendering,
        lighting: st.lighting,
        colors: st.colors,
        camera: st.camera,
        negative_prompt: st.negativePrompt,
      },
      pid,
    );
    styleIds.set(st.key, row.id);
    bump('styles');
  }
  if (pkg.project?.defaultStyle) {
    const ds = pkg.project.defaultStyle;
    const styleId =
      styleIds.get(ds) ??
      s.projects.listStyles(pid).find((x) => x.name.toLowerCase() === ds.toLowerCase())?.id;
    if (styleId) s.projects.update(pid, { default_style_id: styleId });
    else warnings.push(`Default style "${ds}" not found; project keeps its current style.`);
  }

  const voiceInput = (
    v: NonNullable<StoryPackage['narrator']>,
    name: string,
    role: 'character' | 'narrator',
  ) => ({
    name: v.name ?? name,
    role,
    voice_model: v.voiceModel,
    voice_identity: v.voiceIdentity,
    language: v.language,
    presentation: v.presentation,
    pitch: v.pitch,
    speed: v.speed,
    speaking_style: v.speakingStyle,
    narration_style: v.narrationStyle,
    default_emotion: v.defaultEmotion,
    settings: v.settings,
  });

  const project = s.projects.get(pid);
  if (pkg.narrator) {
    if (project.narrator_voice_id) {
      reused.push('existing project narrator (package narrator ignored to keep the voice consistent)');
    } else {
      const narrator = s.characters.createVoice(pid, voiceInput(pkg.narrator, 'Narrator', 'narrator'));
      s.projects.update(pid, { narrator_voice_id: narrator.id });
      bump('voices');
    }
  }

  const charIds = new Map<string, string>();
  const variantIds = new Map<string, string>();
  for (const c of pkg.characters) {
    const existing = s.characters.findByName(pid, c.name);
    let id: string;
    if (existing) {
      id = existing.id;
      reused.push(`character "${c.name}"${existing.locked ? ' (locked)' : ''}`);
    } else {
      let voiceId: string | undefined;
      if (c.voice) {
        voiceId = s.characters.createVoice(pid, voiceInput(c.voice, `${c.name} voice`, 'character')).id;
        bump('voices');
      }
      id = s.characters.create(pid, {
        name: c.name,
        species: c.species,
        age: c.age,
        role: c.role,
        personality: c.personality,
        appearance: c.appearance,
        face: c.face,
        hair: c.hair,
        eyes: c.eyes,
        body: c.body,
        proportions: c.proportions,
        clothing: c.clothing,
        accessories: c.accessories,
        colors: c.colors,
        prompt: c.prompt,
        negative_prompt: c.negativePrompt,
        voice_profile_id: voiceId,
        preferred_seeds: c.preferredSeeds,
      }).id;
      bump('characters');
    }
    charIds.set(c.key, id);
    const existingVariants = s.characters.listVariants(id);
    for (const vr of c.variants) {
      const ev = existingVariants.find((x) => x.name.toLowerCase() === vr.name.toLowerCase());
      if (ev) {
        variantIds.set(`${c.key}/${vr.key}`, ev.id);
        continue;
      }
      const row = s.characters.createVariant(id, {
        name: vr.name,
        description: vr.description,
        clothing_override: vr.clothingOverride,
        prompt_additions: vr.promptAdditions,
        negative_additions: vr.negativeAdditions,
      });
      variantIds.set(`${c.key}/${vr.key}`, row.id);
      bump('variants');
    }
  }

  const locIds = new Map<string, string>();
  for (const l of pkg.locations) {
    const existing = s.characters
      .listLocations(pid)
      .find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    if (existing) {
      locIds.set(l.key, existing.id);
      reused.push(`location "${l.name}"${existing.locked ? ' (locked)' : ''}`);
      continue;
    }
    const row = s.characters.createLocation(pid, {
      name: l.name,
      description: l.description,
      environment: l.environment,
      architecture: l.architecture,
      important_objects: l.importantObjects,
      colors: l.colors,
      lighting: l.lighting,
      weather: l.weather,
      time_of_day: l.timeOfDay,
      prompt: l.prompt,
      negative_prompt: l.negativePrompt,
    });
    locIds.set(l.key, row.id);
    bump('locations');
  }

  const propIds = new Map<string, string>();
  for (const p of pkg.props) {
    const existing = s.characters.listProps(pid).find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (existing) {
      propIds.set(p.key, existing.id);
      reused.push(`prop "${p.name}"`);
      continue;
    }
    const row = s.characters.createProp(
      pid,
      {
        name: p.name,
        description: p.description,
        scale: p.scale,
        colors: p.colors,
        prompt: p.prompt,
        negative_prompt: p.negativePrompt,
      },
      p.characters.map((k) => charIds.get(k)!),
    );
    propIds.set(p.key, row.id);
    bump('props');
  }

  const story = s.stories.create(pid, {
    title: pkg.story.title,
    episode_number: pkg.story.episodeNumber,
    synopsis: pkg.story.synopsis,
    story_text: pkg.story.storyText,
    moral: pkg.story.moral,
    language: pkg.story.language,
    target_duration_sec: pkg.story.targetDurationSec,
    production_notes: pkg.story.productionNotes,
  });
  bump('stories');
  const language = pkg.story.language;

  for (const sc of pkg.scenes) {
    const scene = s.stories.createScene(story.id, {
      title: sc.title,
      summary: sc.summary,
      location_id: sc.location ? locIds.get(sc.location) : undefined,
      time_of_day: sc.timeOfDay,
      music_mood: sc.music.mood,
      music_genre: sc.music.genre,
      music_energy: sc.music.energy,
      ambience: sc.ambience,
      notes: sc.notes,
    });
    bump('scenes');
    for (const n of sc.narration) {
      s.stories.addNarration(scene.id, {
        text: n.text,
        emotion: n.emotion,
        speed: n.speed,
        language: n.language ?? language,
        required: n.required,
      });
      bump('narration');
    }
    for (const sh of sc.shots) {
      const shot = s.stories.createShot(scene.id, {
        title: sh.title,
        action: sh.action,
        emotion: sh.emotion,
        framing: sh.camera.framing,
        camera_angle: sh.camera.angle,
        camera_movement: sh.camera.movement,
        lighting: sh.lighting,
        location_id: sh.location ? locIds.get(sh.location) : undefined,
        style_id: sh.style ? styleIds.get(sh.style) : undefined,
        image_prompt: sh.imagePrompt,
        image_prompt_locked: sh.lockPrompts && sh.imagePrompt.length > 0,
        motion_prompt: sh.motionPrompt,
        motion_prompt_locked: sh.lockPrompts && sh.motionPrompt.length > 0,
        negative_prompt: sh.negativePrompt,
        negative_prompt_locked: sh.lockPrompts && sh.negativePrompt.length > 0,
        duration_sec: sh.durationSec,
        fps: sh.fps ?? project.fps,
        seed: sh.seed,
        generation_mode: sh.generationMode ?? project.default_quality,
        mouth_visible: sh.mouthVisible,
        lipsync_enabled: sh.lipSync,
        music_notes: sh.musicNotes,
        ambience_notes: sh.ambienceNotes,
      });
      bump('shots');
      s.stories.setShotCharacters(
        shot.id,
        sh.characters.map((c) => ({
          character_id: charIds.get(c.character)!,
          variant_id: c.variant ? variantIds.get(`${c.character}/${c.variant}`) : null,
        })),
      );
      s.stories.setShotProps(
        shot.id,
        sh.props.map((k) => propIds.get(k)!),
      );
      for (const d of sh.dialogue) {
        s.stories.addDialogue(shot.id, {
          character_id: charIds.get(d.character),
          text: d.text,
          emotion: d.emotion,
          delivery: d.delivery,
          speed: d.speed,
          language: d.language ?? language,
          required: d.required,
        });
        bump('dialogue');
      }
      for (const n of sh.narration) {
        s.stories.addNarration(scene.id, {
          shot_id: shot.id,
          text: n.text,
          emotion: n.emotion,
          speed: n.speed,
          language: n.language ?? language,
          required: n.required,
        });
        bump('narration');
      }
      for (const fx of sh.sfx) {
        s.stories.addShotSfx(shot.id, fx.tag, {
          offsetSec: fx.offsetSec,
          required: fx.required,
          source: 'package',
        });
        bump('sfx');
      }
    }
  }
  const hasNarration = pkg.scenes.some(
    (sc) => sc.narration.length > 0 || sc.shots.some((sh) => sh.narration.length > 0),
  );
  if (hasNarration && !s.projects.get(pid).narrator_voice_id) {
    warnings.push('The story has narration but the project has no narrator voice yet.');
  }
  return { projectId: pid, storyId: story.id, created, reused, warnings };
}
