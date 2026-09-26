import type { Project } from '../domain/types.ts';
import { EMOTIONS } from '../domain/enums.ts';
import {
  SCRIPT_REQUEST_MARKER,
  type ScriptRequest,
  type ScriptScene,
  type ScriptShot,
  type StoryScript,
} from '../domain/script.ts';
import { videoStyle } from '../domain/video-styles.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import type { RunContext, TextModel } from '../providers/types.ts';
import { STORY_PACKAGE_FORMAT } from './story-package.ts';

/**
 * Automatic story writing: idea → script (LLM on the AI worker) → Story Package.
 *
 * Short videos are written in one answer. Long ones (more than SINGLE_CALL_SHOTS shots) are written
 * as an outline first and then one scene at a time, so no answer has to be longer than the model
 * can reliably produce. Every answer is validated; an invalid one is sent back once with the list
 * of problems, then written again with a new seed. The result is never trusted blindly: the Story
 * Package import validates it again.
 */
export const SINGLE_CALL_SHOTS = 24;
export const SECONDS_PER_SHOT = 5.5;
const WORDS_PER_SECOND = 2.6;

const SYSTEM = `You are the head writer of an animation studio. You write short, warm, visual stories that
can be animated one shot at a time: every shot is ONE picture that is then gently animated, so each shot
describes one clear moment (who, where, doing what) and never a sequence of actions or a cut.
Rules: keep every spoken line short (at most 20 words). Characters keep the same names all the way through.
Use only the characters and locations you list. No violence, no scary content for young children, no brand
names, no real people. Write narration and dialogue in the requested language; for Hinglish mix Hindi and
English naturally, written in Latin letters. Describe visuals in English.`;

export function targetShots(targetSeconds: number): number {
  return Math.max(3, Math.min(200, Math.round(targetSeconds / SECONDS_PER_SHOT)));
}

function languageName(l: ScriptRequest['language']): string {
  return l === 'hi'
    ? 'Hindi (Devanagari script)'
    : l === 'hinglish'
      ? 'Hinglish (Hindi and English mixed, Latin letters)'
      : 'English';
}

const SHOT_SHAPE = `{"visual": "…", "characters": ["Name"], "camera": "wide shot|medium shot|close-up", "movement": "slow push-in|pan left|pan right|static|tilt up|pull out", "narration": "…", "dialogue": [{"character": "Name", "line": "…", "emotion": "happy"}], "sfx": ["footsteps"]}`;

export function fullPrompt(r: ScriptRequest): string {
  return `Write the complete script for this video.
Idea: ${r.idea}
Length: about ${Math.round(r.targetSeconds)} seconds, so exactly ${r.targetShots} shots in total, in ${Math.max(1, Math.round(r.targetShots / 4))} to ${Math.max(1, Math.round(r.targetShots / 2))} scenes.
Language for narration and dialogue: ${languageName(r.language)}.
Visual style: ${r.style}.
${r.knownCharacters.length ? `These characters already exist; use them with exactly these names and looks: ${r.knownCharacters.map((c) => `${c.name} (${c.description})`).join('; ')}.` : ''}
Return JSON of this shape:
{"title": "…", "logline": "one sentence", "moral": "…", "mood": "playful|calm|adventure|emotional|mysterious",
 "characters": [{"name": "…", "description": "what they look like: species, colours, clothes", "personality": "…", "voice": "female|male|child"}],
 "locations": [{"name": "…", "description": "what it looks like"}],
 "scenes": [{"title": "…", "location": "a location name", "mood": "…", "ambience": "forest|city|river|ocean|rain|night|indoor|space|village",
   "shots": [${SHOT_SHAPE}]}]}
${SCRIPT_REQUEST_MARKER} ${JSON.stringify(r)}`;
}

export function outlinePrompt(r: ScriptRequest, scenes: number): string {
  return `Plan a longer video as an outline (the shots are written later, scene by scene).
Idea: ${r.idea}
Length: about ${Math.round(r.targetSeconds)} seconds: ${scenes} scenes, ${r.targetShots} shots in total.
Language for narration and dialogue: ${languageName(r.language)}. Visual style: ${r.style}.
${r.knownCharacters.length ? `Existing characters (same names and looks): ${r.knownCharacters.map((c) => `${c.name} (${c.description})`).join('; ')}.` : ''}
Return JSON: {"title": "…", "logline": "…", "moral": "…", "mood": "…",
 "characters": [{"name": "…", "description": "…", "personality": "…", "voice": "female|male|child"}],
 "locations": [{"name": "…", "description": "…"}],
 "scenes": [{"title": "…", "location": "a location name", "mood": "…", "ambience": "…", "summary": "what happens", "shots": number}]}
${SCRIPT_REQUEST_MARKER} ${JSON.stringify(r)}`;
}

