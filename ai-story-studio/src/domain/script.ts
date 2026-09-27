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

/** What the writer reports about a series episode (continuity memory, duplicate detection). */
export interface EpisodeNotes {
  premise: string;
  synopsis: string;
  lesson: string;
  features: {
    problem: string;
    setting: string;
    villain: string;
    science: string;
    resolution: string;
    lesson: string;
    setpiece: string;
  };
  /** Facts this episode adds to the series (proposed; canon only after approval). */
  canon: Array<{ kind: string; subject?: string; fact: string }>;
  /** Mysteries opened / resolved in this episode. */
  opened?: string[];
  resolved?: string[];
}

/** Compact, relevant series memory given to the writer (never the whole history). */
export interface SeriesBrief {
  series: string;
  premise: string;
  world: string;
  rules: string;
  tone: string;
  targetAge: string;
  season: { number: number; title: string; premise: string; mystery: string; arcs: string };
  episodeNumber: number;
  characters: Array<{ name: string; role: string; look: string; personality: string; speech: string }>;
  locations: Array<{ name: string; description: string }>;
  facts: Array<{ kind: string; subject: string; fact: string }>;
  recent: Array<{ number: number; title: string; synopsis: string }>;
  openMysteries: string[];
  /** Recently used problems, antagonists, settings and lessons: do not repeat them. */
  avoid: { problems: string[]; villains: string[]; settings: string[]; lessons: string[] };
}

export interface StoryScript {
  title: string;
  logline: string;
  moral?: string;
  mood: string;
  characters: ScriptCharacter[];
  locations: Array<{ name: string; description: string }>;
  scenes: ScriptScene[];
  /** Series episodes only. */
  episode?: EpisodeNotes;
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
  /** Series episodes: canon, season arc and recent history (the script is written in English). */
  series?: SeriesBrief;
}

/** Marks a season-planning request (the developer-test-mode writer recognises it). */
export const PLAN_MARKER = 'SEASON PLAN REQUEST (JSON):';

export const SCRIPT_REQUEST_MARKER = 'STORY REQUEST (JSON):';
