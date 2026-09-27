import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { jobStageLabel } from '../src/domain/enums.ts';
import { encodePng } from '../src/media/png.ts';
import type { RunContext } from '../src/providers/types.ts';
import { WorkerClient, type WorkerJob, type WorkerModel } from '../src/providers/worker/client.ts';
import { WorkerImageModel } from '../src/providers/worker/providers.ts';
import { seedSmall, testStudio } from './helpers.ts';

/**
 * Queue progress comes from the worker (model loading, diffusion steps, encoding) and is shown as
 * plain stages. Nothing is estimated: a step that reports no progress shows no percentage.
 */
describe('job progress', () => {
  it('stage labels cover every queue status', () => {
    assert.equal(jobStageLabel('waiting'), 'QUEUED');
    assert.equal(jobStageLabel('provisioning_gpu'), 'STARTING');
    assert.equal(jobStageLabel('starting_worker'), 'STARTING');
    assert.equal(jobStageLabel('loading_model'), 'LOADING MODEL');
    assert.equal(jobStageLabel('generating_video'), 'GENERATING');
    assert.equal(jobStageLabel('upscaling'), 'UPSCALING');
    assert.equal(jobStageLabel('encoding'), 'ENCODING');
    assert.equal(jobStageLabel('downloading'), 'DOWNLOADING');
    assert.equal(jobStageLabel('complete'), 'SUCCEEDED');
    assert.equal(jobStageLabel('failed'), 'FAILED');
    assert.equal(jobStageLabel('cancelled'), 'CANCELLED');
  });

  it('the worker client reports each status change while polling', async () => {
    const states: Array<Partial<WorkerJob>> = [
      { status: 'queued', progress: 0, message: '' },
      { status: 'loading_model', progress: 0, message: 'loading sdxl-base' },
      { status: 'running', progress: 0.5, message: 'step 15/30' },
      { status: 'running', progress: 0.5, message: 'step 15/30' },
      { status: 'complete', progress: 1, message: '' },
    ];
    let n = 0;
    const server = createServer((req, res) => {
      const s = states[Math.min(n++, states.length - 1)]!;
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'job1', kind: 'image', outputs: [], logs: [], metrics: {}, ...s }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    after(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const client = new WorkerClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't', pollMs: 1 });
    const seen: string[] = [];
    const ctx: RunContext = {
      attemptKey: 'a',
      onProgress: (p) => seen.push(`${p.status}:${p.progress}:${p.message}`),
    };
    const { job } = await client.run('/generate/image', {}, ctx);
    assert.equal(job.status, 'complete');
    assert.deepEqual(seen, ['queued:0:', 'loading_model:0:loading sdxl-base', 'running:0.5:step 15/30']);
  });

  it('generation jobs follow the worker: LOADING MODEL → GENERATING with measured progress → SUCCEEDED', async () => {
    const s = testStudio({ env: { mockGeneration: false } });
    after(() => s.cleanup());
    // The provider is injected directly below: no execution router (no RunPod, no local worker).
    s.settings.set('execution', { ...s.settings.get('execution'), mode: 'mock' });
    const { shots } = seedSmall(s);
    const snapshots: Array<{ status: string; progress: number; detail: string }> = [];
    const snap = (id: string) => {
      const j = s.jobs.get(id);
      snapshots.push({ status: j.status, progress: j.progress, detail: j.status_detail });
    };
    let jobId = '';
    const client = {
      run: async (_path: string, _body: Record<string, unknown>, ctx: RunContext) => {
        ctx.onProgress?.({ status: 'queued', progress: 0, message: '' });
        snap(jobId);
        ctx.onProgress?.({ status: 'loading_model', progress: 0, message: 'loading sdxl-base' });
        snap(jobId);
        ctx.onProgress?.({ status: 'running', progress: 0.4, message: 'step 12/30' });
        snap(jobId);
        const data = encodePng(64, 36, () => [10, 20, 30]);
        return {
          job: {
            id: 'w1',
            status: 'complete',
            progress: 1,
            message: '',
            model: { id: 'sdxl-base', version: 'main', mock: false },
            outputs: [],
            metrics: {},
            error: null,
            logs: [],
          },
          files: [
            {
              meta: {
                name: 'image.png',
                mime: 'image/png',
                size: data.length,
                sha256: '',
                width: 64,
                height: 36,
                duration_sec: null,
                fps: null,
                native_resolution: false,
                mock: false,
              },
              data,
            },
          ],
        };
      },
    } as unknown as WorkerClient;
    const model: WorkerModel = {
      id: 'sdxl-base',
      kind: 'image',
      display_name: 'SDXL',
      version: 'main',
      license: 'test',
      min_vram_gb: 8,
      device: 'cuda',
      mock: false,
      loaded: false,
      default: true,
    };
    s.providers.image = new WorkerImageModel(client, model);
    jobId = s.generation.queueImage(shots[0]!.id, { mode: 'fast_preview' }).id;
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1, r.messages.join(' '));
    assert.deepEqual(snapshots, [
      { status: 'generating_image', progress: 0, detail: '' },
      { status: 'loading_model', progress: 0, detail: 'loading sdxl-base' },
      { status: 'generating_image', progress: 0.4, detail: 'step 12/30' },
    ]);
    const done = s.jobs.get(jobId);
    assert.equal(done.status, 'complete');
    assert.equal(done.progress, 1);
    assert.ok(
      s.jobs.log(done).some((l) => l.status === 'loading_model'),
      'model loading is in the job log',
    );
  });
});
