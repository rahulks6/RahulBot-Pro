import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { evaluateWindow } from '../src/services/budget.ts';
import { KILL_ALL_CONFIRMATION, STUDIO_TAG } from '../src/services/gpu-supervisor.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

describe('budget', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  const spend = (inr: number, isMock = true, at?: string) =>
    s.gpuRepo.recordUsage({
      category: 'generation',
      seconds: 3600,
      hourlyRateInr: inr,
      provider: 'mock',
      isMock,
      recordedAt: at ?? s.clock.now().toISOString(),
    });

  it('computes levels: ok, 80 % warning, 100 % block', () => {
    const cfg = { dailyInr: 200, monthlyInr: 1500, warnPercent: 80, blockPercent: 100 };
    assert.equal(evaluateWindow(100, 200, cfg).level, 'ok');
    assert.equal(evaluateWindow(160, 200, cfg).level, 'warn');
    assert.equal(evaluateWindow(200, 200, cfg).level, 'blocked');
    assert.equal(evaluateWindow(0, 0, cfg).level, 'blocked', 'a zero budget blocks cloud work');
    assert.equal(evaluateWindow(150, 200, cfg).remainingInr, 50);
  });

  it('uses the default ₹200/day and ₹1,500/month budgets and keeps simulated spend separate', () => {
    spend(170);
    const sim = s.budget.status(true);
    assert.equal(sim.daily.limitInr, 200);
    assert.equal(sim.monthly.limitInr, 1500);
    assert.equal(sim.level, 'warn');
    assert.equal(s.budget.status(false).daily.spentInr, 0, 'mock spend never counts as real spend');
    spend(40);
    assert.equal(s.budget.status(true).level, 'blocked');
    // Next day: daily resets, monthly still accumulates.
    s.clockCtl.advanceSeconds(24 * 3600);
    const next = s.budget.status(true);
    assert.equal(next.daily.spentInr, 0);
    assert.equal(next.monthly.spentInr, 210);
  });

  it('blocks NEW cloud generations when the budget is exhausted (nothing provisioned)', async () => {
    const { shots } = seedSmall(s);
    spend(200);
    s.generation.queueImage(shots[0]!.id);
    const r = await s.generation.processQueue();
    assert.equal(r.failed, 1);
    assert.equal(s.jobs.list({ status: 'failed' })[0]!.error_code, 'BUDGET_EXCEEDED');
    assert.equal(s.db.scalar('SELECT COUNT(*) FROM gpu_instances'), 0);
  });

  it('blocks when the worst-case session cost exceeds the remaining budget', async () => {
    s.settings.set('budget', { dailyInr: 30, monthlyInr: 1500, warnPercent: 80, blockPercent: 100 });
    await assert.rejects(s.gpu.plan(24, 300), (e: AppError) => e.code === 'BUDGET_EXCEEDED');
  });

  it('never raises budgets automatically; settings are validated', () => {
    assert.throws(
      () => s.settings.set('budget', { dailyInr: -5, monthlyInr: 10, warnPercent: 80, blockPercent: 100 }),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
    assert.equal(s.settings.get('budget').dailyInr, 200);
  });
});

