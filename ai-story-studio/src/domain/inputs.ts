// Validated input shapes for creating/updating entities. Shared by the web
// forms, Story Package import and project backup import.
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
  type Infer,
} from '../lib/schema.ts';
import {
  ASPECT_RATIOS,
  EMOTIONS,
  FPS_VALUES,
  QUALITY_MODES,
  REFERENCE_SLOT_TYPES,
  STORY_STATUSES,
  TRANSITIONS,
  VOICE_PRESENTATIONS,
} from './enums.ts';

const text = (max = 4000) => optional(string({ max }), '');
const name = () => string({ min: 1, max: 200 });
const idRef = () =>
  optional(string({ max: 64, pattern: /^[a-z]+_[a-z0-9]+$/, patternMessage: 'must be an id' }));
const language = () =>
  optional(
    string({
      min: 2,
      max: 16,
      pattern: /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
      patternMessage: 'must be a language code like "en" or "hi-IN"',
    }),
    'en',
  );

export const projectInput = object({
  name: name(),
  series: text(200),
  description: text(),
  genre: text(200),
  target_audience: text(200),
  default_style_id: idRef(),
  aspect_ratio: optional(enumOf(ASPECT_RATIOS), '16:9'),
  fps: optional(oneOfNumbers(FPS_VALUES), 24),
  default_quality: optional(enumOf(QUALITY_MODES), 'optimized'),
  narrator_voice_id: idRef(),
  production_notes: text(),
});
export type ProjectInput = Infer<typeof projectInput>;

export const styleInput = object({
  name: name(),
  style_prompt: text(),
  rendering: text(1000),
  lighting: text(1000),
  colors: text(1000),
  camera: text(1000),
  negative_prompt: text(),
});
export type StyleInput = Infer<typeof styleInput>;

export const voiceInput = object({
  name: name(),
  role: optional(enumOf(['character', 'narrator'] as const), 'character'),
  voice_model: optional(string({ min: 1, max: 120 }), 'mock-tts'),
  voice_identity: text(200),
  language: language(),
  presentation: optional(enumOf(VOICE_PRESENTATIONS), 'neutral'),
  pitch: optional(number({ min: -12, max: 12 }), 0),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  speaking_style: text(500),
  narration_style: text(200),
  default_emotion: optional(enumOf(EMOTIONS), 'neutral'),
  settings: optional(record(), {}),
});
export type VoiceInput = Infer<typeof voiceInput>;

export const characterInput = object({
  name: name(),
  species: text(200),
  age: text(100),
  role: text(200),
  personality: text(),
  appearance: text(),
  face: text(1000),
  hair: text(1000),
  eyes: text(500),
  body: text(1000),
  proportions: text(1000),
  clothing: text(1000),
  accessories: text(1000),
  colors: text(500),
  prompt: text(),
  negative_prompt: text(),
  voice_profile_id: idRef(),
  preferred_seeds: optional(array(number({ int: true, min: 0, max: 2 ** 32 - 1 }), { max: 20 }), []),
  generation_settings: optional(record(), {}),
});
export type CharacterInput = Infer<typeof characterInput>;

export const variantInput = object({
  name: name(),
  description: text(1000),
  clothing_override: text(1000),
  prompt_additions: text(2000),
  negative_additions: text(2000),
});
export type VariantInput = Infer<typeof variantInput>;

export const referenceSlotInput = object({
  slot_type: enumOf(REFERENCE_SLOT_TYPES),
  slot: string({ min: 1, max: 60 }),
  variant_id: idRef(),
});

export const locationInput = object({
  name: name(),
  description: text(),
  environment: text(1000),
  architecture: text(1000),
  important_objects: text(1000),
  colors: text(500),
  lighting: text(500),
  weather: text(200),
  time_of_day: text(100),
  prompt: text(),
  negative_prompt: text(),
});
export type LocationInput = Infer<typeof locationInput>;

export const propInput = object({
  name: name(),
  description: text(),
  scale: text(200),
  colors: text(500),
  prompt: text(),
  negative_prompt: text(),
});
export type PropInput = Infer<typeof propInput>;

export const storyInput = object({
  title: string({ min: 1, max: 300 }),
  episode_number: optional(number({ int: true, min: 0, max: 100_000 })),
  synopsis: text(5000),
  story_text: text(100_000),
  moral: text(1000),
  language: language(),
  target_duration_sec: optional(number({ int: true, min: 5, max: 4 * 3600 }), 60),
  status: optional(enumOf(STORY_STATUSES), 'draft'),
  production_notes: text(),
});
export type StoryInput = Infer<typeof storyInput>;

export const sceneInput = object({
  title: string({ min: 1, max: 300 }),
  summary: text(5000),
  location_id: idRef(),
  time_of_day: text(100),
  music_mood: text(200),
  music_genre: text(200),
  music_energy: optional(enumOf(['', 'low', 'medium', 'high'] as const), ''),
  ambience: text(500),
  notes: text(),
});
export type SceneInput = Infer<typeof sceneInput>;

export const shotInput = object({
  title: text(300),
  action: text(2000),
  emotion: text(200),
  framing: text(200),
  camera_angle: text(200),
  camera_movement: text(200),
  lighting: text(500),
  location_id: idRef(),
  style_id: idRef(),
  image_prompt: text(),
  image_prompt_locked: optional(boolean(), false),
  motion_prompt: text(),
  motion_prompt_locked: optional(boolean(), false),
  negative_prompt: text(),
  negative_prompt_locked: optional(boolean(), false),
  duration_sec: optional(number({ min: 0.5, max: 60 }), 5),
  fps: optional(oneOfNumbers(FPS_VALUES), 24),
  seed: optional(number({ int: true, min: 0, max: 2 ** 32 - 1 })),
  generation_mode: optional(enumOf(QUALITY_MODES), 'optimized'),
  mouth_visible: optional(boolean(), false),
  lipsync_enabled: optional(boolean(), true),
  music_notes: text(1000),
  ambience_notes: text(1000),
});
export type ShotInput = Infer<typeof shotInput>;

export const dialogueInput = object({
  character_id: idRef(),
  text: string({ min: 1, max: 2000 }),
  emotion: optional(enumOf(EMOTIONS), 'neutral'),
  delivery: text(300),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  language: language(),
  required: optional(boolean(), true),
});
export type DialogueInput = Infer<typeof dialogueInput>;

export const narrationInput = object({
  shot_id: idRef(),
  text: string({ min: 1, max: 5000 }),
  emotion: optional(enumOf(EMOTIONS), 'neutral'),
  speed: optional(number({ min: 0.5, max: 2 }), 1),
  language: language(),
  required: optional(boolean(), true),
});
export type NarrationInput = Infer<typeof narrationInput>;

export const timelineItemPatch = object({
  start_sec: optional(number({ min: 0, max: 6 * 3600 })),
  duration_sec: optional(number({ min: 0.05, max: 6 * 3600 })),
  trim_in_sec: optional(number({ min: 0, max: 3600 })),
  volume_db: optional(number({ min: -60, max: 12 })),
  fade_in_sec: optional(number({ min: 0, max: 30 })),
  fade_out_sec: optional(number({ min: 0, max: 30 })),
  transition: optional(enumOf(TRANSITIONS)),
  label: optional(string({ max: 300 })),
});
export type TimelineItemPatch = Infer<typeof timelineItemPatch>;
