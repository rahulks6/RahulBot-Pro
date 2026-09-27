import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ScriptRequest } from '../src/domain/script.ts';
import { MockTextModel } from '../src/providers/mock/text.ts';
import type { TextModel, TextRequest } from '../src/providers/types.ts';
import { studioProject } from '../src/services/simple-studio.ts';
import { importStoryPackage, validateStoryPackage } from '../src/services/story-package.ts';
import {
  checkScript,
  extractJson,
  scriptToPackage,
  targetShots,
  writeScript,
} from '../src/services/story-writer.ts';
import { testStudio } from './helpers.ts';

const request = (over: Partial<ScriptRequest> = {}): ScriptRequest => ({
  idea: 'Milo the fox cub helps a lost baby turtle find its way home to the river',
  targetSeconds: 60,
  targetShots: targetShots(60),
  language: 'en',
  style: '3D Kids Animation',
  knownCharacters: [],
  ...over,
});

const good = {
  title: 'Milo and the Little Turtle',
  logline: 'A kind fox cub helps a lost turtle get home.',
  moral: 'Helping others makes us brave.',
  mood: 'playful',
  characters: [
    { name: 'Milo', description: 'a small orange fox cub with a green scarf', voice: 'child' },
    { name: 'Tiko', description: 'a tiny green baby turtle with a yellow shell pattern', voice: 'child' },
  ],
  locations: [
    { name: 'Forest Path', description: 'a sunny path under tall trees' },
    { name: 'River', description: 'a calm sparkling river' },
  ],
  scenes: [
    {
      title: 'A lost friend',
      location: 'Forest Path',
      mood: 'calm',
      ambience: 'forest',
      shots: Array.from({ length: 6 }, (_, i) => ({
        visual: `Milo finds Tiko under a leaf (${i})`,
        characters: ['Milo', 'Tiko'],
        camera: 'medium shot',
        movement: 'slow push-in',
        narration: i === 0 ? 'One sunny morning, Milo heard a tiny voice.' : undefined,
        dialogue: i === 1 ? [{ character: 'Tiko', line: 'I cannot find the river!', emotion: 'sad' }] : [],
        sfx: i === 2 ? ['leaves rustling'] : [],
      })),
    },
    {
      title: 'Home again',
      location: 'River',
      shots: Array.from({ length: 5 }, () => ({
        visual: 'Tiko slides happily into the river while Milo waves',
        characters: ['Milo', 'Tiko'],
        camera: 'wide shot',
        movement: 'pan right',
        dialogue: [{ character: 'Milo', line: 'Goodbye, little friend!', emotion: 'happy' }],
      })),
    },
  ],
};