export function scenePrompt(r: ScriptRequest, outline: Outline, index: number): string {
  const sc = outline.scenes[index]!;
  return `Story: "${outline.title}" — ${outline.logline}
Characters: ${outline.characters.map((c) => `${c.name} (${c.description})`).join('; ')}.
Locations: ${outline.locations.map((l) => l.name).join(', ')}.
Scenes: ${outline.scenes.map((s, i) => `${i + 1}. ${s.title} — ${s.summary}`).join(' ')}
Write scene ${index + 1} ("${sc.title}", at ${sc.location}: ${sc.summary}) as exactly ${sc.shots} shots.
Language for narration and dialogue: ${languageName(r.language)}.
Return JSON: {"shots": [${SHOT_SHAPE}]}`;
}

export interface Outline extends Omit<StoryScript, 'scenes'> {
  scenes: Array<Omit<ScriptScene, 'shots'> & { summary: string; shots: number }>;
}

/** The first complete JSON object in an answer (models sometimes add words or code fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new AppError('STORY_GENERATION_FAILED', 'The answer contains no JSON object.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch (err) {
        throw new AppError('STORY_GENERATION_FAILED', `The JSON is not valid: ${(err as Error).message}`);
      }
    }
  }
  throw new AppError('STORY_GENERATION_FAILED', 'The JSON object is cut off (the answer was too long).');
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Checks and normalizes a script. Problems are written for the model to fix. */
export function checkScript(
  raw: unknown,
  r: ScriptRequest,
): { script: StoryScript | null; problems: string[] } {
  const problems: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const title = str(o['title'], 120);
  if (!title) problems.push('"title" is missing.');
  const characters = (Array.isArray(o['characters']) ? o['characters'] : [])
    .map((c) => c as Record<string, unknown>)
    .map((c) => ({
      name: str(c['name'], 60),
      description: str(c['description'], 600),
      personality: str(c['personality'], 300),
      voice: (['female', 'male', 'child'].includes(String(c['voice'])) ? c['voice'] : 'female') as
        | 'female'
        | 'male'
        | 'child',
    }))
    .filter((c) => c.name);
  if (!characters.length) problems.push('"characters" must list at least one character with a name.');
  for (const c of characters)
    if (!c.description) problems.push(`Character "${c.name}" needs a "description" of how they look.`);
  const names = new Map(characters.map((c) => [c.name.toLowerCase(), c.name]));
  const locations = (Array.isArray(o['locations']) ? o['locations'] : [])
    .map((l) => l as Record<string, unknown>)
    .map((l) => ({ name: str(l['name'], 80), description: str(l['description'], 600) }))
    .filter((l) => l.name);
  if (!locations.length) problems.push('"locations" must list at least one location.');
  const places = new Map(locations.map((l) => [l.name.toLowerCase(), l.name]));
  const scenesRaw = Array.isArray(o['scenes']) ? o['scenes'] : [];
  if (!scenesRaw.length) problems.push('"scenes" is empty.');
  const scenes: ScriptScene[] = scenesRaw.map((sr, i) => {
    const s = (sr ?? {}) as Record<string, unknown>;
    const loc = str(s['location'], 80);
    const known = places.get(loc.toLowerCase());
    if (!known) problems.push(`Scene ${i + 1}: location "${loc}" is not in "locations".`);
    const shots = checkShots(s['shots'], names, `Scene ${i + 1}`, problems);
    return {
      title: str(s['title'], 200) || `Scene ${i + 1}`,
      location: known ?? locations[0]?.name ?? '',
      mood: str(s['mood'], 60),
      ambience: str(s['ambience'], 40),
      shots,
    };
  });
  const total = scenes.reduce((n, s) => n + s.shots.length, 0);
  if (total && (total < r.targetShots * 0.6 || total > r.targetShots * 1.5))
    problems.push(`There are ${total} shots in total; write about ${r.targetShots}.`);
  if (problems.length) return { script: null, problems };
  return {
    script: {
      title,
      logline: str(o['logline'], 400),
      moral: str(o['moral'], 300),
      mood: str(o['mood'], 60) || 'playful',
      characters,
      locations,
      scenes,
    },
    problems,
  };
}

