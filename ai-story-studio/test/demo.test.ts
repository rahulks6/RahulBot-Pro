import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedDemo } from '../src/demo/seed.ts';
import { testStudio } from './helpers.ts';

describe('Phase 1 demo (mock, ₹0)', () => {
  it('runs the whole workflow and leaves no GPU running', async () => {
    const s = testStudio();
    try {
      const r = await seedDemo(s);
      assert.equal(r.exportStatus, 'complete');
      assert.equal(s.projects.list().length, 1);
      assert.equal(s.stories.list(r.projectId).length, 2);
      assert.ok(s.characters.list(r.projectId).length >= 2);
      assert.ok(s.characters.list(r.projectId).some((c) => c.locked));
      assert.ok(
        s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE approval = 'rejected'")! >= 1,
      );
      assert.ok(
        s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE status = 'failed'")! >= 1,
      );
      assert.ok(s.timeline.view(r.episode1));
      assert.equal(s.reports.latestQuality(r.episode1).length >= 4, true);
      assert.ok(s.reports.similarity(r.episode2).length === 1);
      assert.equal(await s.gpu.liveStudioInstances(), 0);
      assert.equal(
        s.db.scalar<number>('SELECT COUNT(*) FROM usage_records WHERE is_mock = 0'),
        0,
        'no real spend',
      );
    } finally {
      s.cleanup();
    }
  });
});
