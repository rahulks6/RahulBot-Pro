import { ERROR_CODES, type ErrorCode } from '../../lib/errors.ts';
import type { RunContext } from '../types.ts';
import { ProviderError } from '../types.ts';
import { validateDownload, type ValidationOptions } from './validate.ts';

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
  status: 'queued' | 'loading_model' | 'running' | 'encoding' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  model: { id?: string; version?: string; mock?: boolean };
  outputs: WorkerOutput[];
  metrics: Record<string, number>;
  error: { code: string; message: string } | null;
  logs: string[];
  /** Worker decisions: memory plan, effective parameters, reference mode (worker 1.2+). */
  details?: Record<string, unknown>;
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
  capabilities?: string[];
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
  /** Whether PyTorch itself can use CUDA (worker 1.1.0+). */
  torch?: {
    installed: boolean;
    version: string | null;
    cuda_available: boolean;
    cuda_runtime?: string | null;
    device: string | null;
    error?: string;
  };
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
  private readonly maxPollMs: number;
  private readonly downloadAttempts: number;
  private readonly validation: ValidationOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    baseUrl: string;
    token: string;
    timeoutSec?: number;
    /** First poll interval; grows ×1.5 up to maxPollMs (cloud workers are polled gently). */
    pollMs?: number;
    maxPollMs?: number;
    downloadAttempts?: number;
    validation?: ValidationOptions;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = (opts.timeoutSec ?? 1800) * 1000;
    this.pollMs = opts.pollMs ?? 150;
    this.maxPollMs = opts.maxPollMs ?? this.pollMs;
    this.downloadAttempts = Math.max(1, opts.downloadAttempts ?? 3);
    this.validation = opts.validation ?? {};
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
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

  /** Unauthenticated liveness + readiness. `ready: false` (starting or shutting down) counts as not healthy. */
  async health(): Promise<{ status: string; version: string; ready?: boolean }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`health check returned HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; version: string; ready?: boolean };
      if (body.status !== 'ok' || body.ready === false) throw new Error('worker is not ready yet');
      return body;
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

  /**
   * Download one output and validate it (size, SHA-256, real file type,
   * minimum size, decodability; ffprobe for video when configured). Network
   * errors, 5xx and corrupted transfers are retried with backoff; a file that
   * keeps failing validation is discarded and never becomes an asset.
   */
  async download(jobId: string, out: WorkerOutput): Promise<Buffer> {
    let last: ProviderError | undefined;
    for (let attempt = 1; attempt <= this.downloadAttempts; attempt++) {
      if (attempt > 1) await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 2)));
      let res: Response;
      try {
        res = await this.request(
          'GET',
          `/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(out.name)}`,
          undefined,
          10 * 60_000,
        );
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'FORBIDDEN') throw err;
        last = err instanceof ProviderError ? err : new ProviderError('DOWNLOAD_FAILED', String(err));
        continue; // network error: retry
      }
      if (!res.ok) {
        last = new ProviderError('DOWNLOAD_FAILED', `Download of ${out.name} failed (HTTP ${res.status})`);
        if (res.status < 500 && res.status !== 429) throw last; // permanent (e.g. 404)
        continue;
      }
      let data: Buffer;
      try {
        data = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        last = new ProviderError(
          'DOWNLOAD_FAILED',
          `Download of ${out.name} was interrupted: ${(err as Error).message}`,
        );
        continue;
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 0 && declared !== data.length) {
        last = new ProviderError(
          'DOWNLOAD_FAILED',
          `Download of ${out.name} was cut off (${data.length}/${declared} bytes)`,
        );
        continue;
      }
      try {
        await validateDownload(out, data, this.validation);
        return data;
      } catch (err) {
        last = err as ProviderError; // corrupted transfer: fetch again
      }
    }
    throw last ?? new ProviderError('DOWNLOAD_FAILED', `Download of ${out.name} failed`);
  }

  /** Submit, poll until finished (cancelling on abort/timeout), then download and verify every output. */
  async run(
    path: string,
    body: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<{ job: WorkerJob; files: Array<{ meta: WorkerOutput; data: Buffer }> }> {
    let job: WorkerJob | undefined;
    const resume = ctx.remote?.resumeJobId;
    if (resume) {
      // After a restart: re-check the job we already paid for instead of generating it again.
      job = await this.getJob(resume).catch(() => undefined);
    }
    if (!job) {
      job = await this.json<WorkerJob>('POST', path, body);
      ctx.remote?.onSubmitted?.(job.id);
    }
    const deadline = Date.now() + this.timeoutMs;
    let pollDelay = this.pollMs;
    let last = '';
    while (!TERMINAL.has(job.status)) {
      const now = `${job.status}|${job.progress}|${job.message}`;
      if (now !== last) {
        last = now;
        ctx.onProgress?.({ status: job.status, progress: job.progress, message: job.message });
      }
      if (ctx.remote?.isCancelled?.()) {
        await this.cancel(job.id).catch(() => undefined);
        throw new ProviderError('CANCELLED', `Worker job ${job.id} cancelled by the user`);
      }
      if (ctx.signal?.aborted || Date.now() > deadline) {
        await this.cancel(job.id).catch(() => undefined);
        throw new ProviderError(
          ctx.signal?.aborted ? 'CANCELLED' : 'API_TIMEOUT',
          `Worker job ${job.id} ${ctx.signal?.aborted ? 'cancelled' : 'timed out'}`,
        );
      }
      await this.sleep(pollDelay);
      pollDelay = Math.min(this.maxPollMs, Math.round(pollDelay * 1.5));
      job = await this.getJob(job.id);
    }
    if (job.status === 'cancelled')
      throw new ProviderError('CANCELLED', `Worker job ${job.id} was cancelled`);
    if (job.status === 'failed')
      throw new ProviderError(toCode(job.error?.code), `Worker: ${job.error?.message ?? 'job failed'}`);
    ctx.remote?.onDownloading?.();
    const files = [];
    for (const meta of job.outputs) files.push({ meta, data: await this.download(job.id, meta) });
    return { job, files };
  }
}
