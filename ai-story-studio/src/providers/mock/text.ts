import { prng, seedFrom } from '../../lib/hash.ts';
import { LOCALIZE_MARKER } from '../../services/hinglish.ts';
import {
  PLAN_MARKER,
  SCRIPT_REQUEST_MARKER,
  type ScriptRequest,
  type StoryScript,
} from '../../domain/script.ts';
import type { RunContext, TextModel, TextRequest, TextResult } from '../types.ts';
import { ProviderError } from '../types.ts';
import { maybeFail, mockInfo, type MockOptions } from './common.ts';

/**
 * Developer test mode only: a deterministic, clearly labelled placeholder script built from the
 * request (no language model). It exists so the automated tests can run the whole production
 * without a GPU; Simple Mode never offers it as a way to make videos.
 */
export class MockTextModel implements TextModel {
  readonly info = mockInfo('mock-text', 'Mock story writer (placeholder)', 'local_cpu');
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async write(req: TextRequest, ctx: RunContext): Promise<TextResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'STORY_GENERATION_FAILED');
    const answer = (text: string): TextResult => ({
      text,
      model: this.info.id,
      modelVersion: 'mock-1',
      isMock: true,
      generationSeconds: 0.1,
      hitLimit: false,
    });
    // Long videos: one scene at a time ("Write scene N (…) as exactly K shots.").
    const scene = /Write scene \d+ .* as exactly (\d+) shots/.exec(req.prompt);
    if (scene) {
      const cast = /Characters: ([^(]+) \(/.exec(req.prompt)?.[1]?.trim() ?? 'Milo';
      const script = mockScript(
        {
          idea: 'scene',
          targetSeconds: 0,
          targetShots: Number(scene[1]),
          language: 'en',
          style: '',
          knownCharacters: [{ name: cast, description: 'x' }],
        },
        req.seed,
      );
      return answer(
        JSON.stringify({
          shots: script.scenes
            .flatMap((x) => x.shots)
            .slice(0, Number(scene[1]))
            .map((sh) => ({ ...sh, characters: [cast], dialogue: [] })),
        }),
      );
    }
    // Season planning: labelled placeholder ideas, varied by episode number.
    const plan = req.prompt.indexOf(PLAN_MARKER);
    if (plan >= 0) {
      const body = JSON.parse(
        req.prompt
          .slice(plan + PLAN_MARKER.length)
          .split('\n')[0]!
          .trim(),
      ) as { count: number; from: number };
      return answer(JSON.stringify({ episodes: mockPlan(body.count, body.from) }));
    }
    // Language versions: a labelled placeholder Hinglish made by word substitution (no language model).
    const loc = req.prompt.indexOf(LOCALIZE_MARKER);
    if (loc >= 0) {
      const body = JSON.parse(
        req.prompt
          .slice(loc + LOCALIZE_MARKER.length)
          .split('\n')[0]!
          .trim(),
      ) as {
        lines: Array<{ id: string; english: string }>;
        shorter?: boolean;
      };
      return answer(
        JSON.stringify({
          lines: body.lines.map((l) => ({
            id: l.id,
            hinglish: mockHinglish(l.english, !!body.shorter),
            speech: '',
          })),
        }),
      );
    }
    const at = req.prompt.indexOf(SCRIPT_REQUEST_MARKER);
    if (at < 0)
      throw new ProviderError('STORY_GENERATION_FAILED', 'The mock writer only answers story requests.');
    const request = JSON.parse(
      req.prompt
        .slice(at + SCRIPT_REQUEST_MARKER.length)
        .split('\n')[0]!
        .trim(),
    ) as ScriptRequest;
    const script = mockScript(request, req.seed);
    if (req.prompt.startsWith('Plan a longer video as an outline')) {
      const scenes = Math.max(3, Math.round(request.targetShots / 6));
      const per = Math.round(request.targetShots / scenes);
      return answer(
        JSON.stringify({
          ...script,
          scenes: Array.from({ length: scenes }, (_, i) => ({
            title: `Part ${i + 1}`,
            location: script.locations[i % script.locations.length]!.name,
            mood: 'playful',
            ambience: 'forest',
            summary: `Part ${i + 1} of the placeholder story.`,
            shots: per,
          })),
        }),
      );
    }
    return answer(JSON.stringify(script));
  }
}

const HINGLISH_SWAP: Record<string, string> = {
  we: 'hum',
  you: 'tum',
  is: 'hai',
  are: 'hain',
  not: 'nahi',
  what: 'kya',
  look: 'dekho',
  come: 'aao',
  go: 'jao',
  here: 'yahan',
  there: 'wahan',
  now: 'abhi',
  quickly: 'jaldi',
  friend: 'dost',
  very: 'bahut',
  and: 'aur',
  but: 'lekin',
  yes: 'haan',
  no: 'nahi',
  "let's": 'chalo',
  together: 'saath',
  keep: 'chalte',
  going: 'raho',
  the: '',
  a: '',
};

