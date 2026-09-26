/**
 * The compact story script an LLM writes for "CREATE NEW VIDEO". It is deliberately small (an
 * LLM fills a small schema far more reliably than the full Story Package); the app then turns
 * it into a validated Story Package (src/services/story-writer.ts) with defaults for everything
 * technical: keys, voices, camera defaults, durations, prompts.
 */
export interface ScriptCharacter {
  name: string;
  /** What they look like (used for their pictures). */
  description: string;
  personality?: string;
  voice: 'female' | 'male' | 'child';
}

export interface ScriptShot {
  /** What we see: one clear moment, for one picture that is then animated. */
  visual: string;
  characters: string[];
  /** e.g. "wide shot", "medium shot", "close-up". */
  camera: string;
  /** e.g. "slow push-in", "pan left", "static". */
  movement: string;
  narration?: string;
  dialogue?: Array<{ character: string; line: string; emotion?: string }>;
  sfx?: string[];
}

export interface ScriptScene {
  title: string;
  location: string;
  mood?: string;
  ambience?: string;
  shots: ScriptShot[];
}

export interface StoryScript {
  title: string;
  logline: string;
  moral?: string;
  mood: string;
  characters: ScriptCharacter[];
  locations: Array<{ name: string; description: string }>;
  scenes: ScriptScene[];
}

/** What the writer asks for; also embedded in the prompt as JSON after SCRIPT_REQUEST_MARKER. */
export interface ScriptRequest {
  idea: string;
  targetSeconds: number;
  targetShots: number;
  language: 'en' | 'hi' | 'hinglish';
  style: string;
  /** Characters already in the library that the idea mentions (reused with the same look and voice). */
  knownCharacters: Array<{ name: string; description: string }>;
}

export const SCRIPT_REQUEST_MARKER = 'STORY REQUEST (JSON):';
