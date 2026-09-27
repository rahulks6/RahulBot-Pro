import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEMO_EPISODE_1, DEMO_EPISODE_2 } from '../src/demo/demo-packages.ts';
import type { AppError } from '../src/lib/errors.ts';
import { importStoryPackage, validateStoryPackage } from '../src/services/story-package.ts';
import { testStudio, type TestStudio } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('Story Package', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('validates the documented demo packages', () => {
    assert.equal(validateStoryPackage(DEMO_EPISODE_1).ok, true);
    assert.equal(validateStoryPackage(JSON.stringify(DEMO_EPISODE_2)).ok, true);
  });

  it('reports useful schema and cross-reference errors', () => {
    const bad = clone(DEMO_EPISODE_1) as Record<string, unknown> & { scenes: Array<Record<string, unknown>> };
    bad['format'] = 'something-else';
    (bad.scenes[0] as { location: string }).location = 'nowhere';
    const shots = (bad.scenes[1] as { shots: Array<Record<string, unknown>> }).shots;
    shots[0]!['characters'] = [{ character: 'ghost' }];
    shots[0]!['durationSec'] = -1;
    shots[0]!['surprise'] = true;
    let v = validateStoryPackage(bad);
    assert.equal(v.ok, false);
    const paths = v.errors.map((e) => e.path);
    assert.ok(paths.includes('format'));
    assert.ok(paths.includes('scenes[1].shots[0].durationSec'));
    assert.ok(paths.includes('scenes[1].shots[0].surprise'));
    // Fix schema errors to reach cross-reference validation.
    bad['format'] = 'ai-story-studio/story-package';
    shots[0]!['durationSec'] = 4;
    delete shots[0]!['surprise'];
    v = validateStoryPackage(bad);
    assert.deepEqual(
      v.errors.map((e) => `${e.path}: ${e.message}`).sort(),
      [
        'scenes[0].location: unknown location "nowhere"',
        'scenes[1].shots[0].characters[0].character: unknown character "ghost"',
      ].sort(),
    );
    assert.equal(validateStoryPackage('{not json').errors[0]!.message.startsWith('Not valid JSON'), true);
  });

  it('imports a package into a new project with every entity', () => {
    const summary = importStoryPackage(s, DEMO_EPISODE_1);
    assert.equal(summary.created['characters'], 2);
    assert.equal(summary.created['scenes'], 3);
    assert.equal(summary.created['shots'], 6);
    const tree = s.stories.tree(summary.storyId);
    assert.equal(tree.scenes.length, 3);
    const project = s.projects.get(summary.projectId);
    assert.ok(project.narrator_voice_id);
    assert.equal(s.projects.getStyle(project.default_style_id!).name, 'Premium 3D children’s animation');
    const shot = tree.scenes[0]!.shots[1]!;
    assert.equal(shot.dialogue[0]!.text, 'Come on, little lantern. Why won’t you glow?');
    assert.equal(shot.shot.mouth_visible, 1);
    assert.equal(shot.propIds.length, 1);
    assert.equal(tree.scenes[2]!.shots[0]!.characters[0]!.variant_id !== null, true);
    assert.equal(s.reports.imports()[0]!.status, 'imported');
  });

  it('never partially imports: a failure rolls everything back', () => {
    const before = s.db.scalar<number>('SELECT COUNT(*) FROM projects');
    const pkg = clone(DEMO_EPISODE_1);
    // Passes validation, but the second character collides with the first by name (UNIQUE) mid-import.
    (pkg.characters[1] as { name: string }).name = 'Pip';
    assert.throws(
      () => importStoryPackage(s, pkg),
      (e: AppError) => e.message.includes('rolled back'),
    );
    assert.equal(s.db.scalar<number>('SELECT COUNT(*) FROM projects'), before);
    assert.equal(s.db.scalar<number>('SELECT COUNT(*) FROM characters'), 0);
    assert.equal(s.db.scalar<number>('SELECT COUNT(*) FROM stories'), 0);
    assert.equal(s.reports.imports()[0]!.status, 'failed');
  });

  it('reuses existing (and locked) entities when importing into a project', () => {
    const ep1 = importStoryPackage(s, DEMO_EPISODE_1);
    const pip = s.characters.findByName(ep1.projectId, 'Pip')!;
    s.characters.lock(pip.id);
    const ep2 = importStoryPackage(s, DEMO_EPISODE_2, { projectId: ep1.projectId });
    assert.equal(ep2.projectId, ep1.projectId);
    assert.equal(s.characters.list(ep1.projectId).length, 2);
    assert.ok(ep2.reused.some((r) => r.includes('Pip') && r.includes('locked')));
    assert.equal(s.characters.get(pip.id).prompt, pip.prompt);
    assert.equal(s.stories.list(ep1.projectId).length, 2);
  });
});