export function checkShots(
  raw: unknown,
  names: Map<string, string>,
  where: string,
  problems: string[],
): ScriptShot[] {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) problems.push(`${where}: "shots" is empty.`);
  return list.map((xr, j) => {
    const x = (xr ?? {}) as Record<string, unknown>;
    const here = `${where}, shot ${j + 1}`;
    const visual = str(x['visual'], 800);
    if (!visual) problems.push(`${here}: "visual" is missing.`);
    const cast = (Array.isArray(x['characters']) ? x['characters'] : [])
      .map((n) => str(n, 60))
      .filter(Boolean);
    for (const n of cast)
      if (!names.has(n.toLowerCase())) problems.push(`${here}: character "${n}" is not in "characters".`);
    const dialogue = (Array.isArray(x['dialogue']) ? x['dialogue'] : [])
      .map((d) => d as Record<string, unknown>)
      .map((d) => ({
        character: str(d['character'], 60),
        line: str(d['line'], 400),
        emotion: str(d['emotion'], 20),
      }))
      .filter((d) => d.line);
    for (const d of dialogue)
      if (!names.has(d.character.toLowerCase()))
        problems.push(`${here}: speaker "${d.character}" is not in "characters".`);
    const spoken = [str(x['narration'], 600), ...dialogue.map((d) => d.line)]
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    if (spoken > 45) problems.push(`${here}: too much speech (${spoken} words); keep it under 30.`);
    return {
      visual,
      characters: cast.map((n) => names.get(n.toLowerCase()) ?? n),
      camera: str(x['camera'], 60) || 'medium shot',
      movement: str(x['movement'], 60) || 'slow push-in',
      narration: str(x['narration'], 600) || undefined,
      dialogue: dialogue.map((d) => ({
        ...d,
        character: names.get(d.character.toLowerCase()) ?? d.character,
      })),
      sfx: (Array.isArray(x['sfx']) ? x['sfx'] : [])
        .map((t) => str(t, 40))
        .filter(Boolean)
        .slice(0, 3),
    };
  });
}

export interface WriteResult {
  script: StoryScript;
  model: string;
  isMock: boolean;
  calls: number;
  seconds: number;
}

/** Asks the model, checks the answer, and asks again (once with the problems, once fresh). */
async function ask<T>(
  model: TextModel,
  ctx: RunContext,
  prompt: string,
  maxTokens: number,
  seed: number,
  check: (raw: unknown) => { value: T | null; problems: string[] },
  stats: { calls: number; seconds: number; model: string; isMock: boolean },
): Promise<T> {
  let lastProblems: string[] = [];
  let lastText = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const repair =
      attempt === 2 && lastProblems.length
        ? `\n\nYour previous answer had these problems:\n- ${lastProblems.slice(0, 12).join('\n- ')}\nWrite the whole JSON again with them fixed.\nPrevious answer:\n${lastText.slice(0, 6000)}`
        : '';
    const res = await model.write(
      {
        system: SYSTEM,
        prompt: prompt + repair,
        maxTokens,
        temperature: attempt === 1 ? 0.8 : 0.6,
        seed: seed + attempt * 7919,
        json: true,
      },
      { ...ctx, attemptKey: `${ctx.attemptKey}:${attempt}` },
    );
    stats.calls++;
    stats.seconds += res.generationSeconds;
    stats.model = res.model;
    stats.isMock = res.isMock;
    lastText = res.text;
    try {
      const { value, problems } = check(extractJson(res.text));
      if (value) return value;
      lastProblems = problems;
    } catch (err) {
      lastProblems = [toAppError(err).message + (res.hitLimit ? ' Write fewer, shorter lines.' : '')];
    }
  }
  throw new AppError(
    'STORY_GENERATION_FAILED',
    `The story could not be written after 3 tries: ${lastProblems.slice(0, 4).join(' ')}`,
  );
}

