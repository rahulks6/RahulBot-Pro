import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { activeSelections, BenchmarkService } from '../src/services/benchmarks.ts';
import { testStudio, type TestStudio } from './helpers.ts';

const models = [
  {
    id: 'good-image',
    kind: 'image',
    display_name: 'Good',
    version: 'r1',
    license: 'Apache-2.0',
    commercial_use: 'allowed',
    license_url: '',
    mock: false,
    min_vram_gb: 12,
  },
  {
    id: 'cond-video',
    kind: 'video',
    display_name: 'Cond',
    version: 'r1',
    license: 'Community',
    commercial_use: 'conditional',
    license_url: '',
    mock: false,
    min_vram_gb: 16,
  },
  {
    id: 'nc-image',
    kind: 'image',
    display_name: 'NC',
    version: 'r1',
    license: 'CC-BY-NC',
    commercial_use: 'non_commercial',
    license_url: '',
    mock: false,
    min_vram_gb: 12,
  },
];

describe('benchmarks: ratings, aggregation and model selection', () => {
  let s: TestStudio;
  let svc: BenchmarkService;
  const runId = 'bench_test1';
  beforeEach(() => {
    s = testStudio();
    svc = new BenchmarkService(s);
    s.db.insert('benchmark_runs', {
      id: runId,
      worker_job_id: 'job_0000000000000001',
      worker_url: 'http://127.0.0.1:1',
      suite: 'unit',
      status: 'complete',
      hourly_rate_inr: 72,
      models_json: JSON.stringify(models),
      summary_json: JSON.stringify({
        'good-image': {
          runs: 4,
          succeeded: 3,
          success_rate: 0.75,
          load_seconds: 20,
          mean_run_seconds: 10,
          p95_run_seconds: 14,
          peak_vram_mb: 15000,
          reproducible_same_seed: true,
          errors: ['OUT_OF_MEMORY'],
        },
      }),
      started_at: '2026-01-01T00:00:00Z',
    });
    for (const [i, q] of [
      ['r1', 'complete'],
      ['r2', 'complete'],
      ['r3', 'failed'],
    ] as const) {
      s.db.insert('benchmark_results', {
        id: i,
        run_id: runId,
        model_id: 'good-image',
        kind: 'image',
        case_key: 'a',
        seed: 1,
        status: q,
        created_at: 'now',
      });
    }
  });
  afterEach(() => s.cleanup());

  it('stores human ratings and aggregates them with measured numbers and cost', () => {
    svc.rate('r1', { quality: 4, consistency: 5, notes: 'on model' });
    svc.rate('r2', { quality: 2 });
    svc.rate('r2', { quality: 3, consistency: 3 }); // re-rating replaces
    assert.throws(
      () => svc.rate('r3', { quality: 4 }),
      (e: AppError) => e.code === 'PRECONDITION_FAILED',
    );
    assert.throws(
      () => svc.rate('r1', { quality: 7 }),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
    const agg = svc.aggregate(runId).find((a) => a.model.id === 'good-image')!;
    assert.equal(agg.avgQuality, 3.5);
    assert.equal(agg.avgConsistency, 4);
    assert.equal(agg.successRate, 0.75);
    assert.equal(agg.estCostPerOutputInr, 0.2, '10 s at ₹72/h');
    assert.deepEqual(agg.errors, ['OUT_OF_MEMORY']);
  });

  it('enforces licences when selecting and keeps a decision history', () => {
    assert.throws(
      () => svc.select({ runId, modelId: 'nc-image', rationale: 'looks best', licenseAcknowledged: true }),
      (e: AppError) => e.code === 'FORBIDDEN',
    );
    assert.throws(
      () => svc.select({ runId, modelId: 'cond-video', rationale: 'fast', licenseAcknowledged: false }),
      (e: AppError) => e.code === 'PRECONDITION_FAILED',
    );
    assert.throws(
      () => svc.select({ runId, modelId: 'good-image', rationale: '  ', licenseAcknowledged: false }),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
    svc.select({
      runId,
      modelId: 'cond-video',
      rationale: 'best motion; revenue below threshold',
      licenseAcknowledged: true,
    });
    svc.select({ runId, modelId: 'good-image', rationale: 'best consistency', licenseAcknowledged: false });
    svc.select({
      runId,
      modelId: 'good-image',
      rationale: 'confirmed after second run',
      licenseAcknowledged: false,
    });
    assert.deepEqual(Object.fromEntries(activeSelections(s.db)), {
      video: 'cond-video',
      image: 'good-image',
    });
    assert.equal(svc.selections().length, 3, 'history is kept');
    assert.equal(svc.selections().filter((x) => x.active).length, 2);
  });

  it('requires a connected worker to start, and MOCK_GENERATION=false for real models', async () => {
    await assert.rejects(
      svc.start({ models: [], includeMock: true, hourlyRateInr: 0 }),
      (e: AppError) => e.code === 'WORKER_UNAVAILABLE',
    );
    s.worker = {
      url: 'http://x',
      client: {} as never,
      connectedAt: '',
      version: '',
      system: {} as never,
      models: [{ ...models[0]!, loaded: false, default: true, device: 'cuda' } as never],
    };
    await assert.rejects(
      svc.start({ models: ['good-image'], includeMock: false, hourlyRateInr: 0 }),
      (e: AppError) => e.code === 'MOCK_MODE_REQUIRED',
    );
    await assert.rejects(
      svc.start({ models: ['ghost'], includeMock: false, hourlyRateInr: 0 }),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
  });
});
