import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { appRoot } from '../src/lib/paths.ts';
import { connectWorker } from '../src/providers/worker/connect.ts';
import { BenchmarkService } from '../src/services/benchmarks.ts';
import { produceShots, seedSmall, testStudio } from './helpers.ts';

const TOKEN = 'integration-test-token-0123456789';
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

/** End-to-end: TypeScript app ↔ real Python worker process (mock models, local only, ₹0). */
describe('local Python worker integration', { skip: python ? false : 'python3 not installed' }, () => {
  let proc: ChildProcess | undefined;
  let url = '';
  const dataDir = mkdtempSync(join(tmpdir(), 'ais-worker-'));

  before(async () => {
    proc = spawn(python!, ['-m', 'ais_worker'], {
      cwd: join(appRoot(), 'worker'),
      env: {
        ...process.env,
        WORKER_AUTH_TOKEN: TOKEN,
        WORKER_DATA_DIR: dataDir,
        WORKER_PORT: '0',
        WORKER_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`worker did not start: ${buf}`)), 15_000);
      proc!.stderr!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      proc!.on('exit', (code) => reject(new Error(`worker exited (${code}): ${buf}`)));
    });
  });

  after(() => {
    proc?.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a wrong token', async () => {
    const s = testStudio({ env: { workerUrl: url, workerToken: 'x'.repeat(30) } });
    try {
      await assert.rejects(connectWorker(s), (e: AppError) => e.code === 'FORBIDDEN');
      assert.equal(s.worker, null);
    } finally {
      s.cleanup();
    }
  });

  it('produces an episode through the worker: images, clips, audio, lip sync, BUILD FINAL', async () => {
    const s = testStudio({ env: { workerUrl: url, workerToken: TOKEN } });
    try {
      const conn = await connectWorker(s);
      assert.ok(conn.models.length >= 7 && conn.models.every((m) => m.mock), 'worker runs mock models only');
      assert.equal(s.providers.image.info.id, 'mock-image');
      assert.equal(s.gpu.currentProvider.id, 'local-worker');

      const { story, shots } = seedSmall(s);
      for (const sh of shots)
        s.stories.updateShot(sh.id, { generation_mode: 'fast_preview', duration_sec: 1.5 });
      await produceShots(s, story.id);
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'complete', exp.error_message ?? '');

      const clip = s.assets.get(s.stories.getShot(shots[0]!.id).approved_video_asset_id!);
      const ffmpeg = conn.system.ffmpeg.ffmpeg !== null;
      assert.equal(clip.mime, ffmpeg ? 'video/mp4' : 'application/vnd.ai-story-studio.mock-video+json');
      assert.equal(clip.is_native_resolution, 0, 'fast preview output is upscaled, never labelled native');
      assert.equal(clip.width, 1920);
      const original = s.assets.get(clip.source_asset_id!);
      assert.equal(original.width, 480);
      assert.ok(await s.storage.exists(original.storage_key));
      assert.ok(
        s.stories.getShot(shots[0]!.id).lipsync_video_asset_id,
        'visible speaker lip-synced by the worker',
      );

      const attempt = s.jobs.attemptsForShot(shots[0]!.id, 'video')[0]!;
      assert.match(attempt.settings_json, /workerJob/);
      assert.equal(attempt.estimated_cost_inr, 0, 'local worker costs nothing');
      const gpus = s.gpuRepo.list();
      assert.ok(
        gpus.length > 0 &&
          gpus.every(
            (g) => g.provider === 'local-worker' && g.status === 'terminated' && g.hourly_rate_inr === 0,
          ),
      );
    } finally {
      s.cleanup();
    }
  });

  it('benchmarks worker models, imports verified outputs and applies a human selection', async () => {
    const s = testStudio({ env: { workerUrl: url, workerToken: TOKEN } });
    try {
      const conn = await connectWorker(s);
      const ffmpeg = conn.system.ffmpeg.ffmpeg !== null;
      const svc = new BenchmarkService(s);
      const run = await svc.start({
        models: ['mock-image', 'mock-tts', 'mock-upscaler', ...(ffmpeg ? ['mock-video'] : [])],
        includeMock: true,
        hourlyRateInr: 46,
      });
      let current = run;
      for (let i = 0; i < 200 && current.status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        current = await svc.refresh(run.id);
      }
      assert.equal(current.status, 'complete', current.error_message ?? '');
      const results = svc.results(run.id);
      assert.ok(results.length >= 10);
      const image = results.find((x) => x.kind === 'image' && x.status === 'complete')!;
      assert.ok(image.storage_key && (await s.storage.exists(image.storage_key)), 'outputs stored locally');
      svc.rate(image.id, { quality: 4, consistency: 4 });
      const agg = svc.aggregate(run.id).find((a) => a.model.id === 'mock-image')!;
      assert.equal(agg.avgQuality, 4);
      assert.equal(agg.reproducible, true);
      svc.select({
        runId: run.id,
        modelId: 'mock-image',
        rationale: 'pipeline smoke test',
        licenseAcknowledged: false,
      });
      await connectWorker(s);
      assert.equal(s.providers.image.info.id, 'mock-image', 'selection applied on reconnect');
    } finally {
      s.cleanup();
    }
  });

  it('keeps refusing non-mock worker models while MOCK_GENERATION=true', async () => {
    const s = testStudio({ env: { workerUrl: url, workerToken: TOKEN } });
    try {
      await connectWorker(s);
      Object.defineProperty(s.providers.image, 'info', {
        value: { ...s.providers.image.info, isMock: false },
      });
      const { shots } = seedSmall(s);
      s.generation.queueImage(shots[0]!.id);
      await assert.rejects(s.generation.processQueue(), (e: AppError) => e.code === 'MOCK_MODE_REQUIRED');
    } finally {
      s.cleanup();
    }
  });
});
