import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { after, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

/**
 * ExecutionRouter: MOCK / LOCAL GPU / CLOUD GPU. LOCAL GPU starts the REAL Python worker process
 * (no GPU, PyTorch or model weights in this test environment), so real jobs fail with an
 * actionable reason — they must never fall back to mock placeholders or touch the cloud.
 */
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function narrationJob(s: TestStudio): string {
  const { story } = seedSmall(s);
  const scene = s.stories.listScenes(story.id)[0]!;
  const line = s.stories.listNarration(scene.id)[0]!;
  return s.generation.queueNarrationAudio(line.id).id;
}

describe('execution router', () => {
  const studios: TestStudio[] = [];
  const make = (opts: Parameters<typeof testStudio>[0] = {}): TestStudio => {
    const s = testStudio(opts);
    studios.push(s);
    return s;
  };
  after(async () => {
    for (const s of studios) {
      await s.router.shutdown();
      s.cleanup();
    }
  });

  it('MOCK is the default and always ready', async () => {
    const s = make();
    const st = await s.router.apply();
    assert.deepEqual([st.requested, st.active, st.ready], ['mock', 'mock', true]);
    assert.equal(s.providers.image.info.isMock, true);
  });

  it('MOCK_GENERATION=true locks MOCK: the local worker is never started', async () => {
    let spawned = 0;
    const s = make({
      localWorker: {
        spawnFn: (() => {
          spawned++;
          throw new Error('must not spawn');
        }) as never,
      },
    });
    s.settings.set('execution', { ...s.settings.get('execution'), mode: 'local_gpu' });
    const st = await s.router.apply();
    assert.equal(st.requested, 'mock');
    assert.equal(st.lockedByEnv, true);
    assert.equal(st.active, 'mock');
    assert.equal(spawned, 0);
  });

  it('LOCAL GPU without Python is reported clearly and never falls back to mock', async () => {
    const s = make({ env: { mockGeneration: false }, localWorker: { findPythonFn: async () => null } });
    s.settings.set('execution', { ...s.settings.get('execution'), mode: 'local_gpu' });
    const st = await s.router.apply();
    assert.equal(st.ready, false);
    assert.match(st.problems.join(' '), /Python was not found/);
    const job = narrationJob(s);
    await assert.rejects(s.generation.processQueue(), (e: AppError) => {
      assert.equal(e.code, 'WORKER_UNAVAILABLE');
      assert.match(e.message, /LOCAL GPU mode is selected but cannot run: Python was not found/);
      return true;
    });
    assert.equal(s.jobs.get(job).status, 'waiting', 'the job stays queued');
    assert.equal(s.assets.list({}).length, 0, 'no placeholder was produced');
  });

  it(
    'LOCAL GPU runs the real worker; real jobs fail with an actionable reason, never mock, never cloud',
    { skip: python ? false : 'python3 not installed' },
    async () => {
      const s = make({
        env: { mockGeneration: false, enableCloudGpu: true },
        secretEnv: { RUNPOD_API_KEY: 'rpa_TESTONLY0123456789abcdef' },
      });
      // Even with every other cloud permission given, LOCAL GPU must not use the cloud GPU.
      s.settings.set('cloud', { ...s.settings.get('cloud'), cloudEnabled: true, realGeneration: true });
      s.settings.set('execution', {
        ...s.settings.get('execution'),
        mode: 'local_gpu',
        localWorkerPort: await freePort(),
      });
      const st = await s.router.apply();
      assert.equal(st.active, 'local_gpu', st.problems.join(' '));
      assert.equal(st.ready, true);
      assert.equal(s.router.localWorker.status().state, 'running');
      assert.equal(s.gpu.currentProvider.id, 'local-worker');
      assert.equal(s.gpu.currentProvider.paid, false);
      assert.equal(s.cloud.canProvision(), false, 'cloud gates fail outside CLOUD GPU mode');
      assert.equal(s.providers.tts.info.isMock, false, 'real TTS model from the local catalog');
      assert.equal(s.providers.tts.info.id, 'kokoro-82m');
      assert.equal(s.providers.image.info.isMock, false);

      const job = narrationJob(s);
      const r = await s.generation.processQueue();
      assert.equal(r.failed, 1);
      const j = s.jobs.get(job);
      assert.equal(j.status, 'failed');
      // No weights / packages here: the reason names what is missing and how to fix it.
      assert.match(j.error_message ?? '', /kokoro|not installed|missing dependency|Model Manager/i);
      assert.equal(s.assets.list({}).length, 0, 'no mock placeholder was substituted');
      assert.equal(s.gpuRepo.list().filter((g) => g.provider !== 'local-worker').length, 0);

      // Back to MOCK: worker stopped, placeholders work again.
      s.settings.set('execution', { ...s.settings.get('execution'), mode: 'mock' });
      const back = await s.router.apply();
      assert.deepEqual([back.active, back.ready], ['mock', true]);
      assert.equal(s.router.localWorker.status().state, 'stopped');
      assert.equal(s.providers.tts.info.isMock, true);
    },
  );

  it('the worker process gets the local catalog, the model folder and downloads switched off', () => {
    const s = make();
    const env = s.router.localWorker.processEnv('t'.repeat(64), 8765);
    assert.equal(env['HF_HUB_OFFLINE'], '1', 'generation never downloads');
    assert.equal(env['WORKER_MOCK_MODELS'], 'false');
    assert.match(env['WORKER_MODELS_FILE']!, /models\.local\.json$/);
    assert.equal(env['HF_HUB_CACHE'], env['WORKER_MODEL_CACHE_DIR'], 'all weights in MODEL_CACHE_PATH');
    assert.equal(env['WORKER_HOST'], '127.0.0.1');
    assert.equal(env['RUNPOD_API_KEY'], undefined, 'no cloud key in the local worker');
    assert.equal(env['AIS_PARENT_PID'], String(process.pid), 'the worker exits if the app dies');
  });
});
