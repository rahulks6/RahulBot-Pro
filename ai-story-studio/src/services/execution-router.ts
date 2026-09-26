import type { Studio } from '../app/studio.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import type { ProviderSet } from '../providers/registry.ts';
import { connectWorker } from '../providers/worker/connect.ts';
import type { LocalWorkerManager, LocalWorkerStatus } from './local-worker.ts';
import type { ModelManager } from './model-manager.ts';
import type { ExecutionMode } from './settings.ts';

/**
 * The one place that decides WHERE generation runs.
 *
 *   GenerationRequest → queue → ExecutionRouter → MockProviders
 *                                               | LocalWorker providers (this computer)
 *                                               | Cloud worker providers (rented GPU)
 *
 * Every provider set implements the same interfaces and returns the same
 * normalized results, so the rest of the app never checks the mode. Rules:
 *   - MOCK_GENERATION=true (.env) forces MOCK: nothing real, nothing paid, no downloads.
 *   - LOCAL GPU uses only this computer; it can never rent a cloud GPU.
 *   - CLOUD GPU needs every cloud gate (see CloudService.gates()).
 *   - A requested mode that cannot run is reported, never silently replaced by MOCK.
 */
export type ActiveMode = 'mock' | 'local_gpu' | 'cloud_gpu';

export interface RouteStatus {
  requested: ExecutionMode;
  /** The .env MOCK_GENERATION=true lock overrode the setting. */
  lockedByEnv: boolean;
  active: ActiveMode;
  ready: boolean;
  label: string;
  problems: string[];
  local: LocalWorkerStatus;
  /** 'managed' = started by the app; 'external' = WORKER_URL from .env. */
  localSource: 'managed' | 'external';
}

const LABEL: Record<ExecutionMode, string> = {
  mock: 'MOCK',
  local_gpu: 'LOCAL GPU',
  cloud_gpu: 'CLOUD GPU',
};

export class ExecutionRouter {
  private readonly s: Studio;
  private readonly mockSet: ProviderSet;
  readonly localWorker: LocalWorkerManager;
  readonly localCatalog: ModelManager;
  private localBound = false;
  private lastLocalError: string | null = null;
  private applying: Promise<RouteStatus> | null = null;

  constructor(
    s: Studio,
    deps: { localWorker: LocalWorkerManager; localCatalog: ModelManager; baseProviders: ProviderSet },
  ) {
    this.s = s;
    this.mockSet = { ...deps.baseProviders };
    this.localWorker = deps.localWorker;
    this.localCatalog = deps.localCatalog;
  }

  requested(): ExecutionMode {
    return this.s.env.mockGeneration ? 'mock' : this.s.settings.get('execution').mode;
  }

  active(): ActiveMode {
    const m = this.s.cloud.mode();
    return m === 'REAL_CLOUD' ? 'cloud_gpu' : m === 'LOCAL_WORKER' ? 'local_gpu' : 'mock';
  }

  status(): RouteStatus {
    const requested = this.requested();
    const active = this.active();
    const problems: string[] = [];
    if (requested === 'local_gpu' && active !== 'local_gpu')
      problems.push(
        this.lastLocalError ??
          this.localWorker.status().error ??
          'The local worker is not running. Press "Start local worker" (Settings or GPU & Costs).',
      );
    if (requested === 'cloud_gpu' && !this.s.cloud.realArmed())
      problems.push(
        `Real cloud generation is not armed yet: ${this.s.cloud
          .gates()
          .filter((g) => !g.ok)
          .map((g) => `${g.name} — ${g.detail}`)
          .join('; ')}.`,
      );
    const ready = problems.length === 0 && (requested === 'mock' ? true : requested === active);
    return {
      requested,
      lockedByEnv: this.s.env.mockGeneration && this.s.settings.get('execution').mode !== 'mock',
      active,
      ready,
      label: `${LABEL[requested]}${ready ? '' : ' (not ready)'}`,
      problems,
      local: this.localWorker.status(),
      localSource: this.s.env.workerUrl ? 'external' : 'managed',
    };
  }

  /** Switch providers to match the Execution mode setting. Never throws for a worker that fails to start. */
  apply(): Promise<RouteStatus> {
    if (!this.applying)
      this.applying = this.applyNow().finally(() => {
        this.applying = null;
      });
    return this.applying;
  }

