import type { AppEnv } from '../config/env.ts';
import type { CloudLifecycleState, UsageCategory } from '../domain/enums.ts';
import type { GpuInstance } from '../domain/types.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import type { GPUProvider, GpuOffer, WorkerEndpoint } from '../providers/types.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import { costFor } from '../repositories/gpu.ts';
import type { BudgetService, BudgetStatus } from './budget.ts';
import { effectiveLimits, type EffectiveLimits } from './cloud-limits.ts';
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
  /** Paid providers only: the session is terminated when its spend reaches this. */
  sessionBudgetInr: number | null;
  budget: BudgetStatus;
  simulated: boolean;
}

export interface StartOptions {
  purpose?: 'generation' | 'test';
  signal?: AbortSignal;
}

/** Callbacks the composition root installs to bind the cloud worker to the AI providers. */
export interface SupervisorHooks {
  /** A cloud worker became ready (or was re-attached): bind providers to it. Throw if unusable. */
  onWorkerReady?: (instance: GpuInstance, endpoint: WorkerEndpoint) => Promise<void>;
  /** The instance ended: unbind providers. */
  onSessionEnded?: (instance: GpuInstance) => void;
  /** Whether the providers are currently bound to this instance's worker. */
  isBound?: (instance: GpuInstance) => boolean;
  /** Whether GPU work is still waiting (keeps a cloud GPU warm between queue runs). */
  pendingWork?: () => boolean;
  /** Extra in-app gates for paid providers (API key, Cloud GPU switched on). Throws when not allowed. */
  assertCloudAllowed?: () => void;
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

  /** Paid sessions: stop before the next job once the session budget is used up. */
  assertWithinBudget(): Promise<void> {
    return this.supervisor.assertWithinBudget(this.instance.id);
  }

