import type { AppEnv } from '../config/env.ts';
import type { UsageCategory } from '../domain/enums.ts';
import type { GpuInstance } from '../domain/types.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import type { GPUProvider, GpuOffer } from '../providers/types.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import { costFor } from '../repositories/gpu.ts';
import type { BudgetService, BudgetStatus } from './budget.ts';
import type { SettingsService } from './settings.ts';

/** Every GPU resource the studio creates carries this tag; only tagged resources are ever terminated. */
export const STUDIO_TAG = 'ai-story-studio';
export const KILL_ALL_CONFIRMATION = 'TERMINATE ALL';
export const KILL_ONE_CONFIRMATION = 'TERMINATE';

export interface GpuPlan {
  offer: GpuOffer;
  minVramGb: number;
  estimatedGpuSeconds: number;
  estimatedCostInr: number;
  /** Worst case: the session runs until the maximum-lifetime safeguard stops it. */
  estimatedMaxCostInr: number;
  maxLifetimeMinutes: number;
  idleTimeoutMinutes: number;
  budget: BudgetStatus;
  simulated: boolean;
}

export interface WatchdogReport {
  checkedAt: string;
  providerInstances: number;
  orphansFound: string[];
  orphansTerminated: string[];
  markedMissing: string[];
  timerTerminations: string[];
  retriedTerminations: string[];
  warnings: string[];
}

/** One live GPU session. Usage is recorded against it as work happens. */
export class GpuSession {
  readonly instance: GpuInstance;
  private readonly supervisor: GpuSupervisor;

  constructor(instance: GpuInstance, supervisor: GpuSupervisor) {
    this.instance = instance;
    this.supervisor = supervisor;
  }

  get id(): string {
    return this.instance.id;
  }

  recordUsage(
    category: UsageCategory,
    seconds: number,
    meta: {
      jobId?: string;
      attemptId?: string;
      projectId?: string;
      storyId?: string | null;
      shotId?: string | null;
      model?: string;
    } = {},
  ): number {
    return this.supervisor.recordUsage(this.instance, category, seconds, meta);
  }

  isAlive(): boolean {
    return this.supervisor.isActive(this.instance.id);
  }
}

/**
 * GPU safety supervisor (spec §41–§44, §68). Independent safeguards:
 *   1. price + VRAM + budget checks before provisioning,
 *   2. termination on job completion (withSession `finally`),
 *   3. termination on failure and on cancellation (same `finally`),
 *   4. idle timeout and maximum lifetime timers (enforceTimers),
 *   5. watchdog comparing provider resources with the local database,
 *   6. emergency kill switch limited to studio-tagged resources.
 * A failed termination is retried and left in `terminating` state for the
 * watchdog, never silently forgotten.
 */
export class GpuSupervisor {
  private provider: GPUProvider;
  private readonly repo: GpuRepository;
  private readonly settings: SettingsService;
  private readonly budget: BudgetService;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly env: AppEnv;

  constructor(deps: {
    provider: GPUProvider;
    repo: GpuRepository;
    settings: SettingsService;
    budget: BudgetService;
    clock: Clock;
    logger: Logger;
    env: AppEnv;
  }) {
    this.provider = deps.provider;
    this.repo = deps.repo;
    this.settings = deps.settings;
    this.budget = deps.budget;
    this.clock = deps.clock;
    this.logger = deps.logger.child({ component: 'gpu', provider: deps.provider.id });
    this.env = deps.env;
  }

  get currentProvider(): GPUProvider {
    return this.provider;
  }

  /** Swap the GPU provider (e.g. to the local worker). Refused while any instance is active. */
  useProvider(provider: GPUProvider): void {
    if (this.repo.active().length > 0)
      throw new AppError('CONFLICT', 'Cannot switch GPU provider while a GPU instance is active');
    this.provider = provider;
  }

  get simulated(): boolean {
    return this.provider.isMock;
  }

