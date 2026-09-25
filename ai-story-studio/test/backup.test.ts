import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { exportProject, importProject } from '../src/services/backup.ts';
import { produceShots, seedSmall, testStudio, type TestStudio } from './helpers.ts';

describe('project backup / import', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('round-trips a full media backup into a new project with fresh ids', async () => {
    const { project, story } = seedSmall(s);
    await produceShots(s, story.id);
    const exp = await s.exports.buildFinal(story.id);
    assert.equal(exp.status, 'complete');
    const backup = await exportProject(s, project.id, { includeMedia: true });
    assert.ok(Object.keys(backup.media).length > 5);
    const restored = await importProject(s, JSON.stringify(backup));
    assert.notEqual(restored.projectId, project.id);
    const count = (table: string, where: string, id: string) =>
      s.db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, id);
    for (const [table, where] of [
      ['characters', 'project_id = ?'],
      ['stories', 'project_id = ?'],
      ['generated_assets', 'project_id = ?'],
      ['generation_attempts', 'project_id = ?'],
      ['audio_assets', 'project_id = ?'],
    ] as const) {
      assert.equal(count(table, where, restored.projectId), count(table, where, project.id), table);
    }
    const newStory = s.stories.list(restored.projectId)[0]!;
    const tree = s.stories.tree(newStory.id);
    const shot = tree.scenes[0]!.shots[0]!.shot;
    const clip = s.assets.get(shot.approved_video_asset_id!);
    assert.equal(clip.project_id, restored.projectId);
    assert.ok(clip.storage_key.startsWith(`projects/${restored.projectId}/`));
    assert.ok(await s.storage.exists(clip.storage_key), 'media restored');
    // Manifests inside media now point at restored files.
    const master = s.assets.list({ projectId: restored.projectId, kind: 'master' })[0]!;
    const manifest = (await s.assets.read(master.id)).toString('utf8');
    assert.ok(!manifest.includes(`projects/${project.id}/`));
    // The restored project is fully usable: timeline + checks run.
    assert.ok(s.timeline.view(newStory.id));
    assert.equal(s.reports.exports(newStory.id)[0]!.status, 'complete');
    // Original untouched.
    assert.equal(s.stories.list(project.id).length, 1);
  });

  it('metadata-only backup restores structure without media', async () => {
    const { project } = seedSmall(s);
    const backup = await exportProject(s, project.id, { includeMedia: false });
    assert.deepEqual(backup.media, {});
    const r = await importProject(s, backup);
    assert.equal(r.mediaFiles, 0);
    assert.equal(s.characters.list(r.projectId).length, 2);
    assert.ok(s.projects.get(r.projectId).narrator_voice_id);
  });

  it('rejects invalid or tampered backups without writing anything', async () => {
    const { project } = seedSmall(s);
    const before = s.db.scalar<number>('SELECT COUNT(*) FROM projects');
    await assert.rejects(
      importProject(s, '{"format":"nope"}'),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
    await assert.rejects(importProject(s, 'not json'), (e: AppError) => e.code === 'VALIDATION_FAILED');
    const backup = await exportProject(s, project.id, { includeMedia: false });
    (backup.tables['characters']![0] as Record<string, unknown>)['evil_column; DROP TABLE projects'] = 'x';
    await assert.rejects(importProject(s, backup), (e: AppError) => /Unknown column/.test(e.message));
    const b2 = await exportProject(s, project.id, { includeMedia: false });
    (b2.tables['generated_assets'] ??= []).push({
      id: 'ast_evil',
      project_id: project.id,
      kind: 'image',
      storage_key: '../../etc/passwd.png',
      mime: 'image/png',
      checksum: 'x',
      created_at: 'now',
    });
    await assert.rejects(importProject(s, b2), (e: AppError) => e.code === 'FORBIDDEN');
    assert.equal(s.db.scalar<number>('SELECT COUNT(*) FROM projects'), before);
  });
});
