import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

describe('generation queue, history and review', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('batches GPU jobs into ONE session, loads each model once and terminates the GPU', async () => {
    const { shots } = seedSmall(s);
    for (const sh of shots) s.generation.queueImage(sh.id);
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 3);
    assert.equal(r.gpuSessions, 1);
    assert.equal(s.db.scalar('SELECT COUNT(*) FROM gpu_instances'), 1);
    assert.equal(s.db.scalar("SELECT COUNT(*) FROM usage_records WHERE category = 'model_load'"), 1);
    assert.equal(s.db.scalar("SELECT COUNT(*) FROM usage_records WHERE category = 'startup'"), 1);
    assert.equal(s.gpuRepo.list()[0]!.termination_reason, 'job_completion');
    assert.equal(s.mockGpu.activeCount(), 0);
    assert.ok(r.simulatedCostInr > 0);
    // Every attempt is recorded with full metadata.
    const a = s.jobs.attemptsForShot(shots[0]!.id, 'image')[0]!;
    assert.equal(a.status, 'succeeded');
    assert.ok(a.prompt.includes('Ari'));
    assert.ok(a.seed !== null && a.gpu_model && a.gpu_instance_id && a.is_mock === 1);
    const log = s.jobs.log(s.jobs.get(a.job_id)).map((l) => l.status);
    for (const st of [
      'waiting',
      'provisioning_gpu',
      'starting_worker',
      'loading_model',
      'generating_image',
      'downloading',
      'complete',
    ]) {
      assert.ok(log.includes(st as never), `status ${st} missing from ${log.join(',')}`);
    }
  });

  it('enforces image-first and never regenerates the image when the clip fails', async () => {
    const { shots } = seedSmall(s);
    const id = shots[0]!.id;
    assert.throws(
      () => s.generation.queueVideo(id),
      (e: AppError) => e.code === 'PRECONDITION_FAILED',
    );
    s.generation.queueImage(id);
    await s.generation.processQueue();
    const img = s.jobs.attemptsForShot(id, 'image')[0]!;
    s.generation.approveAttempt(img.id);
    s.generation.queueVideo(id, { params: { mockForceFailure: 'OUT_OF_MEMORY' } });
    const r = await s.generation.processQueue();
    assert.equal(r.failed, 1);
    assert.equal(s.jobs.attemptsForShot(id, 'image').length, 1, 'no new image attempts');
    assert.equal(s.stories.getShot(id).approved_image_asset_id, img.output_asset_id);
    assert.equal(s.mockGpu.activeCount(), 0, 'GPU terminated after failure');
    assert.equal(s.gpuRepo.list()[0]!.termination_reason, 'job_completion');
  });

  it('retries retryable failures (bounded) and preserves failed attempts', async () => {
    const { shots } = seedSmall(s);
    s.generation.queueImage(shots[0]!.id, { params: { mockFailAttempts: 1 } });
    s.generation.queueImage(shots[1]!.id, { params: { mockFailAttempts: 5 } });
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1);
    assert.equal(r.failed, 1);
    const a0 = s.jobs.attemptsForShot(shots[0]!.id, 'image');
    assert.deepEqual(a0.map((a) => a.status).sort(), ['failed', 'succeeded']);
    const a1 = s.jobs.attemptsForShot(shots[1]!.id, 'image');
    assert.equal(a1.length, 2, 'maxAttempts (2) bounds retries');
    assert.ok(a1.every((a) => a.status === 'failed' && a.error_code === 'IMAGE_GENERATION_FAILED'));
  });

  it('does not retry non-retryable failures', async () => {
    const { shots } = seedSmall(s);
    s.generation.queueImage(shots[0]!.id, { params: { mockForceFailure: 'CUDA_FAILURE' } });
    await s.generation.processQueue();
    assert.equal(s.jobs.attemptsForShot(shots[0]!.id, 'image').length, 1);
  });

  it('approve / reject / regenerate keeps history and never auto-regenerates approved work', async () => {
    const { shots } = seedSmall(s);
    const id = shots[1]!.id;
    s.generation.queueImage(id);
    await s.generation.processQueue();
    const first = s.jobs.attemptsForShot(id, 'image')[0]!;
    s.generation.rejectAttempt(first.id);
    assert.equal(s.assets.get(first.output_asset_id!).approval, 'rejected');
    s.generation.regenerate(id, 'image', { seed: 'new' });
    await s.generation.processQueue();
    const attempts = s.jobs.attemptsForShot(id, 'image');
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]!.seed, attempts[1]!.seed);
    const second = attempts.find((a) => a.id !== first.id)!;
    s.generation.approveAttempt(second.id);
    assert.equal(s.stories.getShot(id).approved_image_asset_id, second.output_asset_id);
    assert.equal(s.stories.getShot(id).approval_state, 'image_approved');
    assert.throws(
      () => s.generation.queueImage(id),
      (e: AppError) => e.code === 'CONFLICT',
    );
    // Rejected attempt is still in history with its facts intact.
    assert.equal(s.jobs.getAttempt(first.id).approval, 'rejected');
    assert.equal(s.jobs.getAttempt(first.id).seed, first.seed);
  });

  it('upscales OPTIMIZED clips without destroying the original', async () => {
    const { shots } = seedSmall(s);
    const id = shots[0]!.id;
    s.generation.queueImage(id);
    await s.generation.processQueue();
    s.generation.approveAttempt(s.jobs.attemptsForShot(id, 'image')[0]!.id);
    s.generation.queueVideo(id);
    await s.generation.processQueue();
    const clip = s.assets.get(s.jobs.attemptsForShot(id, 'video')[0]!.output_asset_id!);
    assert.equal(clip.kind, 'upscaled_video');
    assert.equal(clip.is_native_resolution, 0, 'upscaled output is never labelled native');
    assert.equal(clip.width, 1920);
    const original = s.assets.get(clip.source_asset_id!);
    assert.equal(original.kind, 'video');
    assert.equal(original.width, 960);
    assert.ok(await s.storage.exists(original.storage_key));
  });

  it('cancels waiting jobs and does not duplicate active jobs', async () => {
    const { shots } = seedSmall(s);
    const j1 = s.generation.queueImage(shots[0]!.id);
    assert.equal(s.generation.queueImage(shots[0]!.id).id, j1.id);
    s.generation.cancel(j1.id);
    const r = await s.generation.processQueue();
    assert.equal(r.processed, 0);
    assert.equal(s.jobs.get(j1.id).status, 'cancelled');
    assert.equal(s.db.scalar('SELECT COUNT(*) FROM gpu_instances'), 0, 'no GPU started for an empty batch');
  });

  it('refuses to generate when MOCK_GENERATION=false (Phase 1 has no real providers)', async () => {
    const real = testStudio({ env: { mockGeneration: false } });
    try {
      const { shots } = seedSmall(real);
      real.generation.queueImage(shots[0]!.id);
      await assert.rejects(real.generation.processQueue(), (e: AppError) => e.code === 'MOCK_MODE_REQUIRED');
      assert.equal(real.db.scalar('SELECT COUNT(*) FROM gpu_instances'), 0);
    } finally {
      real.cleanup();
    }
  });

  it('mock providers honour a random failure rate deterministically', async () => {
    const flaky = testStudio({ failureRate: 1 });
    try {
      const { shots } = seedSmall(flaky);
      flaky.generation.queueImage(shots[0]!.id);
      const r = await flaky.generation.processQueue();
      assert.equal(r.failed, 1);
      assert.equal(flaky.mockGpu.activeCount(), 0);
    } finally {
      flaky.cleanup();
    }
  });
});
