import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { redact } from '../lib/logger.ts';
import type { NvidiaReport } from './hardware.ts';
import { findPython, pythonSupported, torchWheelFor, venvPython } from './python-runtime.ts';

/**
 * Installs the local worker's Python packages from the app (System Health), so a
 * normal user never needs a terminal. Always a confirmed, logged action:
 *   GPU runtime: PyTorch (CUDA build matching the driver) + requirements-local.txt (~3.5 GB)
 *   CPU runtime: PyTorch CPU + Kokoro TTS only (~1 GB), for computers without an NVIDIA GPU
 * Packages go into worker/.venv (created if missing), never into the system Python.
 */
export type RuntimeKind = 'gpu' | 'cpu';
export const TORCH_VERSION = '2.7.1';

export interface RuntimeStep {
  title: string;
  args: string[];
  /** Run with the system Python (creating the venv) instead of the venv's. */
  system?: boolean;
}

export interface RuntimePlan {
  kind: RuntimeKind;
  sizeGb: number;
  indexUrl: string;
  wheel: string;
  steps: RuntimeStep[];
  venv: string;
}

export interface RuntimeStatus {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  kind: RuntimeKind | null;
  step: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  logPath: string;
  tail: string[];
}

export function planRuntime(kind: RuntimeKind, nvidia: NvidiaReport | null, workerDir: string): RuntimePlan {
  let indexUrl = 'https://download.pytorch.org/whl/cpu';
  let wheel = 'cpu';
  if (kind === 'gpu') {
    const dev = nvidia?.gpus[0];
    if (!dev)
      throw new AppError(
        'CUDA_UNAVAILABLE',
        'No NVIDIA GPU was found, so the GPU runtime cannot be used. Install the CPU runtime (Kokoro TTS only) or use CLOUD GPU.',
      );
    const w = torchWheelFor(nvidia.cudaDriverVersion, dev.computeCapability);
    if (!w)
      throw new AppError(
        'CUDA_UNAVAILABLE',
        `The NVIDIA driver (CUDA ${nvidia.cudaDriverVersion ?? 'unknown'}) is too old for PyTorch ${TORCH_VERSION}${
          Number(dev.computeCapability?.split('.')[0] ?? 0) >= 12
            ? ' on this RTX 50-series GPU (needs CUDA 12.8)'
            : ''
        }. Update the NVIDIA driver, restart, then try again.`,
      );
    indexUrl = w.indexUrl;
    wheel = w.tag;
  }
  const venv = venvPython(workerDir);
  const pip = (...a: string[]): string[] => ['-m', 'pip', 'install', '--disable-pip-version-check', ...a];
  const steps: RuntimeStep[] = [
    ...(existsSync(venv)
      ? []
      : [
          {
            title: 'Create the worker environment',
            args: ['-m', 'venv', join(workerDir, '.venv')],
            system: true,
          },
        ]),
    { title: 'Update pip', args: pip('--upgrade', 'pip') },
    { title: 'Install the worker base packages', args: pip('-r', join(workerDir, 'requirements.txt')) },
    {
      title: `Install PyTorch ${TORCH_VERSION} (${wheel === 'cpu' ? 'CPU' : `CUDA, ${wheel}`})`,
      args: pip(`torch==${TORCH_VERSION}`, '--index-url', indexUrl),
    },
    kind === 'gpu'
      ? {
          title: 'Install the AI libraries (diffusers, Kokoro, …)',
          args: pip('-r', join(workerDir, 'requirements-local.txt')),
        }
      : {
          title: 'Install Kokoro TTS',
          args: pip('kokoro==0.9.4', 'soundfile==0.13.1', 'huggingface_hub==0.34.4'),
        },
  ];
  return { kind, sizeGb: kind === 'gpu' ? 3.5 : 1, indexUrl, wheel, steps, venv };
}

