import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodePng } from '../../src/media/png.ts';
import { encodeWav } from '../../src/media/wav.ts';
import type { MockRunPod } from './mock-runpod.ts';

interface FakeJob {
  id: string;
  kind: string;
  status: string;
  pollsLeft: number;
  outputs: Array<{ name: string; mime: string; data: Buffer }>;
  cancelled: boolean;
}

/**
 * Fake cloud AI worker for tests: reachable as `…/w/{podId}`, it authenticates
 * each request with the WORKER_AUTH_TOKEN that the app put in that pod's
 * environment at the mock RunPod — exactly like the real worker on a pod.
 * It reports REAL (non-mock) models and returns small but valid WAV / PNG files.
 */
export class FakeCloudWorker {
  server!: Server;
  port = 0;
  jobs = new Map<string, FakeJob>();
  submitted: Array<{ podId: string; path: string; body: Record<string, unknown> }> = [];
  cancels: string[] = [];
  /** Answer /health with 503 this many times (worker still starting). */
  unhealthyFor = 0;
  /** Never become healthy (startup timeout). */
  neverHealthy = false;
  /** /health answers {ready: false} this many times first (worker process up, not yet accepting jobs). */
  notReadyFor = 0;
  /** Simulate a machine without a usable NVIDIA GPU. */
  noGpu = false;
  /** Simulate a GPU that PyTorch cannot use (CUDA/driver mismatch). */
  torchNoCuda = false;
  /** Corrupt the next N downloads (flip a byte). */
  corruptDownloads = 0;
  /** Jobs stay running this many polls. */
  jobPolls = 0;
  private seq = 0;
  private readonly runpod: MockRunPod;

  constructor(runpod: MockRunPod) {
    this.runpod = runpod;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }

  /** Proxy template the app uses instead of https://{podId}-{port}.proxy.runpod.net */
  get template(): string {
    return `http://127.0.0.1:${this.port}/w/{podId}`;
  }

  generateCount(): number {
    return this.submitted.length;
  }

  private output(kind: string): { name: string; mime: string; data: Buffer } {
    if (kind === 'image')
      return { name: 'image.png', mime: 'image/png', data: encodePng(64, 64, (x, y) => [x * 4, y * 4, 120]) };
    const sr = 24000;
    const samples = Float32Array.from({ length: sr }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr));
    return { name: 'audio.wav', mime: 'audio/wav', data: encodeWav({ sampleRate: sr, samples }) };
  }

  private public(job: FakeJob): unknown {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.status === 'complete' ? 1 : 0.5,
      message: '',
      model: { id: job.kind === 'image' ? 'flux1-schnell' : 'kokoro-82m', version: 'main', mock: false },
      outputs:
        job.status === 'complete'
          ? job.outputs.map((o) => ({
              name: o.name,
              mime: o.mime,
              size: o.data.length,
              sha256: createHash('sha256').update(o.data).digest('hex'),
              width: null,
              height: null,
              duration_sec: null,
              fps: null,
              native_resolution: true,
              mock: false,
            }))
          : [],
      metrics: { run_seconds: 1.5 },
      error: null,
      logs: ['fake cloud worker'],
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const m = /^\/w\/([^/]+)(\/.*)$/.exec(req.url ?? '');
    if (!m) return send(404, { error: 'no pod route' });
    const podId = decodeURIComponent(m[1]!);
    const path = m[2]!;
    const pod = this.runpod.pods.get(podId);
    if (!pod || pod.status !== 'RUNNING') return send(502, { error: 'pod not running' });
    if (path === '/health') {
      if (this.neverHealthy || this.unhealthyFor-- > 0) return send(503, { error: 'starting' });
      if (this.notReadyFor-- > 0) return send(200, { status: 'ok', version: '1.1.0-fake', ready: false });
      return send(200, { status: 'ok', version: '1.1.0-fake', ready: true });
    }
    if (req.headers.authorization !== `Bearer ${pod.env['WORKER_AUTH_TOKEN']}`)
      return send(401, { error: { code: 'FORBIDDEN', message: 'invalid token' } });
    if (path === '/system')
      return send(200, {
        worker_version: '1.1.0-fake',
        gpu: this.noGpu
          ? { available: false, reason: 'nvidia-smi not found', gpus: [] }
          : {
              available: true,
              cuda_version: '12.6',
              gpus: [{ name: 'NVIDIA RTX A5000', vram_total_mb: 24564, vram_used_mb: 0 }],
            },
        torch: {
          installed: true,
          version: '2.7.1+cu126',
          cuda_available: !this.torchNoCuda && !this.noGpu,
          device: this.noGpu ? null : 'NVIDIA RTX A5000',
        },
        mock_models: false,
        models: [],
        jobs: {},
      });
    if (path === '/models')
      return send(200, {
        models: [
          {
            id: 'kokoro-82m',
            kind: 'tts',
            display_name: 'Kokoro 82M',
            version: 'main',
            license: 'Apache-2.0',
            min_vram_gb: 0,
            device: 'cpu',
            mock: false,
            loaded: false,
            default: true,
            cached: true,
          },
          {
            id: 'flux1-schnell',
            kind: 'image',
            display_name: 'FLUX.1 [schnell]',
            version: 'main',
            license: 'Apache-2.0',
            min_vram_gb: 24,
            device: 'cuda',
            mock: false,
            loaded: false,
            default: true,
            cached: false,
          },
        ],
      });
    let jm = /^\/generate\/(audio|image)$/.exec(path);
    if (jm && req.method === 'POST') {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      this.submitted.push({ podId, path, body });
      const id = `job${++this.seq}`;
      const kind = jm[1] === 'image' ? 'image' : 'audio';
      const job: FakeJob = {
        id,
        kind,
        status: this.jobPolls ? 'running' : 'complete',
        pollsLeft: this.jobPolls,
        outputs: [this.output(kind)],
        cancelled: false,
      };
      this.jobs.set(id, job);
      return send(202, this.public(job));
    }
    jm = /^\/jobs\/([^/]+)$/.exec(path);
    if (jm && req.method === 'GET') {
      const job = this.jobs.get(jm[1]!);
      if (!job) return send(404, { error: { code: 'NOT_FOUND', message: 'no job' } });
      if (job.status === 'running' && job.pollsLeft-- <= 0) job.status = 'complete';
      return send(200, this.public(job));
    }
    jm = /^\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (jm && req.method === 'POST') {
      const job = this.jobs.get(jm[1]!);
      if (!job) return send(404, { error: { code: 'NOT_FOUND', message: 'no job' } });
      job.status = 'cancelled';
      this.cancels.push(job.id);
      return send(200, this.public(job));
    }
    jm = /^\/jobs\/([^/]+)\/files\/([^/]+)$/.exec(path);
    if (jm && req.method === 'GET') {
      const job = this.jobs.get(jm[1]!);
      const out = job?.outputs.find((o) => o.name === jm![2]);
      if (!out) return send(404, { error: { code: 'NOT_FOUND', message: 'no file' } });
      let data = out.data;
      if (this.corruptDownloads > 0) {
        this.corruptDownloads--;
        data = Buffer.from(data);
        data[data.length - 1] = data[data.length - 1]! ^ 0xff;
      }
      res.writeHead(200, { 'Content-Type': out.mime, 'Content-Length': String(data.length) });
      res.end(data);
      return;
    }
    send(404, { error: 'no route' });
  }
}
