import { prng, seedFrom } from '../../lib/hash.ts';
import { SCRIPT_REQUEST_MARKER, type ScriptRequest, type StoryScript } from '../../domain/script.ts';
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
  return {
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