export async function writeScript(
  model: TextModel,
  r: ScriptRequest,
  ctx: RunContext,
  seed: number,
): Promise<WriteResult> {
  const stats = { calls: 0, seconds: 0, model: model.info.id, isMock: model.info.isMock };
  let script: StoryScript;
  if (r.targetShots <= SINGLE_CALL_SHOTS) {
    script = await ask(
      model,
      ctx,
      fullPrompt(r),
      6000,
      seed,
      (raw) => {
        const c = checkScript(raw, r);
        return { value: c.script, problems: c.problems };
      },
      stats,
    );
  } else {
    const sceneCount = Math.max(3, Math.round(r.targetShots / 6));
    const outline = await ask(
      model,
      ctx,
      outlinePrompt(r, sceneCount),
      3000,
      seed,
      (raw) => checkOutline(raw, r),
      stats,
    );
    const names = new Map(outline.characters.map((c) => [c.name.toLowerCase(), c.name]));
    const scenes: ScriptScene[] = [];
    for (let i = 0; i < outline.scenes.length; i++) {
      const sc = outline.scenes[i]!;
      const shots = await ask(
        model,
        { ...ctx, attemptKey: `${ctx.attemptKey}:scene${i}` },
        scenePrompt(r, outline, i),
        3500,
        seed + i + 1,
        (raw) => {
          const problems: string[] = [];
          const list = checkShots(
            (raw as { shots?: unknown } | null)?.shots,
            names,
            `Scene ${i + 1}`,
            problems,
          );
          if (list.length && Math.abs(list.length - sc.shots) > Math.max(2, sc.shots * 0.4))
            problems.push(`Write ${sc.shots} shots (not ${list.length}).`);
          return { value: problems.length ? null : list, problems };
        },
        stats,
      );
      scenes.push({
        title: sc.title,
        location: sc.location,
        mood: sc.mood ?? '',
        ambience: sc.ambience ?? '',
        shots,
      });
    }
    script = { ...outline, scenes };
  }
  return { script, model: stats.model, isMock: stats.isMock, calls: stats.calls, seconds: stats.seconds };
}

function checkOutline(raw: unknown, r: ScriptRequest): { value: Outline | null; problems: string[] } {
  const o = (raw ?? {}) as Record<string, unknown>;
  // Reuse the script checks with one placeholder shot per scene, then read the planned shot counts.
  const scenes = (Array.isArray(o['scenes']) ? o['scenes'] : []) as Array<Record<string, unknown>>;
  const probe = { ...o, scenes: scenes.map((s) => ({ ...s, shots: [{ visual: 'x', characters: [] }] })) };
  const c = checkScript(probe, { ...r, targetShots: scenes.length || 1 });
  const problems = c.problems.filter((p) => !p.includes('shots in total'));
  let planned = 0;
  const outScenes = scenes.map((s, i) => {
    const n = Math.round(Number(s['shots']));
    if (!(n >= 1 && n <= 20)) problems.push(`Scene ${i + 1}: "shots" must be a number from 1 to 20.`);
    planned += n || 0;
    return {
      title: str(s['title'], 200) || `Scene ${i + 1}`,
      location: c.script?.scenes[i]?.location ?? str(s['location'], 80),
      mood: str(s['mood'], 60),
      ambience: str(s['ambience'], 40),
      summary: str(s['summary'], 600),
      shots: n || 1,
    };
  });
  if (planned && (planned < r.targetShots * 0.6 || planned > r.targetShots * 1.5))
    problems.push(`The scenes plan ${planned} shots; plan about ${r.targetShots}.`);
  if (problems.length || !c.script) return { value: null, problems };
  const { scenes: _s, ...rest } = c.script;
  return { value: { ...rest, scenes: outScenes }, problems };
}

// --- script → Story Package ---------------------------------------------------------------------