describe('story writer', () => {
  it('extracts the JSON object from chatty answers and code fences', () => {
    assert.deepEqual(extractJson('Sure! Here it is:\n```json\n{"a": {"b": "x}"}}\n```\nEnjoy.'), {
      a: { b: 'x}' },
    });
    assert.throws(() => extractJson('{"a": 1'), /cut off/);
    assert.throws(() => extractJson('no json here'), /no JSON/);
  });

  it('accepts a good script and names every problem in a bad one', () => {
    const ok = checkScript(good, request());
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.script!.scenes.length, 2);
    const bad = structuredClone(good) as unknown as {
      scenes: Array<{ location: string; shots: Array<Record<string, unknown>> }>;
    };
    bad.scenes[0]!.location = 'Castle';
    bad.scenes[0]!.shots[1]!.dialogue = [{ character: 'Zed', line: 'Hi', emotion: 'happy' }];
    bad.scenes[1]!.shots[0]!.characters = ['Ghost'];
    bad.scenes[1]!.shots[1]!.narration = Array(60).fill('word').join(' ');
    const r = checkScript(bad, request());
    assert.equal(r.script, null);
    const text = r.problems.join('\n');
    assert.match(text, /Scene 1: location "Castle" is not in "locations"/);
    assert.match(text, /speaker "Zed" is not in "characters"/);
    assert.match(text, /character "Ghost" is not in "characters"/);
    assert.match(text, /too much speech/);
    assert.match(
      checkScript({ ...good, scenes: good.scenes.slice(1) }, request()).problems.join(),
      /write about 11/,
    );
  });

  it('sends the problems back once, then accepts the fixed answer', async () => {
    const prompts: TextRequest[] = [];
    const answers = ['Here you go: {"title": "x"}', JSON.stringify(good)];
    const model: TextModel = {
      info: {
        id: 'qwen',
        displayName: 'Qwen',
        isMock: false,
        openSource: true,
        computeLocation: 'cloud_gpu',
        requiresPaidResources: true,
        minVramGb: 18,
        modelVersion: 'main',
        license: 'Apache-2.0',
      },
      write: async (req) => {
        prompts.push(req);
        return {
          text: answers.shift()!,
          model: 'qwen',
          modelVersion: 'main',
          isMock: false,
          generationSeconds: 3,
          hitLimit: false,
        };
      },
    };
    const res = await writeScript(model, request(), { attemptKey: 't' }, 7);
    assert.equal(res.calls, 2);
    assert.equal(res.isMock, false);
    assert.equal(res.script.title, 'Milo and the Little Turtle');
    assert.match(prompts[1]!.prompt, /Your previous answer had these problems/);
    assert.match(prompts[1]!.prompt, /"characters" must list at least one character/);
    assert.ok(prompts.every((p) => p.json && /one clear moment/.test(p.system)));
    assert.notEqual(prompts[0]!.seed, prompts[1]!.seed);
  });

  it('gives up after three bad answers with the reasons', async () => {
    const model: TextModel = {
      info: new MockTextModel().info,
      write: async () => ({
        text: 'I cannot help with that.',
        model: 'm',
        modelVersion: '1',
        isMock: false,
        generationSeconds: 1,
        hitLimit: false,
      }),
    };
    await assert.rejects(
      writeScript(model, request(), { attemptKey: 't' }, 1),
      /could not be written after 3 tries: The answer contains no JSON/,
    );
  });

  it('long videos are written as an outline, then scene by scene', async () => {
    const r = request({ targetSeconds: 540, targetShots: targetShots(540) });
    assert.ok(r.targetShots > 24);
    const res = await writeScript(new MockTextModel(), r, { attemptKey: 'long' }, 3);
    const shots = res.script.scenes.reduce((n, s) => n + s.shots.length, 0);
    assert.ok(Math.abs(shots - r.targetShots) <= r.targetShots * 0.2, `${shots} shots for ${r.targetShots}`);
    assert.equal(res.calls, 1 + res.script.scenes.length);
    assert.equal(res.isMock, true, 'the mock is labelled');
  });

  describe('script → Story Package → import', () => {
    const s = testStudio();
    after(() => s.cleanup());

    it('produces a valid package that imports; library characters are reused unchanged', () => {
      const project = studioProject(s);
      const milo = s.characters.create(project.id, {
        name: 'Milo',
        appearance: 'LIBRARY LOOK',
        prompt: 'LIBRARY LOOK',
      });
      const script = checkScript(good, request()).script!;
      const pkg = scriptToPackage(script, request({ language: 'hinglish' }), {
        project,
        existingCharacters: ['Milo'],
        styleId: '3d_kids',
        narrator: 'female',
        targetSeconds: 60,
      });
      const v = validateStoryPackage(pkg);
      assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 5)));
      const sum = importStoryPackage(s, pkg, { projectId: project.id });
      const tree = s.stories.tree(sum.storyId);
      assert.equal(tree.scenes.length, 2);
      assert.equal(tree.scenes.flatMap((x) => x.shots).length, 11);
      assert.equal(s.characters.get(milo.id).appearance, 'LIBRARY LOOK', 'library character untouched');
      assert.ok(sum.reused.some((x) => /Milo/.test(x)));
      const tiko = s.characters.findByName(project.id, 'Tiko')!;
      assert.match(tiko.appearance, /baby turtle/);
      const story = s.stories.get(sum.storyId);
      assert.equal(story.language, 'hi-Latn');
      const durations = tree.scenes.flatMap((x) => x.shots.map((y) => y.shot.duration_sec));
      assert.ok(
        durations.every((d) => d >= 3 && d <= 6),
        'each shot fits one animated clip',
      );
    });
  });
});
