import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEnv } from '../config/env.ts';
import { storagePaths } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { redact } from '../lib/logger.ts';
import { appRoot } from '../lib/paths.ts';
import type { FfmpegTools } from '../media/ffmpeg.ts';
import { findPython, pythonSupported, type PythonRuntime } from './python-runtime.ts';

/**
 * Starts and stops the local Python AI worker for LOCAL GPU mode, so nobody has
 * to open a terminal. Each start gets a fresh random token (kept in memory only,
 * never logged). Model downloads are OFF for generation jobs (HF_HUB_OFFLINE=1):
 * weights are only ever fetched by an explicit, confirmed Model Manager install.
 */
export type LocalWorkerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface LocalWorkerStatus {
  state: LocalWorkerState;
  url: string | null;
  pid: number | null;
  startedAt: string | null;
  python: PythonRuntime | null;
  error: string | null;
  logPath: string;
  /** Last lines of the worker's output (for the UI when it fails). */
  tail: string[];
}

export interface LocalWorkerDeps {
  env: AppEnv;
  logger: Logger;
  ffmpeg: FfmpegTools | null;
  /** WORKER_ENABLED_MODELS / WORKER_LICENSE_ACK for the local catalog. */
  modelEnv: () => Record<string, string>;
  port: () => number;
  workerDir?: string;
  catalogPath?: string;
  /** Tests: replace process spawning / Python discovery. */
  spawnFn?: typeof spawn;
  findPythonFn?: typeof findPython;
  startTimeoutMs?: number;
}

export class LocalWorkerManager {
  private readonly d: LocalWorkerDeps;
  private proc: ChildProcess | null = null;
  private token: string | null = null;
  private status_: LocalWorkerStatus;
  private starting: Promise<{ url: string; token: string }> | null = null;
  private lines: string[] = [];
  /** True while the process was started by us (the app stops it on exit). */
  managed = false;

  constructor(deps: LocalWorkerDeps) {
    this.d = deps;
    this.status_ = {
      state: 'stopped',
      url: null,
      pid: null,
      startedAt: null,
      python: null,
      error: null,
      logPath: join(deps.env.dataDir, 'logs', 'worker.log'),
      tail: [],
    };
  }

  get workerDir(): string {
    return this.d.workerDir ?? join(appRoot(), 'worker');
  }

  get catalogPath(): string {
    return this.d.catalogPath ?? join(this.workerDir, 'models.local.json');
  }

  status(): LocalWorkerStatus {
    return { ...this.status_, tail: this.lines.slice(-15) };
  }

  /** URL + token of the running worker (the token never leaves the app process). */
  endpoint(): { url: string; token: string } | null {
    return this.status_.state === 'running' && this.status_.url && this.token
      ? { url: this.status_.url, token: this.token }
      : null;
  }