export class RuntimeInstaller {
  private child: ChildProcess | null = null;
  private cancelled = false;
  private lines: string[] = [];
  private st: RuntimeStatus;
  private readonly logger: Logger;
  private readonly workerDir: string;
  private readonly spawnFn: typeof spawn;
  /** Called after a successful install (re-check PyTorch, restart the worker). */
  onComplete: (() => void) | null = null;

  constructor(opts: { logger: Logger; dataDir: string; workerDir: string; spawnFn?: typeof spawn }) {
    this.logger = opts.logger;
    this.workerDir = opts.workerDir;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.st = {
      state: 'idle',
      kind: null,
      step: '',
      startedAt: null,
      finishedAt: null,
      error: null,
      logPath: join(opts.dataDir, 'logs', 'runtime-install.log'),
      tail: [],
    };
  }

  status(): RuntimeStatus {
    return { ...this.st, tail: this.lines.slice(-20) };
  }

  /** Start installing (after the user confirmed the plan). Returns immediately. */
  async start(plan: RuntimePlan): Promise<void> {
    if (this.st.state === 'running') throw new AppError('CONFLICT', 'An installation is already running.');
    const system = await findPython(this.workerDir);
    if (!system || !pythonSupported(system.version))
      throw new AppError(
        'PRECONDITION_FAILED',
        system
          ? `Python ${system.version} is too old (3.10 or newer is needed).`
          : 'Python was not found. Run the setup program again (it installs Python).',
      );
    mkdirSync(join(this.st.logPath, '..'), { recursive: true });
    this.cancelled = false;
    this.lines = [];
    this.st = {
      ...this.st,
      state: 'running',
      kind: plan.kind,
      step: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.logger.info('runtime install started', { kind: plan.kind, wheel: plan.wheel });
    void (async () => {
      try {
        for (const step of plan.steps) {
          if (this.cancelled) return this.finish('cancelled', 'Cancelled.');
          this.st.step = step.title;
          this.record(`\n== ${step.title}\n`);
          const [bin, pre] = step.system ? [system.path, system.args] : [plan.venv, [] as string[]];
          const code = await this.run(bin, [...pre, ...step.args]);
          if (this.cancelled) return this.finish('cancelled', 'Cancelled. Run it again to finish.');
          if (code !== 0)
            return this.finish(
              'failed',
              `"${step.title}" failed (exit ${code}). ${
                this.lines
                  .filter((l) => /error/i.test(l))
                  .slice(-2)
                  .join(' ') || 'See the log.'
              }`,
            );
        }
        this.finish('complete', null);
        this.onComplete?.();
      } catch (err) {
        this.finish('failed', (err as Error).message);
      }
    })();
  }

  cancel(): void {
    if (this.st.state !== 'running') throw new AppError('NOT_FOUND', 'No installation is running.');
    this.cancelled = true;
    this.child?.kill('SIGTERM');
  }

  private run(bin: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = this.spawnFn(bin, args, {
        cwd: this.workerDir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_NO_INPUT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.stdout?.on('data', (c: Buffer) => this.record(c.toString()));
      child.stderr?.on('data', (c: Buffer) => this.record(c.toString()));
      child.on('error', (e) => {
        this.record(`could not start ${bin}: ${e.message}\n`);
        resolve(-1);
      });
      child.on('exit', (code) => resolve(code ?? -1));
    });
  }

  private record(text: string): void {
    const clean = String(redact(text));
    for (const line of clean.split(/\r?\n/)) if (line.trim()) this.lines.push(line.slice(0, 300));
    if (this.lines.length > 400) this.lines = this.lines.slice(-400);
    try {
      appendFileSync(this.st.logPath, clean);
    } catch {
      // logging is best effort; the in-memory tail is shown in the app
    }
  }

  private finish(state: RuntimeStatus['state'], error: string | null): void {
    this.child = null;
    this.st = { ...this.st, state, error, finishedAt: new Date().toISOString() };
    this.logger[state === 'complete' ? 'info' : 'warn']('runtime install finished', { state, error });
  }
}