  get providerId(): string {
    return this.provider.id;
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  /** Cost-safety gate: paid providers need MOCK_GENERATION=false AND ENABLE_CLOUD_GPU=true. */
  assertProviderAllowed(): void {
    if (!this.provider.paid) return;
    if (this.env.mockGeneration)
      throw new AppError('MOCK_MODE_REQUIRED', 'MOCK_GENERATION=true: real GPU providers are disabled.');
    if (!this.env.enableCloudGpu)
      throw new AppError(
        'CLOUD_GPU_DISABLED',
        'Cloud GPU provisioning is disabled (ENABLE_CLOUD_GPU=false).',
      );
  }

  /** Choose the cheapest suitable offer and compute the worst-case cost, without provisioning anything. */
  async plan(minVramGb: number, estimatedGpuSeconds: number): Promise<GpuPlan> {
    this.assertProviderAllowed();
    const gpu = this.settings.get('gpu');
    // The minimum-VRAM setting is a rental preference; a local worker is used as it is.
    const need = this.provider.local ? minVramGb : Math.max(minVramGb, gpu.minVramGb);
    const offers = (await this.provider.listOffers(need)).filter((o) => o.vramGb >= need);
    const available = offers.filter((o) => o.available);
    if (available.length === 0)
      throw new AppError('GPU_UNAVAILABLE', `No available GPU with ≥ ${need} GB VRAM`);
    const affordable = available
      .filter((o) => o.hourlyRateInr <= gpu.maxHourlyRateInr)
      .sort((a, b) => a.hourlyRateInr - b.hourlyRateInr);
    const offer = affordable[0];
    if (!offer) {
      const cheapest = Math.min(...available.map((o) => o.hourlyRateInr));
      throw new AppError(
        'PRICE_TOO_HIGH',
        `Cheapest suitable GPU costs ₹${cheapest}/h, above the configured maximum ₹${gpu.maxHourlyRateInr}/h. Nothing was provisioned.`,
      );
    }
    const estimatedCostInr = costFor(estimatedGpuSeconds, offer.hourlyRateInr);
    const estimatedMaxCostInr = costFor(gpu.maxLifetimeMinutes * 60, offer.hourlyRateInr);
    // Budget is checked against the worst case (session killed by the max-lifetime safeguard).
    const budget = this.budget.assertCanSpend(estimatedMaxCostInr, this.simulated);
    return {
      offer,
      minVramGb: need,
      estimatedGpuSeconds,
      estimatedCostInr,
      estimatedMaxCostInr,
      maxLifetimeMinutes: gpu.maxLifetimeMinutes,
      idleTimeoutMinutes: gpu.idleTimeoutMinutes,
      budget,
      simulated: this.simulated,
    };
  }

  /** Provision a tagged instance and return a session. Prefer `withSession`, which guarantees cleanup. */
  async start(plan: GpuPlan): Promise<GpuSession> {
    this.assertProviderAllowed();
    this.budget.assertCanSpend(plan.estimatedMaxCostInr, this.simulated);
    const gpu = this.settings.get('gpu');
    const now = this.nowIso();
    let provisioned: { providerInstanceId: string; startupSeconds: number };
    try {
      provisioned = await this.provider.provision(plan.offer, [STUDIO_TAG]);
    } catch (err) {
      const e = toAppError(err);
      this.repo.event({
        provider: this.provider.id,
        event: 'provision_failed',
        detail: e.message,
        isMock: this.simulated,
        at: now,
      });
      this.logger.error('gpu provision failed', { error: e.message, gpu: plan.offer.gpuModel });
      // A provision that errored may still have created something: sweep tagged resources.
      await this.watchdog().catch(() => undefined);
      throw new AppError('PROVISION_FAILED', e.message);
    }
    const instance = this.repo.createInstance({
      provider: this.provider.id,
      provider_instance_id: provisioned.providerInstanceId,
      tag: STUDIO_TAG,
      gpu_model: plan.offer.gpuModel,
      vram_gb: plan.offer.vramGb,
      hourly_rate_inr: plan.offer.hourlyRateInr,
      status: 'running',
      idle_timeout_sec: Math.round(gpu.idleTimeoutMinutes * 60),
      max_lifetime_sec: Math.round(gpu.maxLifetimeMinutes * 60),
      is_mock: this.simulated ? 1 : 0,
      created_at: now,
      ready_at: now,
      last_activity_at: now,
      terminated_at: null,
      termination_reason: null,
    });
    this.repo.event({
      gpuInstanceId: instance.id,
      provider: this.provider.id,
      event: 'provisioned',
      detail: `${plan.offer.gpuModel} ₹${plan.offer.hourlyRateInr}/h`,
      isMock: this.simulated,
      at: now,
    });
    this.logger.info('gpu provisioned', {
      gpu: plan.offer.gpuModel,
      instance: instance.id,
      rate: plan.offer.hourlyRateInr,
    });
    const session = new GpuSession(instance, this);
    session.recordUsage('startup', provisioned.startupSeconds);
    return session;
  }

  /**
   * Run `fn` on a fresh GPU session. The instance is terminated in `finally`
   * whether `fn` completes, throws or is cancelled.
   */
  async withSession<T>(plan: GpuPlan, fn: (session: GpuSession) => Promise<T>): Promise<T> {
    const session = await this.start(plan);
    let reason = 'job_completion';
    try {
      return await fn(session);
    } catch (err) {
      reason = toAppError(err).code === 'CANCELLED' ? 'cancellation_cleanup' : 'failure_cleanup';
      throw err;
    } finally {
      await this.terminate(session.id, reason);
    }
  }

  isActive(id: string): boolean {
    const inst = this.repo.get(id);
    return inst.status === 'running' || inst.status === 'provisioning';
  }

  recordUsage(
    instance: GpuInstance,
    category: UsageCategory,
    seconds: number,
    meta: {
      jobId?: string;
      attemptId?: string;
      projectId?: string;
      storyId?: string | null;
      shotId?: string | null;
      model?: string;
    },
  ): number {
    const now = this.nowIso();
    const rec = this.repo.recordUsage({
      gpuInstanceId: instance.id,
      jobId: meta.jobId ?? null,
      attemptId: meta.attemptId ?? null,
      projectId: meta.projectId ?? null,
      storyId: meta.storyId ?? null,
      shotId: meta.shotId ?? null,
      category,
      seconds,
      hourlyRateInr: instance.hourly_rate_inr,
      provider: instance.provider,
      gpuModel: instance.gpu_model,
      model: meta.model ?? '',
      isMock: instance.is_mock === 1,
      recordedAt: now,
    });
    this.repo.update(instance.id, { last_activity_at: now });
    return rec.cost_inr;
  }

  /** Terminate one instance (idempotent). Retries; on failure leaves it `terminating` for the watchdog. */
  async terminate(id: string, reason: string): Promise<boolean> {
    const inst = this.repo.get(id);
    if (inst.status === 'terminated') return true;
    this.repo.update(id, { status: 'terminating', termination_reason: reason });
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.provider.terminate(inst.provider_instance_id);
        const at = this.nowIso();
        this.repo.update(id, { status: 'terminated', terminated_at: at, termination_reason: reason });
        this.repo.event({
          gpuInstanceId: id,
          provider: inst.provider,
          event: 'terminated',
          detail: reason,
          isMock: inst.is_mock === 1,
          at,
        });
        this.logger.info('gpu terminated', { instance: id, reason, cleanup: 'ok' });
        return true;
      } catch (err) {
        lastError = toAppError(err).message;
      }
    }
    this.repo.event({
      gpuInstanceId: id,
      provider: inst.provider,
      event: 'terminate_failed',
      detail: `${reason}: ${lastError} — watchdog will retry`,
      isMock: inst.is_mock === 1,
      at: this.nowIso(),
    });
    this.logger.error('gpu termination failed', {
      instance: id,
      reason,
      cleanup: 'failed',
      error: lastError,
    });
    return false;
  }

  /** Idle-timeout and maximum-lifetime safeguards. */
  async enforceTimers(): Promise<string[]> {
    const now = this.clock.now().getTime();
    const stopped: string[] = [];
    for (const inst of this.repo.active()) {
      if (inst.status === 'terminating') continue;
      const age = (now - new Date(inst.created_at).getTime()) / 1000;
      const idle = (now - new Date(inst.last_activity_at).getTime()) / 1000;
      if (age >= inst.max_lifetime_sec) {
        await this.terminate(inst.id, 'max_lifetime');
        stopped.push(inst.id);
      } else if (idle >= inst.idle_timeout_sec) {
        await this.terminate(inst.id, 'idle_timeout');
        stopped.push(inst.id);
      }
    }
    return stopped;
  }

  /** Watchdog: reconcile provider resources with the database and clean up per policy. */
  async watchdog(): Promise<WatchdogReport> {
    const report: WatchdogReport = {
      checkedAt: this.nowIso(),
      providerInstances: 0,
      orphansFound: [],
      orphansTerminated: [],
      markedMissing: [],
      timerTerminations: [],
      retriedTerminations: [],
      warnings: [],
    };
    report.timerTerminations = await this.enforceTimers();
    for (const inst of this.repo.active().filter((i) => i.status === 'terminating')) {
      if (await this.terminate(inst.id, inst.termination_reason ?? 'watchdog_retry'))
        report.retriedTerminations.push(inst.id);
    }
    const remote = (await this.provider.listInstances()).filter((i) => i.status !== 'terminated');
    report.providerInstances = remote.length;
    const policy = this.settings.get('gpu').orphanPolicy;
    for (const r of remote) {
      if (!r.tags.includes(STUDIO_TAG)) continue; // never touch resources the studio did not create
      const local = this.repo.byProviderId(this.provider.id, r.providerInstanceId);
      if (local && (local.status === 'running' || local.status === 'provisioning')) continue;
      report.orphansFound.push(r.providerInstanceId);
      if (policy === 'terminate') {
        try {
          await this.provider.terminate(r.providerInstanceId);
          report.orphansTerminated.push(r.providerInstanceId);
          if (local)
            this.repo.update(local.id, {
              status: 'terminated',
              terminated_at: this.nowIso(),
              termination_reason: 'watchdog_orphan',
            });
        } catch (err) {
          report.warnings.push(
            `Failed to terminate orphan ${r.providerInstanceId}: ${toAppError(err).message}`,
          );
        }
      } else {
        report.warnings.push(`Orphaned studio GPU ${r.providerInstanceId} is running (policy: warn).`);
      }
    }
    const remoteIds = new Set(remote.map((r) => r.providerInstanceId));
    for (const inst of this.repo.active()) {
      if (inst.provider === this.provider.id && !remoteIds.has(inst.provider_instance_id)) {
        this.repo.update(inst.id, {
          status: 'terminated',
          terminated_at: this.nowIso(),
          termination_reason: inst.termination_reason ?? 'missing_at_provider',
        });
        report.markedMissing.push(inst.id);
      }
    }
    const touched =
      report.orphansFound.length +
      report.markedMissing.length +
      report.timerTerminations.length +
      report.retriedTerminations.length +
      report.warnings.length;
    if (touched > 0) {
      this.repo.event({
        provider: this.provider.id,
        event: 'watchdog',
        detail: JSON.stringify(report),
        isMock: this.simulated,
        at: report.checkedAt,
      });
      this.logger.warn('gpu watchdog cleanup', { ...report });
    }
    return report;
  }

  /** TERMINATE AI GPU — one instance, confirmation required. */
  async killInstance(id: string, confirmation: string): Promise<boolean> {
    if (confirmation !== KILL_ONE_CONFIRMATION) {
      throw new AppError('PRECONDITION_FAILED', `Type ${KILL_ONE_CONFIRMATION} to confirm.`);
    }
    return this.terminate(id, 'emergency_kill');
  }

  /** TERMINATE ALL AI STORY STUDIO GPU RESOURCES — only studio-tagged resources, confirmation required. */
  async killAll(confirmation: string): Promise<{ terminated: string[]; failed: string[] }> {
    if (confirmation !== KILL_ALL_CONFIRMATION) {
      throw new AppError('PRECONDITION_FAILED', `Type ${KILL_ALL_CONFIRMATION} to confirm.`);
    }
    const terminated: string[] = [];
    const failed: string[] = [];
    for (const inst of this.repo.active()) {
      if (await this.terminate(inst.id, 'emergency_kill_all')) terminated.push(inst.provider_instance_id);
      else failed.push(inst.provider_instance_id);
    }
    for (const r of await this.provider.listInstances()) {
      if (
        r.status === 'terminated' ||
        !r.tags.includes(STUDIO_TAG) ||
        terminated.includes(r.providerInstanceId)
      )
        continue;
      try {
        await this.provider.terminate(r.providerInstanceId);
        terminated.push(r.providerInstanceId);
      } catch {
        failed.push(r.providerInstanceId);
      }
    }
    this.repo.event({
      provider: this.provider.id,
      event: 'emergency_kill_all',
      detail: `terminated=${terminated.length} failed=${failed.length}`,
      isMock: this.simulated,
      at: this.nowIso(),
    });
    this.logger.warn('emergency kill switch used', { terminated: terminated.length, failed: failed.length });
    return { terminated, failed };
  }

  /** Shutdown cleanup: terminate every instance this studio still tracks as active (no confirmation). */
  async shutdownCleanup(): Promise<number> {
    let n = 0;
    for (const inst of this.repo.active()) if (await this.terminate(inst.id, 'app_shutdown')) n++;
    return n;
  }

  /** Count of studio-tagged resources still alive at the provider (used to confirm zero after work). */
  async liveStudioInstances(): Promise<number> {
    return (await this.provider.listInstances()).filter(
      (i) => i.status !== 'terminated' && i.tags.includes(STUDIO_TAG),
    ).length;
  }
}