/** Developer test mode only: Hinglish-looking text by word substitution (keeps names and numbers). */
export function mockHinglish(english: string, shorter: boolean): string {
  const words = english.split(/\s+/).filter(Boolean);
  const out = words
    .map((w) => {
      const m = /^([A-Za-z']+)(.*)$/.exec(w);
      if (!m) return w;
      const swap = HINGLISH_SWAP[m[1]!.toLowerCase()];
      return swap === undefined ? w : swap ? swap + m[2] : m[2]!;
    })
    .filter(Boolean);
  let text = out.join(' ').trim();
  if (!/\b(hai|hain|hum|tum|kya|chalo|dekho|nahi|aur|abhi|jaldi)\b/i.test(text))
    text = `${text.replace(/[.!?]+$/, '')} hai na!`;
  if (shorter)
    text = text
      .split(/\s+/)
      .slice(0, Math.max(3, Math.ceil(text.split(/\s+/).length * 0.7)))
      .join(' ');
  return text;
}

export function mockScript(r: ScriptRequest, seed: number): StoryScript {
  const rnd = prng(seedFrom(`${seed}:${r.idea}`));
  const hero = r.knownCharacters[0] ?? {
    name: 'Milo',
    description: 'a small orange fox cub with a green scarf and big friendly eyes',
  };
  const friend = { name: 'Nia', description: 'a clever little owl with round glasses and a blue satchel' };
  const places = [
    { name: 'Sunny Forest', description: 'a bright forest clearing with tall trees and wildflowers' },
    { name: 'River Bend', description: 'a sparkling river with smooth stones and a wooden bridge' },
  ];
  const scenesN = Math.max(1, Math.round(r.targetShots / 3));
  const shotsPer = Math.max(1, Math.round(r.targetShots / scenesN));
  const cameras = ['wide shot', 'medium shot', 'close-up'];
  const moves = ['slow push-in', 'pan right', 'static', 'gentle tilt up'];
  const topic = r.idea.replace(/\s+/g, ' ').trim().slice(0, 80);
  const lesson = 'Friends help each other.';
  const episode = r.series
    ? {
        premise: `Placeholder episode: ${topic}`,
        synopsis: `${hero.name} and ${friend.name} deal with this: ${topic}. They work it out together.`,
        lesson,
        features: {
          problem: topic,
          setting: places[0]!.name,
          villain: 'none',
          science: topic,
          resolution: `${hero.name} and ${friend.name} solve it: ${topic}`,
          lesson,
          setpiece: topic,
        },
        canon: [
          { kind: 'event', subject: hero.name, fact: `${hero.name} and ${friend.name} solved: ${topic}` },
        ],
        opened: [],
        resolved: [],
      }
    : undefined;
  return {
    ...(episode ? { episode } : {}),
    title: `MOCK: ${topic.split(' ').slice(0, 6).join(' ')}`,
    logline: `Placeholder script (developer test mode) for: ${topic}`,
    moral: 'Friends help each other.',
    mood: 'playful',
    characters: [
      { name: hero.name, description: hero.description, personality: 'curious and kind', voice: 'child' },
      { name: friend.name, description: friend.description, personality: 'wise and calm', voice: 'female' },
    ],
    locations: places,
    scenes: Array.from({ length: scenesN }, (_, i) => ({
      title: `Part ${i + 1}`,
      location: places[i % places.length]!.name,
      mood: i === scenesN - 1 ? 'calm' : 'playful',
      ambience: i % 2 ? 'river' : 'forest',
      shots: Array.from({ length: shotsPer }, (_, j) => ({
        visual: `${hero.name} ${['looks around', 'walks along the path', 'smiles at ' + friend.name, 'points ahead'][j % 4]} (${topic})`,
        characters: j % 2 ? [hero.name, friend.name] : [hero.name],
        camera: cameras[Math.floor(rnd() * cameras.length)]!,
        movement: moves[Math.floor(rnd() * moves.length)]!,
        narration: j === 0 ? `Part ${i + 1} of the story begins.` : undefined,
        dialogue:
          j % 2
            ? [{ character: friend.name, line: `Let's keep going, ${hero.name}!`, emotion: 'happy' }]
            : [],
        sfx: j === 1 ? ['footsteps'] : [],
      })),
    })),
  };
}

const PLAN_THEMES: Array<[string, string, string, string, string]> = [
  ['glowing garden leaves', 'the station greenhouse', 'photosynthesis', 'patience', 'the leaves glow'],
  [
    'a sky-tram that stops at every red balloon',
    'the sky-tram line',
    'magnets',
    'asking questions',
    'trams stop',
  ],
  [
    'echoes that answer back in the crater',
    'the moon crater',
    'sound waves',
    'listening first',
    'echoes answer',
  ],
  [
    'a robot that sneezes snowflakes',
    'the robot workshop',
    'freezing and melting',
    'caring for friends',
    'robot sneezes',
  ],
  [
    'shadows pointing the wrong way',
    'the city park',
    'light and shadows',
    'checking your facts',
    'shadows turn',
  ],
  [
    'a portal that only opens for music',
    'the portal chamber',
    'vibration and pitch',
    'teamwork',
    'music portal',
  ],
  [
    'rain that falls upwards in one street',
    'the old market street',
    'air pressure',
    'staying calm',
    'rain rises',
  ],
  ['a map that redraws itself at night', 'the city library', 'satellites and maps', 'honesty', 'map redraws'],
];

/** Developer test mode: deterministic, labelled placeholder episode ideas (no language model). */
function mockPlan(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => {
    const [problem, setting, science, lesson] = PLAN_THEMES[(from + i - 1) % PLAN_THEMES.length]!;
    return {
      title: `MOCK Episode ${from + i}: the mystery of ${problem}`,
      premise: `The kids notice ${problem} at ${setting} and investigate with ${science}. (placeholder idea: developer test mode)`,
      problem,
      setting,
      science,
      lesson,
    };
  });
}
