import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { AppEnv } from '../src/config/env.ts';
import { appRoot } from '../src/lib/paths.ts';
import { Logger } from '../src/lib/logger.ts';
import { CloudGpuProvider, effectiveWorkerImage } from '../src/providers/cloud/gpu-provider.ts';
import type { CloudGpuApi, CloudPodSpec } from '../src/providers/cloud/types.ts';
import { BOOTSTRAP_ENTRYPOINT, bootstrapScript, workerBundle } from '../src/providers/cloud/worker-bundle.ts';
import { SecretStore } from '../src/services/secrets.ts';
import { DEFAULT_SETTINGS } from '../src/services/settings.ts';

/**
 * Zero-manual-infra: a pod starts from a public PyTorch image and the app sends its own worker code.
 * Here the "pod" is the real bootstrap script started with the exact entrypoint the app gives
 * RunPod; the real CloudGpuProvider uploads the real archive and waits for the real worker. The
 * test machine has no NVIDIA GPU, so the run must end with the worker's own "no usable GPU"
 * answer — proof that the handover to the worker happened. Library installation is skipped
 * (offline); on RunPod the pinned libraries install on first use.
 */
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const workerDir = join(appRoot(), 'worker');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe(
  'worker bootstrap (no image to build or publish)',
  { skip: !python && 'Python not installed' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ais-boot-'));
    const procs: ChildProcess[] = [];
    after(() => {
      for (const p of procs) p.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    });
    const env = { cloudWorkerImage: '' } as AppEnv;
    const cloud = { ...DEFAULT_SETTINGS.cloud };
    const secrets = new SecretStore(dir, {});
    const logger = new Logger('error', []);

    function provider(api: Partial<CloudGpuApi>): CloudGpuProvider {
      return new CloudGpuProvider({
        api: () => ({ displayName: 'RunPod', ...api }) as CloudGpuApi,
        providerId: 'runpod',
        secrets,
        installId: 'test1234',
        env,
        logger,
        cloud: () => cloud,
        gpu: () => DEFAULT_SETTINGS.gpu,
        limits: () => ({ idleMinutes: 10, maxLifetimeMinutes: 60 }),
        pollMs: 50,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))),
        workerDir,
      });
    }

    it('by default a pod runs the public PyTorch image with the bootstrap and the code checksum', async () => {
      assert.equal(effectiveWorkerImage(env, cloud), 'pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime');
      let spec: CloudPodSpec | null = null;
      const p = provider({
        createPod: async (s: CloudPodSpec) => {
          spec = s;
          return {
            id: 'pod-a',
            name: s.name,
            state: 'starting',
            rawStatus: 'CREATED',
            hourlyUsd: 0.5,
            gpuName: null,
            createdAt: null,
          };
        },
      });
      await p.provision(
        {
          offerId: 'NVIDIA RTX 4090',
          gpuModel: 'RTX 4090',
          vramGb: 24,
          hourlyRateInr: 60,
          available: true,
          region: 'x',
        },
        ['ai-story-studio'],
      );
      const s = spec as unknown as CloudPodSpec;
      assert.equal(s.image, 'pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime');
      assert.deepEqual(s.entrypoint, BOOTSTRAP_ENTRYPOINT);
      assert.equal(s.registryAuthId, undefined, 'no registry credential needed');
      assert.equal(s.env['AIS_CODE_SHA256'], workerBundle(workerDir).sha256);
      assert.equal(s.env['AIS_BOOTSTRAP'], bootstrapScript(workerDir));
      assert.ok(s.env['WORKER_AUTH_TOKEN']?.startsWith('aisw_'));
      assert.equal(secrets.workerToken('pod-a'), s.env['WORKER_AUTH_TOKEN']);
      // The prebuilt-image path is still available (Advanced).
      assert.equal(effectiveWorkerImage(env, { ...cloud, workerSource: 'image' }), cloud.workerImage);
    });

    it('the archive is deterministic and holds exactly the worker code', () => {
      const a = workerBundle(workerDir);
      assert.ok(a.files > 20 && a.data.length < 2 * 1024 * 1024, `${a.files} files, ${a.data.length} bytes`);
      const list = spawnSync('tar', ['-tzf', '-'], { input: a.data })
        .stdout.toString()
        .split('\n')
        .filter(Boolean);
      assert.ok(list.includes('ais_worker/server.py') && list.includes('models.cloud.json'));
      assert.ok(list.includes('requirements-cloud.txt'));
      assert.ok(!list.some((f) => f.includes('__pycache__') || f.startsWith('tests/')), 'no tests or caches');
    });

    it('the provider sends the code to a real bootstrap process and reaches the real worker', async () => {
      const port = await freePort();
      const token = SecretStore.newWorkerToken();
      secrets.saveWorkerToken('pod-b', token);
      const pod = mkdtempSync(join(dir, 'pod-'));
      const bundle = workerBundle(workerDir);
      const proc = spawn(python!, BOOTSTRAP_ENTRYPOINT.slice(1), {
        cwd: pod,
        env: {
          PATH: process.env['PATH'] ?? '',
          AIS_BOOTSTRAP: bootstrapScript(workerDir),
          AIS_CODE_SHA256: bundle.sha256,
          AIS_APP_DIR: join(pod, 'app'),
          AIS_PYENV_ROOT: join(pod, 'pyenv'),
          AIS_BOOTSTRAP_SKIP_SYSTEM: '1',
          AIS_BOOTSTRAP_SKIP_PIP: '1',
          WORKER_AUTH_TOKEN: token,
          WORKER_HOST: '127.0.0.1',
          WORKER_PORT: String(port),
          WORKER_DATA_DIR: join(pod, 'worker-data'),
          WORKER_MODEL_CACHE_DIR: join(pod, 'models'),
          HF_HOME: join(pod, 'hf'),
          HF_HUB_OFFLINE: '1',
          WORKER_MOCK_MODELS: 'false',
        },
        stdio: 'ignore',
      });
      procs.push(proc);
      const states: string[] = [];
      const p = provider({
        getPod: async () => ({
          id: 'pod-b',
          name: 'ais-test1234-b',
          state: 'running',
          rawStatus: 'RUNNING',
          hourlyUsd: 0.5,
          gpuName: 'RTX 4090',
          createdAt: null,
        }),
        workerUrl: () => `http://127.0.0.1:${port}`,
      });
      await assert.rejects(
        p.awaitReady('pod-b', { timeoutMs: 60_000, onState: (_s, d) => states.push(d) }),
        (err: Error) => /no usable NVIDIA GPU/.test(err.message),
        'the real worker answered (this test machine has no GPU)',
      );
      assert.ok(
        states.some((s) => /sending the AI worker code/.test(s)),
        states.join(' | '),
      );
      assert.equal(proc.exitCode, null, 'the pod process is now the worker');
    });
  },
);