  setState(state: CloudLifecycleState, detail = ''): void {
    this.supervisor.setState(this.instance.id, state, detail);
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
  hooks: SupervisorHooks = {};
  private holds = 0;

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

  /** Limits in force for the current provider (Settings, lowered by .env hard caps). */
  limits(): EffectiveLimits {
    return effectiveLimits(this.settings, this.env, this.provider.paid);
  }

  setState(id: string, state: CloudLifecycleState, detail = ''): void {
    const inst = this.repo.get(id);
    if (inst.lifecycle_state === state) return;
    this.repo.update(id, { lifecycle_state: state });
    this.repo.event({
      gpuInstanceId: id,
      provider: inst.provider,
      event: `state:${state}`,
      detail,
      isMock: inst.is_mock === 1,
      at: this.nowIso(),
    });
    this.logger.info('gpu state', { instance: id, state, detail });
  }

  /** Wall-clock spend of a session so far: real cloud GPUs bill from creation until termination. */
  sessionSpendInr(inst: GpuInstance): number {
    const end = inst.terminated_at ? new Date(inst.terminated_at).getTime() : this.clock.now().getTime();
    const seconds = Math.max(0, (end - new Date(inst.created_at).getTime()) / 1000);
    return costFor(seconds, inst.hourly_rate_inr);
  }

  async assertWithinBudget(id: string): Promise<void> {
    const inst = this.repo.get(id);
    const budget = inst.session_budget_inr ?? null;
    if (budget === null) return;
    if (this.sessionSpendInr(inst) >= budget) {
      await this.terminate(id, 'session_budget_reached');
      throw new AppError(
        'SESSION_BUDGET_REACHED',
        'Generation stopped because your session budget was reached.',
      );
    }
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
    this.hooks.assertCloudAllowed?.();
  }

  /** Choose the cheapest suitable offer and compute the worst-case cost, without provisioning anything. */
  async plan(minVramGb: number, estimatedGpuSeconds: number): Promise<GpuPlan> {
    this.assertProviderAllowed();
    const gpu = this.settings.get('gpu');
    const limits = this.limits();
    // The minimum-VRAM setting is a rental preference; a local worker is used as it is.
    const need = this.provider.local ? minVramGb : Math.max(minVramGb, gpu.minVramGb);
    const offers = (await this.provider.listOffers(need)).filter((o) => o.vramGb >= need);
    const available = offers.filter((o) => o.available);
    if (available.length === 0)
      throw new AppError('GPU_UNAVAILABLE', `No available GPU with ≥ ${need} GB VRAM`);
    const affordable = available
      .filter((o) => o.hourlyRateInr <= limits.maxHourlyRateInr)
      .sort((a, b) => a.hourlyRateInr - b.hourlyRateInr);
    const offer = affordable[0];
    if (!offer) {
      const cheapest = Math.min(...available.map((o) => o.hourlyRateInr));
      throw new AppError(
        'PRICE_TOO_HIGH',
        this.provider.paid
          ? `No compatible GPU is currently available below your configured hourly price (cheapest suitable: ₹${cheapest}/h, maximum ₹${limits.maxHourlyRateInr}/h). Nothing was provisioned.`
          : `Cheapest suitable GPU costs ₹${cheapest}/h, above the configured maximum ₹${limits.maxHourlyRateInr}/h. Nothing was provisioned.`,
      );
    }
    const estimatedCostInr = costFor(estimatedGpuSeconds, offer.hourlyRateInr);
    let estimatedMaxCostInr = costFor(limits.maxLifetimeMinutes * 60, offer.hourlyRateInr);
    if (limits.sessionBudgetInr !== null) {
      if (estimatedCostInr > limits.sessionBudgetInr)
        throw new AppError(
          'SESSION_BUDGET_REACHED',
          `This batch is estimated at ₹${estimatedCostInr.toFixed(2)}, above your session budget of ₹${limits.sessionBudgetInr}. Nothing was provisioned; generate fewer shots at once or raise the session budget.`,
        );
      // The session is terminated when its spend reaches the session budget.
      estimatedMaxCostInr = Math.min(estimatedMaxCostInr, limits.sessionBudgetInr);
    }
    // Budget is checked against the worst case (session killed by the max-lifetime safeguard).
    const budget = this.budget.assertCanSpend(estimatedMaxCostInr, this.simulated);
    return {
      offer,
      minVramGb: need,
      estimatedGpuSeconds,
      estimatedCostInr,
      estimatedMaxCostInr,
      maxLifetimeMinutes: limits.maxLifetimeMinutes,
      idleTimeoutMinutes: limits.idleMinutes,
      sessionBudgetInr: limits.sessionBudgetInr,
      budget,
      simulated: this.simulated,
    };
  }

  /** Provision a tagged instance and return a session. Prefer `withSession`, which guarantees cleanup. */
  async start(plan: GpuPlan, opts: StartOptions = {}): Promise<GpuSession> {
    this.assertProviderAllowed();
    const limits = this.limits();
    if (this.provider.paid) {
      const running = this.repo.active().filter((i) => i.provider === this.provider.id);
      if (running.length >= limits.maxConcurrent)
        throw new AppError(
          'GPU_LIMIT',
          `A cloud GPU is already running (limit ${limits.maxConcurrent}). Stop it, or wait for it to finish, before starting another.`,
        );
    }
    this.budget.assertCanSpend(plan.estimatedMaxCostInr, this.simulated);
    const now = this.nowIso();
    // The record exists BEFORE anything is rented, so a crash can never lose track of a paid resource.
    const instance = this.repo.createInstance({
      provider: this.provider.id,
      provider_instance_id: 'pending',
      tag: STUDIO_TAG,
      gpu_model: plan.offer.gpuModel,
      vram_gb: plan.offer.vramGb,
      hourly_rate_inr: plan.offer.hourlyRateInr,
      status: 'provisioning',
      idle_timeout_sec: Math.round(limits.idleMinutes * 60),
      max_lifetime_sec: Math.round(limits.maxLifetimeMinutes * 60),
      is_mock: this.simulated ? 1 : 0,
      created_at: now,
      ready_at: null,
      last_activity_at: now,
      terminated_at: null,
      termination_reason: null,
      lifecycle_state: 'PROVISIONING',
      session_budget_inr: plan.sessionBudgetInr,
      purpose: opts.purpose ?? 'generation',
    });
    let provisioned: { providerInstanceId: string; startupSeconds: number };
    try {
      provisioned = await this.provider.provision(plan.offer, [STUDIO_TAG]);
    } catch (err) {
      const e = toAppError(err);
      this.repo.update(instance.id, {
        status: 'failed',
        lifecycle_state: 'FAILED',
        terminated_at: this.nowIso(),
        termination_reason: 'provision_failed',
        error_message: e.message,
      });
      this.repo.event({
        gpuInstanceId: instance.id,
        provider: this.provider.id,
        event: 'provision_failed',
        detail: e.message,
        isMock: this.simulated,
        at: now,
      });
      this.logger.error('gpu provision failed', { error: e.message, gpu: plan.offer.gpuModel });
      // A provision that errored may still have created something: sweep tagged resources.
      await this.watchdog().catch((werr: unknown) =>
        this.logger.error('watchdog after a failed GPU start failed', { error: toAppError(werr).message }),
      );
      throw new AppError(e.code === 'CLOUD_AUTH_FAILED' ? e.code : 'PROVISION_FAILED', e.message);
    }
    this.repo.update(instance.id, { provider_instance_id: provisioned.providerInstanceId });
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
    if (this.provider.awaitReady) {
      const bootStart = this.clock.now().getTime();
      this.setState(instance.id, 'BOOTING');
      try {
        const endpoint = await this.provider.awaitReady(provisioned.providerInstanceId, {
          timeoutMs: this.settings.get('cloud').workerStartTimeoutMinutes * 60_000,
          ...(opts.signal ? { signal: opts.signal } : {}),
          onState: (state, detail) => {
            if (state !== 'READY') this.setState(instance.id, state, detail);
          },
        });
        this.repo.update(instance.id, { worker_url: endpoint.url });
        await this.hooks.onWorkerReady?.(this.repo.get(instance.id), endpoint);
      } catch (err) {
        const e = toAppError(err);
        const reason = e.code === 'WORKER_START_TIMEOUT' ? 'worker_start_timeout' : 'worker_start_failed';
        const stopped = await this.terminate(instance.id, reason);
        this.repo.update(instance.id, { error_message: e.message });
        throw new AppError(
          e.code === 'CANCELLED' ? 'CANCELLED' : e.code,
          `${e.message} ${stopped ? 'The GPU has been terminated to prevent additional charges.' : 'Terminating the GPU failed; the watchdog keeps retrying — use Emergency Stop if it persists.'}`,
        );
      }
      provisioned.startupSeconds = Math.max(
        provisioned.startupSeconds,
        (this.clock.now().getTime() - bootStart) / 1000,
      );
    }
    const readyAt = this.nowIso();
    this.repo.update(instance.id, { status: 'running', ready_at: readyAt, last_activity_at: readyAt });
    this.setState(instance.id, 'READY');
    const session = new GpuSession(this.repo.get(instance.id), this);
    session.recordUsage('startup', provisioned.startupSeconds);
    return session;
  }

  /** A ready cloud session that can take more work (kept warm between queue runs), or undefined. */
  private async reusable(): Promise<GpuSession | undefined> {
    if (!this.provider.paid) return undefined;
    const candidates = this.repo
      .active()
      .filter(
        (i) =>
          i.provider === this.provider.id &&
          i.status === 'running' &&
          (i.lifecycle_state === 'READY' || i.lifecycle_state === 'IDLE'),
      );
    for (const inst of candidates) {
      const now = this.clock.now().getTime();
      const age = (now - new Date(inst.created_at).getTime()) / 1000;
      if (age >= inst.max_lifetime_sec - 60) continue; // about to hit max lifetime: do not start new work
      const budget = inst.session_budget_inr ?? null;
      if (budget !== null && this.sessionSpendInr(inst) >= budget) continue;
      if (!this.hooks.isBound?.(inst)) {
        const endpoint = this.provider.endpointFor?.(inst.provider_instance_id);
        try {
          if (!endpoint) throw new AppError('WORKER_UNAVAILABLE', 'worker token unknown');
          await this.hooks.onWorkerReady?.(inst, endpoint);
          this.logger.info('gpu session re-attached', { instance: inst.id });
        } catch (err) {
          await this.terminate(inst.id, 'worker_unreachable');
          this.logger.warn('warm gpu unusable; terminated', {
            instance: inst.id,
            error: toAppError(err).message,
          });
          continue;
        }
      }
      return new GpuSession(this.repo.get(inst.id), this);
    }
    return undefined;
  }

  /** True when a paid session should end now (no work left, nothing holding it). */
  private shouldReleaseNow(): boolean {
    return (
      this.settings.get('cloud').autoTerminate === 'after_batch' &&
      this.holds === 0 &&
      !(this.hooks.pendingWork?.() ?? false)
    );
  }

  /**
   * Run `fn` on a GPU session. Simulated and local sessions are fresh and
   * terminated in `finally` whether `fn` completes, throws or is cancelled.
   * Paid cloud sessions are reused while warm; they are terminated in
   * `finally` on any failure, and otherwise when no work remains
   * (autoTerminate=after_batch) or later by the idle timer.
   */
  async withSession<T>(
    plan: GpuPlan,
    fn: (session: GpuSession) => Promise<T>,
    opts: StartOptions = {},
  ): Promise<T> {
    const session = (await this.reusable()) ?? (await this.start(plan, opts));
    if (this.provider.paid) this.setState(session.id, 'GENERATING');
    let reason = 'job_completion';
    let failed = false;
    try {
      return await fn(session);
    } catch (err) {
      failed = true;
      const code = toAppError(err).code;
      reason =
        code === 'CANCELLED'
          ? 'cancellation_cleanup'
          : code === 'SESSION_BUDGET_REACHED'
            ? 'session_budget_reached'
            : 'failure_cleanup';
      throw err;
    } finally {
      if (!this.provider.paid || failed || this.shouldReleaseNow()) {
        await this.terminate(session.id, reason);
      } else if (this.isActive(session.id)) {
        this.repo.update(session.id, { last_activity_at: this.nowIso() });
        this.setState(session.id, 'IDLE', 'waiting for more work (idle timer running)');
      }
    }
  }

  /**
   * Keep a cloud GPU across several queue runs (e.g. BUILD FINAL generates
   * speech, then music, then lip sync). When the last hold ends and no work
   * is waiting, an idle paid session is terminated (autoTerminate=after_batch).
   */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      return await fn();
    } finally {
      this.holds--;
      if (this.holds === 0 && this.provider.paid && this.shouldReleaseNow()) {
        for (const inst of this.repo.active())
          if (
            inst.provider === this.provider.id &&
            inst.status === 'running' &&
            inst.lifecycle_state === 'IDLE'
          )
            await this.terminate(inst.id, 'job_completion');
      }
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
    this.setState(id, 'TERMINATING', reason);
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 'pending' = provisioning never returned an id: nothing exists to terminate.
        if (inst.provider_instance_id !== 'pending') await this.provider.terminate(inst.provider_instance_id);
        const at = this.nowIso();
        this.repo.update(id, { status: 'terminated', terminated_at: at, termination_reason: reason });
        this.setState(id, 'STOPPED', reason);
        this.reconcileBilling(id);
        this.hooks.onSessionEnded?.(this.repo.get(id));
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

  /**
   * Real cloud GPUs bill for wall-clock time. At termination, time not already
   * recorded against jobs (boot, waiting, downloads) is recorded as idle so the
   * daily/monthly budgets see the true spend.
   */
  private reconcileBilling(id: string): void {
    const inst = this.repo.get(id);
    if (inst.is_mock === 1 || inst.hourly_rate_inr <= 0 || !this.provider.paid) return;
    const wall =
      (new Date(inst.terminated_at ?? this.nowIso()).getTime() - new Date(inst.created_at).getTime()) / 1000;
    const missing = wall - this.repo.sessionSeconds(id);
    if (missing > 1)
      this.recordUsage(inst, 'idle', Math.round(missing), { model: 'wall-clock reconciliation' });
  }

  /** Idle-timeout, maximum-lifetime and session-budget safeguards. */
  async enforceTimers(): Promise<string[]> {
    const now = this.clock.now().getTime();
    const stopped: string[] = [];
    for (const inst of this.repo.active()) {
      if (inst.status === 'terminating') continue;
      const age = (now - new Date(inst.created_at).getTime()) / 1000;
      const idle = (now - new Date(inst.last_activity_at).getTime()) / 1000;
      // Idle only counts while nothing runs on the GPU (a long video job is not "idle").
      const idleState =
        !inst.lifecycle_state || inst.lifecycle_state === 'READY' || inst.lifecycle_state === 'IDLE';
      if (age >= inst.max_lifetime_sec) {
        await this.terminate(inst.id, 'max_lifetime');
        stopped.push(inst.id);
      } else if (
        inst.session_budget_inr !== null &&
        inst.session_budget_inr !== undefined &&
        this.sessionSpendInr(inst) >= inst.session_budget_inr
      ) {
        await this.terminate(inst.id, 'session_budget_reached');
        stopped.push(inst.id);
      } else if (idleState && idle >= inst.idle_timeout_sec) {
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
      if (inst.provider_instance_id === 'pending') {
        // Provisioning in progress; after 10 minutes without an id the attempt is dead.
        const age = (this.clock.now().getTime() - new Date(inst.created_at).getTime()) / 1000;
        if (age > 600)
          this.repo.update(inst.id, {
            status: 'failed',
            lifecycle_state: 'FAILED',
            terminated_at: this.nowIso(),
            termination_reason: 'provision_lost',
          });
        continue;
      }
      if (inst.provider === this.provider.id && !remoteIds.has(inst.provider_instance_id)) {
        this.repo.update(inst.id, {
          status: 'terminated',
          terminated_at: this.nowIso(),
          termination_reason: inst.termination_reason ?? 'missing_at_provider',
          lifecycle_state: 'STOPPED',
        });
        this.hooks.onSessionEnded?.(this.repo.get(inst.id));
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