  private async applyNow(): Promise<RouteStatus> {
    const want = this.requested();
    if (want !== 'local_gpu' && this.localBound) await this.leaveLocal();
    // Cloud gates include "Execution mode = CLOUD GPU": this arms or disarms the cloud (throws
    // CONFLICT while a cloud GPU is still running, so it can be stopped first).
    this.s.cloud.refresh();
    if (want === 'local_gpu' && !this.localBound) await this.enterLocal();
    const st = this.status();
    this.s.logger.info('execution mode applied', {
      requested: st.requested,
      active: st.active,
      ready: st.ready,
      problems: st.problems,
    });
    return st;
  }

  private async enterLocal(): Promise<void> {
    this.lastLocalError = null;
    try {
      if (this.s.gpuRepo.active().length > 0)
        throw new AppError('CONFLICT', 'A GPU session is still active; wait for it to finish, or stop it.');
      const ex = this.s.settings.get('execution');
      const target = this.s.env.workerUrl
        ? { url: this.s.env.workerUrl, token: this.s.env.workerToken }
        : ex.localWorkerAutoStart
          ? await this.localWorker.start()
          : null;
      if (!target)
        throw new AppError(
          'WORKER_UNAVAILABLE',
          'The local worker is not running. Press "Start local worker", or turn on "Start the local worker automatically" in Settings.',
        );
      const conn = await connectWorker(this.s, {
        ...target,
        timeoutSec: this.s.env.workerTimeoutSec,
        preferred: {
          image: ex.imageModel,
          video: ex.videoModel,
          tts: ex.ttsModel,
          upscale: ex.upscaler,
          music: ex.musicModel,
          sfx: ex.sfxModel,
        },
      });
      const t = conn.system.torch;
      if (t)
        this.s.hardware.torch = {
          installed: t.installed,
          version: t.version,
          cudaAvailable: t.cuda_available,
          cudaRuntime: t.cuda_runtime ?? null,
          device: t.device,
          error: t.error ?? null,
        };
      this.localBound = true;
    } catch (err) {
      this.lastLocalError = toAppError(err).message;
      this.s.logger.error('local GPU mode not available', { error: this.lastLocalError });
    }
  }

  private async leaveLocal(): Promise<void> {
    Object.assign(this.s.providers, this.mockSet);
    if (this.s.gpu.currentProvider.id === 'local-worker') this.s.gpu.useProvider(this.mockSet.gpu);
    this.s.worker = null;
    this.localBound = false;
    if (this.localWorker.managed) await this.localWorker.stop();
  }

  /** Start (or restart) the local worker from the UI. */
  async startLocal(): Promise<RouteStatus> {
    this.localBound = false;
    if (this.requested() !== 'local_gpu')
      throw new AppError('PRECONDITION_FAILED', 'Choose LOCAL GPU as the execution mode first (Settings).');
    if (!this.s.env.workerUrl) {
      await this.localWorker.stop();
      await this.localWorker.start().catch((err: unknown) => {
        this.lastLocalError = toAppError(err).message;
      });
    }
    await this.enterLocal();
    return this.status();
  }

  async stopLocal(): Promise<RouteStatus> {
    if (this.s.gpuRepo.active().length > 0)
      throw new AppError('CONFLICT', 'Wait for the running generation to finish before stopping the worker.');
    if (this.localBound) await this.leaveLocal();
    else if (this.localWorker.managed) await this.localWorker.stop();
    return this.status();
  }

  /**
   * Called before a queue run: restart a crashed local worker once, then refuse clearly if the
   * requested mode still cannot run (a LOCAL GPU job never falls back to mock placeholders).
   */
  async ensureReady(): Promise<void> {
    const want = this.requested();
    if (want === 'local_gpu' && !this.localBound) await this.apply();
    else if (want === 'local_gpu' && this.localWorker.status().state === 'failed' && !this.s.env.workerUrl) {
      this.localBound = false;
      await this.apply();
    }
    const st = this.status();
    if (!st.ready && want !== 'mock')
      throw new AppError(
        want === 'cloud_gpu' ? 'CLOUD_GPU_DISABLED' : 'WORKER_UNAVAILABLE',
        `${LABEL[want]} mode is selected but cannot run: ${st.problems.join(' ')}`,
      );
  }

  /** A model finished installing: restart an idle local worker so it can use it. */
  async onModelInstalled(): Promise<void> {
    if (this.requested() !== 'local_gpu' || this.s.gpuRepo.active().length > 0) return;
    try {
      await this.startLocal();
    } catch (err) {
      this.s.logger.warn('local worker restart after install failed', { error: toAppError(err).message });
    }
  }

  async shutdown(): Promise<void> {
    if (this.localWorker.managed) await this.localWorker.stop();
  }
}