const EMOTION_SET = new Set<string>(EMOTIONS);
const key = (prefix: string, i: number) => `${prefix}${i + 1}`;
const slug = (name: string, i: number) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30) || 'c'
  }_${i}`;

export function speechSeconds(shot: ScriptShot): number {
  const words = [shot.narration ?? '', ...(shot.dialogue ?? []).map((d) => d.line)]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return words / WORDS_PER_SECOND + 0.6 * (shot.dialogue?.length ?? 0);
}

export function languageCode(l: ScriptRequest['language']): string {
  return l === 'hi' ? 'hi' : l === 'hinglish' ? 'hi-Latn' : 'en';
}

/**
 * Turn a checked script into a Story Package for the Simple Mode project. Characters that already
 * exist in the project (same name) are referenced by name only, so their approved pictures and
 * voice are reused unchanged.
 */
export function scriptToPackage(
  script: StoryScript,
  r: ScriptRequest,
  opts: {
    project: Project;
    existingCharacters: string[];
    styleId: string;
    narrator: 'female' | 'male';
    targetSeconds: number;
  },
): Record<string, unknown> {
  const lang = languageCode(r.language);
  const style = videoStyle(opts.styleId);
  const existing = new Set(opts.existingCharacters.map((n) => n.toLowerCase()));
  const charKey = new Map(script.characters.map((c, i) => [c.name, slug(c.name, i)]));
  const locKey = new Map(script.locations.map((l, i) => [l.name, key('loc', i)]));
  const presentation = (v: string) => (v === 'male' ? 'male' : v === 'female' ? 'female' : 'neutral');
  const emotion = (e: string | undefined) =>
    e && EMOTION_SET.has(e.toLowerCase()) ? e.toLowerCase() : 'neutral';
  return {
    format: STORY_PACKAGE_FORMAT,
    version: 1,
    styles: [
      {
        key: 'look',
        name: style.label,
        stylePrompt: style.prompt,
        negativePrompt: style.negative,
      },
    ],
    narrator: {
      name: 'Narrator',
      voiceModel: 'auto',
      language: lang,
      presentation: opts.narrator,
      narrationStyle: 'warm storyteller',
    },
    characters: script.characters.map((c) =>
      existing.has(c.name.toLowerCase())
        ? { key: charKey.get(c.name), name: c.name }
        : {
            key: charKey.get(c.name),
            name: c.name,
            personality: c.personality ?? '',
            appearance: c.description,
            prompt: c.description,
            voice: {
              name: `${c.name} voice`,
              voiceModel: 'auto',
              language: lang,
              presentation: presentation(c.voice),
              ...(c.voice === 'child' ? { pitch: 3, speed: 1.05 } : {}),
            },
          },
    ),
    locations: script.locations.map((l) => ({
      key: locKey.get(l.name),
      name: l.name,
      description: l.description,
      prompt: l.description,
    })),
    story: {
      title: script.title,
      synopsis: script.logline,
      moral: script.moral ?? '',
      language: lang,
      targetDurationSec: Math.round(opts.targetSeconds),
      productionNotes: `Written automatically from the idea: ${r.idea.slice(0, 400)}`,
    },
    scenes: script.scenes.map((sc, i) => ({
      key: key('sc', i),
      title: sc.title,
      location: locKey.get(sc.location),
      music: {
        mood: sc.mood || script.mood,
        energy: /adventure|excit|chase/i.test(sc.mood ?? '') ? 'high' : 'medium',
      },
      ambience: sc.ambience ?? '',
      shots: sc.shots.map((sh, j) => ({
        key: `${key('sc', i)}_${key('sh', j)}`,
        title: sh.visual.slice(0, 80),
        action: sh.visual,
        characters: sh.characters.filter((n) => charKey.has(n)).map((n) => ({ character: charKey.get(n) })),
        style: 'look',
        camera: { framing: sh.camera, angle: '', movement: sh.movement },
        motionPrompt: `${sh.movement}; ${sh.visual}`.slice(0, 900),
        durationSec: Math.round(Math.min(6, Math.max(3, speechSeconds(sh))) * 10) / 10,
        mouthVisible: false,
        dialogue: (sh.dialogue ?? [])
          .filter((d) => charKey.has(d.character))
          .map((d) => ({
            character: charKey.get(d.character),
            text: d.line,
            emotion: emotion(d.emotion),
            language: lang,
          })),
        narration: sh.narration ? [{ text: sh.narration, language: lang }] : [],
        sfx: (sh.sfx ?? []).map((tag) => ({
          tag:
            tag
              .toLowerCase()
              .replace(/[^a-z0-9 _-]/g, '')
              .slice(0, 60) || 'ambience',
          offsetSec: 0.3,
        })),
      })),
    })),
  };
}
