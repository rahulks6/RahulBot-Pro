import { createHash } from 'node:crypto';
import { ERROR_CODES, type ErrorCode } from '../../lib/errors.ts';
import type { RunContext } from '../types.ts';
import { ProviderError } from '../types.ts';

export interface WorkerOutput {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  fps: number | null;
  native_resolution: boolean;
  mock: boolean;
}

export interface WorkerJob {
  id: string;
  kind: string;
  status: 'queued' | 'loading_model' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  model: { id?: string; version?: string; mock?: boolean };
  outputs: WorkerOutput[];
  metrics: Record<string, number>;
  error: { code: string; message: string } | null;
  logs: string[];
}

export interface WorkerModel {
  id: string;
  kind: 'image' | 'video' | 'tts' | 'music' | 'sfx' | 'lipsync' | 'upscale';
  display_name: string;
  version: string;
  license: string;
  min_vram_gb: number;
  device: 'cpu' | 'cuda';
  mock: boolean;
  loaded: boolean;
  default: boolean;
  commercial_use?: string;
  license_url?: string;
}

export interface WorkerSystem {
  worker_version: string;
  python: string;
  cpu_count: number;
  memory: { total_mb: number; available_mb: number };
  disk: { total_gb: number; free_gb: number };
  gpu: {
    available: boolean;
    reason?: string;
    cuda_version?: string | null;
    gpus: Array<{ name: string; vram_total_mb: number; vram_used_mb: number }>;
  };
  ffmpeg: { ffmpeg: string | null; ffprobe: string | null };
  mock_models: boolean;
  models: WorkerModel[];
  jobs: Record<string, number>;
}

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

function toCode(code: string | undefined): ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code ?? '') ? (code as ErrorCode) : 'INTERNAL';
}

/**
 * HTTP client for the Python AI worker (worker/). The bearer token stays in
 * this server-side process. Every downloaded output is verified against the
 * SHA-256 the worker reported, so a truncated transfer never becomes an asset.
 */
export class WorkerClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(opts: { baseUrl: string; token: string; timeoutSec?: number; pollMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = (opts.timeoutSec ?? 1800) * 1000;
    this.pollMs = opts.pollMs ?? 150;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ProviderError(
        'WORKER_UNAVAILABLE',
        `Worker unreachable at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
    if (res.status === 401)
      throw new ProviderError('FORBIDDEN', 'Worker rejected the auth token (check WORKER_AUTH_TOKEN)');
    return res;
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    const data = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (!res.ok) {
      const detail = data.error?.details ? ` ${JSON.stringify(data.error.details).slice(0, 300)}` : '';
      throw new ProviderError(
        toCode(data.error?.code),
        `Worker ${res.status}: ${data.error?.message ?? 'error'}${detail}`,
      );
    }
    return data;
  }

  async health(): Promise<{ status: string; version: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return (await res.json()) as { status: string; version: string };
    } catch (err) {
      throw new ProviderError(
        'WORKER_UNAVAILABLE',
        `Worker unreachable at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
  }

  async models(): Promise<WorkerModel[]> {
    return (await this.json<{ models: WorkerModel[] }>('GET', '/models')).models;
  }

  system(): Promise<WorkerSystem> {
    return this.json<WorkerSystem>('GET', '/system');
  }

  getJob(id: string): Promise<WorkerJob> {
    return this.json<WorkerJob>('GET', `/jobs/${encodeURIComponent(id)}`);
  }

  /** Start a benchmark job (Phase 3). Returns immediately; poll with getJob. */
  submitBenchmark(body: Record<string, unknown>): Promise<WorkerJob> {
    return this.json<WorkerJob>('POST', '/benchmarks', body);
  }

  cancel(id: string): Promise<WorkerJob> {
    return this.json<WorkerJob>('POST', `/jobs/${encodeURIComponent(id)}/cancel`);
  }

  async download(jobId: string, out: WorkerOutput): Promise<Buffer> {
    const res = await this.request(
      'GET',
      `/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(out.name)}`,
    );
    if (!res.ok) throw new ProviderError('DOWNLOAD_FAILED', `Download of ${out.name} failed (${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== out.sha256 || data.length !== out.size) {
      throw new ProviderError(
        'DOWNLOAD_FAILED',
        `Checksum mismatch for ${out.name}; the file was not stored`,
      );
    }
    return data;
  }

  /** Submit, poll until finished (cancelling on abort/timeout), then download and verify every output. */
  async run(
    path: string,
    body: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<{ job: WorkerJob; files: Array<{ meta: WorkerOutput; data: Buffer }> }> {
    let job = await this.json<WorkerJob>('POST', path, body);
    const deadline = Date.now() + this.timeoutMs;
    while (!TERMINAL.has(job.status)) {
      if (ctx.signal?.aborted || Date.now() > deadline) {
        await this.cancel(job.id).catch(() => undefined);
        throw new ProviderError(
          ctx.signal?.aborted ? 'CANCELLED' : 'API_TIMEOUT',
          `Worker job ${job.id} ${ctx.signal?.aborted ? 'cancelled' : 'timed out'}`,
        );
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
      job = await this.getJob(job.id);
    }
    if (job.status === 'cancelled')
      throw new ProviderError('CANCELLED', `Worker job ${job.id} was cancelled`);
    if (job.status === 'failed')
      throw new ProviderError(toCode(job.error?.code), `Worker: ${job.error?.message ?? 'job failed'}`);
    const files = [];
    for (const meta of job.outputs) files.push({ meta, data: await this.download(job.id, meta) });
    return { job, files };
  }
}
