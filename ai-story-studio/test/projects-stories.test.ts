import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { testStudio, type TestStudio } from './helpers.ts';

describe('projects and stories CRUD', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('creates, reads, updates and deletes a project', () => {
    const p = s.projects.create({
      name: 'Space Pals',
      genre: 'Space adventure',
      aspect_ratio: '9:16',
      fps: 30,
    });
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.fps, 30);
    const updated = s.projects.update(p.id, { name: 'Space Pals 2', aspect_ratio: '16:9' });
    assert.equal(updated.name, 'Space Pals 2');
    assert.equal(updated.width, 1920);
    assert.equal(s.projects.list().length, 1);
    s.projects.delete(p.id);
    assert.equal(s.projects.list().length, 0);
    assert.throws(
      () => s.projects.get(p.id),
      (e: AppError) => e.code === 'NOT_FOUND',
    );
  });

  it('rejects invalid project input with field errors', () => {
    assert.throws(
      () => s.projects.create({ name: '', fps: 25 }),
      (e: AppError) =>
        e.code === 'VALIDATION_FAILED' &&
        e.details.some((d) => d.path === 'name') &&
        e.details.some((d) => d.path === 'fps'),
    );
  });

  it('seeds built-in style presets without hard-coding one style', () => {
    const names = s.projects.listStyles().map((x) => x.name);
    for (const n of ['2D cartoon', 'Storybook', 'Clay', 'Watercolor', 'Anime-inspired'])
      assert.ok(names.includes(n), n);
  });

  it('creates, updates and deletes a story (cascading scenes/shots)', () => {
    const p = s.projects.create({ name: 'P' });
    const st = s.stories.create(p.id, { title: 'Ep 1', episode_number: 1, target_duration_sec: 300 });
    const sc = s.stories.createScene(st.id, { title: 'Opening' });
    s.stories.createShot(sc.id, { title: 'A' });
    const u = s.stories.update(st.id, { moral: 'Be kind', status: 'in_production' });
    assert.equal(u.moral, 'Be kind');
    assert.equal(u.status, 'in_production');
    assert.equal(u.target_duration_sec, 300);
    s.stories.delete(st.id);
    assert.equal(s.db.scalar('SELECT COUNT(*) FROM shots'), 0);
    assert.equal(s.db.scalar('SELECT COUNT(*) FROM scenes'), 0);
  });

  it('orders scenes: append, move, reorder, delete compacts', () => {
    const p = s.projects.create({ name: 'P' });
    const st = s.stories.create(p.id, { title: 'S' });
    const [a, b, c] = ['A', 'B', 'C'].map((t) => s.stories.createScene(st.id, { title: t }));
    const titles = () =>
      s.stories
        .listScenes(st.id)
        .map((x) => x.title)
        .join('');
    assert.equal(titles(), 'ABC');
    s.stories.moveScene(c!.id, 'up');
    assert.equal(titles(), 'ACB');
    s.stories.moveScene(a!.id, 'up'); // already first: no-op
    assert.equal(titles(), 'ACB');
    s.stories.reorderScenes(st.id, [b!.id, a!.id, c!.id]);
    assert.equal(titles(), 'BAC');
    s.stories.deleteScene(a!.id);
    assert.deepEqual(
      s.stories.listScenes(st.id).map((x) => x.position),
      [0, 1],
    );
    assert.throws(
      () => s.stories.reorderScenes(st.id, [b!.id]),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
  });

  it('orders shots within a scene', () => {
    const p = s.projects.create({ name: 'P' });
    const st = s.stories.create(p.id, { title: 'S' });
    const sc = s.stories.createScene(st.id, { title: 'Scene' });
    const shots = ['1', '2', '3'].map((t) => s.stories.createShot(sc.id, { title: t }));
    s.stories.moveShot(shots[0]!.id, 'down');
    assert.equal(
      s.stories
        .listShots(sc.id)
        .map((x) => x.title)
        .join(''),
      '213',
    );
    s.stories.deleteShot(shots[1]!.id);
    assert.deepEqual(
      s.stories.listShots(sc.id).map((x) => [x.title, x.position]),
      [
        ['1', 0],
        ['3', 1],
      ],
    );
  });

  it('keeps dialogue text separate from audio: editing text clears the audio reference', () => {
    const p = s.projects.create({ name: 'P' });
    const st = s.stories.create(p.id, { title: 'S' });
    const sc = s.stories.createScene(st.id, { title: 'Scene' });
    const sh = s.stories.createShot(sc.id, {});
    const d = s.stories.addDialogue(sh.id, { text: 'Hello', language: 'en' });
    s.db.run(
      "INSERT INTO generated_assets (id, project_id, kind, storage_key, mime, checksum, created_at) VALUES ('ast_x', ?, 'audio', 'k.wav', 'audio/wav', 'c', 'now')",
      p.id,
    );
    s.db.run(
      "INSERT INTO audio_assets (id, project_id, generated_asset_id, layer, cache_key, duration_sec, provider, model, created_at) VALUES ('aud_x', ?, 'ast_x', 'dialogue', 'k', 1, 'm', 'm', 'now')",
      p.id,
    );
    s.stories.setDialogueAudio(d.id, 'aud_x');
    assert.equal(s.stories.updateDialogue(d.id, { delivery: 'softly' }).audio_asset_id, 'aud_x');
    assert.equal(s.stories.updateDialogue(d.id, { text: 'Hello there' }).audio_asset_id, null);
    assert.throws(
      () => s.stories.addDialogue(sh.id, { text: 'Hola', language: 'not a lang!' }),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
  });
});