describe('GPU safety', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('refuses GPUs above the maximum hourly price', async () => {
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 20 });
    await assert.rejects(
      s.gpu.plan(24, 100),
      (e: AppError) => e.code === 'PRICE_TOO_HIGH' && e.message.includes('Nothing was provisioned'),
    );
    assert.equal(s.mockGpu.activeCount(), 0);
  });

  it('picks the cheapest offer with enough VRAM', async () => {
    const plan = await s.gpu.plan(40, 100);
    assert.equal(plan.offer.vramGb, 48);
    assert.ok(plan.estimatedMaxCostInr > plan.estimatedCostInr);
  });

  it('terminates on idle timeout and on maximum lifetime', async () => {
    const plan = await s.gpu.plan(24, 60);
    const a = await s.gpu.start(plan);
    s.clockCtl.advanceSeconds(9 * 60);
    assert.deepEqual(await s.gpu.enforceTimers(), []);
    s.clockCtl.advanceSeconds(2 * 60);
    assert.deepEqual(await s.gpu.enforceTimers(), [a.id]);
    assert.equal(s.gpuRepo.get(a.id).termination_reason, 'idle_timeout');

    const b = await s.gpu.start(plan);
    for (let i = 0; i < 13; i++) {
      s.clockCtl.advanceSeconds(5 * 60);
      b.recordUsage('generation', 1); // busy, never idle
      await s.gpu.enforceTimers();
    }
    assert.equal(s.gpuRepo.get(b.id).status, 'terminated');
    assert.equal(s.gpuRepo.get(b.id).termination_reason, 'max_lifetime');
    assert.equal(s.mockGpu.activeCount(), 0);
  });

  it('cleans up on failure and on cancellation', async () => {
    const plan = await s.gpu.plan(24, 60);
    await assert.rejects(
      s.gpu.withSession(plan, async () => {
        throw new Error('boom');
      }),
    );
    await assert.rejects(
      s.gpu.withSession(plan, async () => {
        const { AppError: E } = await import('../src/lib/errors.ts');
        throw new E('CANCELLED', 'user cancelled');
      }),
    );
    const reasons = s.gpuRepo
      .list()
      .map((g) => g.termination_reason)
      .sort();
    assert.deepEqual(reasons, ['cancellation_cleanup', 'failure_cleanup']);
    assert.equal(s.mockGpu.activeCount(), 0);
  });

  it('handles provisioning failure without leaving anything running', async () => {
    s.mockGpu.failNextProvisions = 5;
    const plan = await s.gpu.plan(24, 60);
    await assert.rejects(s.gpu.start(plan), (e: AppError) => e.code === 'PROVISION_FAILED');
    assert.equal(s.mockGpu.activeCount(), 0);
    assert.ok(s.gpuRepo.events().some((e) => e.event === 'provision_failed'));
    s.mockGpu.failNextProvisions = 0;
  });

  it('falls back to the next compatible GPU type when one cannot be rented', async () => {
    const plan = await s.gpu.plan(24, 60);
    assert.ok(plan.alternatives.length > 0, 'alternatives are planned');
    s.mockGpu.failNextProvisions = 1;
    const tried: string[] = [];
    const sess = await s.gpu.start(plan, {
      onFallback: (from, to) => tried.push(`${from.gpuModel}→${to.gpuModel}`),
    });
    assert.equal(tried.length, 1);
    assert.equal(sess.instance.gpu_model, plan.alternatives[0]!.gpuModel);
    await s.gpu.terminate(sess.id, 'job_completion');
    assert.equal(s.mockGpu.activeCount(), 0);
  });

  it('retries failed terminations via the watchdog', async () => {
    const plan = await s.gpu.plan(24, 60);
    const sess = await s.gpu.start(plan);
    s.mockGpu.failNextTerminations = 3;
    assert.equal(await s.gpu.terminate(sess.id, 'job_completion'), false);
    assert.equal(s.gpuRepo.get(sess.id).status, 'terminating');
    assert.equal(s.mockGpu.activeCount(), 1);
    const rep = await s.gpu.watchdog();
    assert.deepEqual(rep.retriedTerminations, [sess.id]);
    assert.equal(s.mockGpu.activeCount(), 0);
  });

  it('watchdog terminates orphaned studio instances but never foreign ones', async () => {
    const orphan = s.mockGpu.injectInstance([STUDIO_TAG]);
    s.mockGpu.injectInstance(['someone-else']);
    const rep = await s.gpu.watchdog();
    assert.deepEqual(rep.orphansFound, [orphan]);
    assert.deepEqual(rep.orphansTerminated, [orphan]);
    assert.equal(s.mockGpu.activeCount(STUDIO_TAG), 0);
    assert.equal(s.mockGpu.activeCount('someone-else'), 1);
    assert.ok(s.gpuRepo.events().some((e) => e.event === 'watchdog'));
  });

  it('watchdog "warn" policy reports orphans without terminating', async () => {
    s.settings.set('gpu', { ...s.settings.get('gpu'), orphanPolicy: 'warn' });
    s.mockGpu.injectInstance([STUDIO_TAG]);
    const rep = await s.gpu.watchdog();
    assert.equal(rep.orphansTerminated.length, 0);
    assert.equal(rep.warnings.length, 1);
  });

  it('emergency kill switch needs confirmation and only touches studio resources', async () => {
    const plan = await s.gpu.plan(24, 60);
    await s.gpu.start(plan);
    s.mockGpu.injectInstance([STUDIO_TAG]);
    s.mockGpu.injectInstance(['personal-vm']);
    await assert.rejects(s.gpu.killAll('yes'), (e: AppError) => e.code === 'PRECONDITION_FAILED');
    const res = await s.gpu.killAll(KILL_ALL_CONFIRMATION);
    assert.equal(res.terminated.length, 2);
    assert.equal(await s.gpu.liveStudioInstances(), 0);
    assert.equal(s.mockGpu.activeCount('personal-vm'), 1);
  });

  it('refuses paid GPU providers while MOCK_GENERATION=true or cloud is disabled', async () => {
    const { MockGPUProvider } = await import('../src/providers/mock/gpu.ts');
    class PretendCloud extends MockGPUProvider {
      override readonly isMock = false;
      override readonly paid = true;
    }
    const { createMockProviders } = await import('../src/providers/registry.ts');
    const { LocalStorageProvider } = await import('../src/storage/storage.ts');
    const providers = {
      ...createMockProviders(new LocalStorageProvider(s.env.dataDir)),
      gpu: new PretendCloud(),
    };
    for (const env of [
      { mockGeneration: true, enableCloudGpu: true },
      { mockGeneration: false, enableCloudGpu: false },
    ]) {
      const t = testStudio({ providers, env });
      try {
        await assert.rejects(t.gpu.plan(24, 60), (e: AppError) =>
          ['MOCK_MODE_REQUIRED', 'CLOUD_GPU_DISABLED'].includes(e.code),
        );
      } finally {
        t.cleanup();
      }
    }
  });
});