  /** Environment of the worker process: local catalog, model cache on the configured drive, downloads off. */
  processEnv(token: string, port: number): NodeJS.ProcessEnv {
    const paths = storagePaths(this.d.env);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKER_AUTH_TOKEN: token,
      WORKER_HOST: '127.0.0.1',
      WORKER_PORT: String(port),
      WORKER_DATA_DIR: join(this.d.env.dataDir, 'worker'),
      WORKER_MOCK_MODELS: 'false',
      WORKER_MODELS_FILE: this.catalogPath,
      WORKER_MODEL_CACHE_DIR: paths.modelCache,
      // All model weights (diffusers, Kokoro, …) live in MODEL_CACHE_PATH, e.g. your SSD.
      HF_HUB_CACHE: paths.modelCache,
      HF_HOME: join(paths.modelCache, '.hf-home'),
      TORCH_HOME: join(paths.modelCache, '.torch'),
      // Never download during generation: installs are explicit (Model Manager).
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      WORKER_JOB_TIMEOUT_SEC: String(3 * 3600),
      // The worker exits by itself if this app dies without stopping it (VRAM is never left in use).
      AIS_PARENT_PID: String(process.pid),
      ...this.d.modelEnv(),
    };
    if (this.d.ffmpeg) {
      env['FFMPEG_PATH'] = this.d.ffmpeg.ffmpeg;
      env['FFPROBE_PATH'] = this.d.ffmpeg.ffprobe;
    }
    // A cloud or developer token in the parent environment is not needed by the local worker.
    delete env['RUNPOD_API_KEY'];
    return env;
  }

  async start(): Promise<{ url: string; token: string }> {
    const ep = this.endpoint();
    if (ep) return ep;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<{ url: string; token: string }> {
    this.status_ = { ...this.status_, state: 'starting', error: null };
    const python = await (this.d.findPythonFn ?? findPython)(this.workerDir);
    this.status_.python = python;
    if (!python || !pythonSupported(python.version)) {
      return this.fail(
        python
          ? `Python ${python.version} is too old for the local worker (3.10 or newer is needed).`
          : 'Python was not found. Run the setup program again (it installs Python and the worker environment).',
      );
    }
    if (!existsSync(join(this.workerDir, 'ais_worker'))) return this.fail('The worker folder is missing.');
    mkdirSync(join(this.d.env.dataDir, 'logs'), { recursive: true });
    const token = randomBytes(32).toString('hex');
    for (const port of [this.d.port(), 0]) {
      const result = await this.spawnOnce(python, token, port);
      if (result.url) {
        this.token = token;
        this.managed = true;
        this.status_ = {
          ...this.status_,
          state: 'running',
          url: result.url,
          pid: this.proc?.pid ?? null,
          startedAt: new Date().toISOString(),
          error: null,
        };
        this.d.logger.info('local worker started', {
          url: result.url,
          pid: this.proc?.pid,
          python: python.path,
        });
        return { url: result.url, token };
      }
      if (!result.portBusy) return this.fail(result.error ?? 'The local worker did not start.');
      this.d.logger.warn('local worker port busy; trying a free port', { port });
    }
    return this.fail('The local worker could not find a free port.');
  }

  private fail(message: string): never {
    this.status_ = { ...this.status_, state: 'failed', error: message, url: null, pid: null };
    this.d.logger.error('local worker failed', { error: message });
    throw new AppError('WORKER_UNAVAILABLE', message);
  }

  private spawnOnce(
    python: PythonRuntime,
    token: string,
    port: number,
  ): Promise<{ url?: string; portBusy?: boolean; error?: string }> {
    return new Promise((resolve) => {
      const child = (this.d.spawnFn ?? spawn)(python.path, [...python.args, '-m', 'ais_worker'], {
        cwd: this.workerDir,
        env: this.processEnv(token, port),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = child;
      let settled = false;
      let buf = '';
      const done = (r: { url?: string; portBusy?: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill();
        done({
          error: `The local worker did not start within ${Math.round((this.d.startTimeoutMs ?? 60_000) / 1000)} s. ${this.lines.slice(-3).join(' ')}`,
        });
      }, this.d.startTimeoutMs ?? 60_000);
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        buf += text;
        this.record(text);
        const m = /worker on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
        if (m?.[1]) done({ url: m[1] });
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => done({ error: `Could not start Python: ${err.message}` }));
      child.on('exit', (code) => {
        const busy = /address already in use|Errno 98|WinError 10048|only one usage of each socket/i.test(
          buf,
        );
        if (!settled) {
          done(
            busy
              ? { portBusy: true }
              : {
                  error: `The local worker stopped during start-up (exit code ${code}). ${this.lines
                    .slice(-4)
                    .join(' ')}`.trim(),
                },
          );
          return;
        }
        if (this.proc === child) {
          this.proc = null;
          if (this.status_.state !== 'stopping' && this.status_.state !== 'stopped') {
            this.status_ = {
              ...this.status_,
              state: 'failed',
              url: null,
              pid: null,
              error: `The local worker stopped unexpectedly (exit code ${code}). See ${this.status_.logPath}.`,
            };
            this.token = null;
            this.d.logger.error('local worker exited', { code });
          }
        }
      });
    });
  }

  private record(text: string): void {
    const clean = String(redact(text));
    for (const line of clean.split(/\r?\n/)) if (line.trim()) this.lines.push(line.slice(0, 400));
    if (this.lines.length > 200) this.lines = this.lines.slice(-200);
    try {
      appendFileSync(this.status_.logPath, clean);
    } catch {
      // the log file is optional; the in-memory tail still shows the output
    }
  }

  /** Stop the worker we started (a WORKER_URL worker run by hand is never touched). */
  async stop(): Promise<void> {
    const child = this.proc;
    this.token = null;
    if (!child) {
      this.status_ = { ...this.status_, state: 'stopped', url: null, pid: null };
      return;
    }
    this.status_ = { ...this.status_, state: 'stopping' };
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.proc = null;
    this.managed = false;
    this.status_ = { ...this.status_, state: 'stopped', url: null, pid: null };
    this.d.logger.info('local worker stopped');
  }
}
