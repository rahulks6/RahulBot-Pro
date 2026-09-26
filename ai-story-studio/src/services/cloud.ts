import { randomBytes } from 'node:crypto';
import { storagePaths, type AppEnv } from '../config/env.ts';
import type { Database } from '../db/database.ts';
import type { GpuInstance } from '../domain/types.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { runTool, type FfmpegTools } from '../media/ffmpeg.ts';
import { CloudWorkerBridge } from '../providers/cloud/bridge.ts';
import { CloudGpuProvider, ownedPodPrefix, WORKER_MIN_CUDA } from '../providers/cloud/gpu-provider.ts';
import type { FetchFn, SleepFn } from '../providers/cloud/http.ts';
import { RunPodApi } from '../providers/cloud/runpod.ts';
import type { CloudGpuApi, CloudPod, ContractReport } from '../providers/cloud/types.ts';
import { UnsupportedCloudApi } from '../providers/cloud/unsupported.ts';
import type { ProviderSet } from '../providers/registry.ts';
import type { GPUProvider, GpuOffer } from '../providers/types.ts';
import { WorkerClient } from '../providers/worker/client.ts';
import type { JobRepository } from '../repositories/jobs.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import { effectiveLimits, type EffectiveLimits } from './cloud-limits.ts';
import { checkImagePullable, IMAGE_STATUS_LABEL, type ImageCheckResult } from './image-check.ts';
import type { GpuSupervisor } from './gpu-supervisor.ts';
import type { ModelManager } from './model-manager.ts';
import type { SecretStore } from './secrets.ts';
import type { SettingsService } from './settings.ts';

export type StudioMode = 'MOCK' | 'LOCAL_WORKER' | 'REAL_CLOUD';

export interface Gate {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CloudStatus {
  mode: StudioMode;
  modeLabel: string;
  gates: Gate[];
  canProvision: boolean;
  realArmed: boolean;
  provider: string;
  apiKey: string;
  apiKeySource: 'env' | 'store' | 'none';
  connection: { ok: boolean; detail: string; at: string } | null;
  instance: {
    id: string;
    podId: string;
    state: string;
    gpu: string;
    vramGb: number;
    hourlyRateInr: number;
    runtimeSec: number;
    spentInr: number;
    sessionBudgetInr: number | null;
    workerHealthy: boolean;
    purpose: string;
  } | null;
  limits: EffectiveLimits;
  recovery: RecoveryReport | null;
}

export interface RecoveryReport {
  at: string;
  jobsRecovered: number;
  ownedPods: Array<{ id: string; name: string; state: string; gpu: string | null }>;
  terminated: string[];
  reattachable: string[];
  warnings: string[];
}

export interface DiagnosticStep {
  step: string;
  ok: boolean | null;
  detail: string;
}

export interface CloudServiceDeps {
  env: AppEnv;
  db: Database;
  settings: SettingsService;
  secrets: SecretStore;
  gpu: GpuSupervisor;
  gpuRepo: GpuRepository;
  jobs: JobRepository;
  providers: ProviderSet;
  models: ModelManager;
  logger: Logger;
  clock: Clock;
  ffmpeg: FfmpegTools | null;
  /** Tests: point RunPod at a mock server, speed up polling. */
  runpodBaseUrl?: string;
  proxyUrlTemplate?: string;
  fetch?: FetchFn;
  sleep?: SleepFn;
  pollMs?: number;
  workerPollMs?: number;
  now?: () => number;
  /** Tests: point the container-registry check at a mock registry. */
  registryBaseUrlFor?: (apiHost: string) => string;
}

const INSTALL_KEY = 'installation_id';

/**
 * Cloud GPU orchestration (Phase 5): mode and safety gates, provider
 * activation, cloud worker binding, diagnostics (dry run), stop / emergency
 * stop and crash recovery. Paid work only ever happens through the GPU
 * supervisor, whose price, budget, lifetime, idle and watchdog safeguards apply.
 */
export class CloudService {
  readonly bridge: CloudWorkerBridge;
  readonly installId: string;
  private readonly d: CloudServiceDeps;
  private readonly cloudProvider: CloudGpuProvider;
  private readonly fallbackGpu: GPUProvider;
  private saved: Partial<ProviderSet> | null = null;
  private apiCache: { key: string; api: CloudGpuApi } | undefined;
  private lastConnection: CloudStatus['connection'] = null;
  lastImageCheck: (ImageCheckResult & { at: string }) | null = null;
  lastRecovery: RecoveryReport | null = null;
  lastHealthAt: string | null = null;

  constructor(deps: CloudServiceDeps) {
    this.d = deps;
    this.installId = CloudService.installationId(deps.db);
    this.bridge = new CloudWorkerBridge(deps.models);
    this.fallbackGpu = deps.gpu.currentProvider;
    this.cloudProvider = new CloudGpuProvider({
      api: () => this.api(),
      providerId: deps.env.cloudProvider,
      secrets: deps.secrets,
      installId: this.installId,
      env: deps.env,
      logger: deps.logger,
      cloud: () => deps.settings.get('cloud'),
      gpu: () => deps.settings.get('gpu'),
      limits: () => {
        const l = effectiveLimits(deps.settings, deps.env, true);
        return { idleMinutes: l.idleMinutes, maxLifetimeMinutes: l.maxLifetimeMinutes };
      },
      extraEnv: () => deps.models.workerEnv(),
      preflightImage: async (image) => {
        await this.assertImagePullable(image);
      },
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    deps.gpu.hooks = {
      onWorkerReady: (inst, endpoint) => this.bindWorker(inst, endpoint.url, endpoint.token),
      onSessionEnded: (inst) => this.bridge.unbind(inst.id),
      isBound: (inst) => this.bridge.isBound(inst.id),
      pendingWork: () => deps.jobs.waiting().length > 0,
      assertCloudAllowed: () => this.assertCanProvision(),
    };
  }

  /** Stable random id naming every cloud resource this installation creates. */
  static installationId(db: Database): string {
    const row = db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', INSTALL_KEY);
    if (row) return row.value;
    const id = randomBytes(5).toString('hex');
    db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', INSTALL_KEY, id);
    return id;
  }

  // --- provider access ---------------------------------------------------------------

  api(): CloudGpuApi {
    const provider = this.d.settings.get('cloud').provider;
    if (provider !== 'runpod') return new UnsupportedCloudApi(provider);
    const key = this.d.secrets.get('runpodApiKey');
    if (!key)
      throw new AppError('CLOUD_AUTH_FAILED', 'No RunPod API key is saved. Add it in Settings → Cloud GPU.');
    if (this.apiCache?.key !== key)
      this.apiCache = {
        key,
        api: new RunPodApi({
          apiKey: key,
          ...(this.d.runpodBaseUrl ? { baseUrl: this.d.runpodBaseUrl } : {}),
          ...(this.d.proxyUrlTemplate ? { proxyUrlTemplate: this.d.proxyUrlTemplate } : {}),
          ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
          ...(this.d.sleep ? { sleep: this.d.sleep } : {}),
        }),
      };
    return this.apiCache.api;
  }

  get provider(): CloudGpuProvider {
    return this.cloudProvider;
  }

  // --- mode and gates ------------------------------------------------------------------

  gates(): Gate[] {
    const { env } = this.d;
    const cloud = this.d.settings.get('cloud');
    const key = this.d.secrets.source('runpodApiKey');
    return [
      {
        name: 'MOCK_GENERATION=false (.env)',
        ok: !env.mockGeneration,
        detail: env.mockGeneration ? 'mock mode is on (safe default)' : 'mock mode off',
      },
      {
        name: 'ENABLE_CLOUD_GPU=true (.env)',
        ok: env.enableCloudGpu,
        detail: env.enableCloudGpu ? 'cloud GPUs allowed' : 'cloud GPUs disabled (safe default)',
      },
      {
        name: 'Provider implemented',
        ok: cloud.provider === 'runpod',
        detail: cloud.provider === 'runpod' ? 'RunPod (API v2)' : `${cloud.provider} is not supported yet`,
      },
      {
        name: 'API key saved',
        ok: key !== 'none',
        detail: key === 'env' ? 'from .env' : key === 'store' ? 'saved in the app' : 'missing',
      },
      {
        name: 'Cloud GPU switched on (Settings)',
        ok: cloud.cloudEnabled,
        detail: cloud.cloudEnabled ? 'on' : 'off',
      },
      {
        name: 'Real generation switched on (Settings)',
        ok: cloud.realGeneration,
        detail: cloud.realGeneration ? 'on' : 'off',
      },
    ];
  }

  /** Paid GPUs may be started (test GPU, emergency tooling); first five gates. */
  canProvision(): boolean {
    return this.gates()
      .slice(0, 5)
      .every((g) => g.ok);
  }

  assertCanProvision(): void {
    const failed = this.gates()
      .slice(0, 5)
      .filter((g) => !g.ok);
    if (failed.length)
      throw new AppError(
        'CLOUD_GPU_DISABLED',
        `Cloud GPU is not allowed yet: ${failed.map((g) => `${g.name} — ${g.detail}`).join('; ')}.`,
      );
  }

  /** Project generation runs on real cloud models: all six gates. */
  realArmed(): boolean {
    return this.gates().every((g) => g.ok);
  }

  mode(): StudioMode {
    if (this.saved) return 'REAL_CLOUD';
    if (this.d.gpu.currentProvider.id === 'local-worker') return 'LOCAL_WORKER';
    return 'MOCK';
  }

  modeLabel(): string {
    const m = this.mode();
    if (m === 'REAL_CLOUD') return 'REAL CLOUD — paid GPU generation';
    if (m === 'LOCAL_WORKER') return 'LOCAL WORKER';
    return this.d.env.mockGeneration
      ? 'MOCK — placeholders, ₹0'
      : 'MOCK PROVIDERS (real generation not armed)';
  }

  /**
   * Apply the gates: use the cloud GPU provider when allowed, and route the AI
   * slots to the cloud worker only when real generation is armed. Refuses to
   * switch away while a cloud GPU is still running (stop it first).
   */
  refresh(): StudioMode {
    const activeCloud = this.d.gpuRepo.active().filter((i) => i.provider === this.cloudProvider.id);
    const wantGpu = this.canProvision();
    const wantReal = wantGpu && this.realArmed();
    if (!wantGpu && activeCloud.length > 0)
      throw new AppError(
        'CONFLICT',
        'A cloud GPU is still running: press Stop GPU (or Emergency Stop) first.',
      );
    if (wantGpu && this.d.gpu.currentProvider !== this.cloudProvider) {
      if (this.d.gpuRepo.active().some((i) => i.provider !== this.cloudProvider.id))
        throw new AppError('CONFLICT', 'Another GPU session is active; wait for it to finish.');
      this.d.gpu.useProvider(this.cloudProvider);
    } else if (!wantGpu && this.d.gpu.currentProvider === this.cloudProvider) {
      this.d.gpu.useProvider(this.fallbackGpu);
    }
    const p = this.d.providers;
    if (wantReal && !this.saved) {
      this.saved = {
        image: p.image,
        video: p.video,
        upscaler: p.upscaler,
        tts: p.tts,
        music: p.music,
        sfx: p.sfx,
        lipsync: p.lipsync,
        gpu: p.gpu,
      };
      Object.assign(p, this.bridge.providers(), { gpu: this.d.gpu.currentProvider });
      this.d.logger.warn('REAL CLOUD generation armed', { provider: this.cloudProvider.id });
    } else if (!wantReal && this.saved) {
      Object.assign(p, this.saved);
      this.saved = null;
      this.d.logger.info('real cloud generation disarmed; mock providers restored');
    }
    if (!this.saved) p.gpu = this.d.gpu.currentProvider;
    return this.mode();
  }

  // --- worker binding -------------------------------------------------------------------

  private validationProbe(): ((path: string) => Promise<string | null>) | undefined {
    const ff = this.d.ffmpeg;
    if (!ff) return undefined;
    return async (path) => {
      try {
        const { stdout } = await runTool(
          ff.ffprobe,
          ['-v', 'error', '-print_format', 'json', '-show_streams', path],
          {
            timeoutMs: 60_000,
          },
        );
        const streams = (JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> }).streams ?? [];
        return streams.some((s) => s.codec_type === 'video') ? null : 'no video stream';
      } catch (err) {
        return `unreadable by ffprobe (${(err as Error).message.slice(0, 120)})`;
      }
    };
  }

  newWorkerClient(url: string, token: string): WorkerClient {
    const probe = this.validationProbe();
    return new WorkerClient({
      baseUrl: url,
      token,
      timeoutSec: this.d.env.workerTimeoutSec,
      pollMs: this.d.workerPollMs ?? 2000,
      maxPollMs: (this.d.workerPollMs ?? 2000) * 3,
      validation: { tmpDir: storagePaths(this.d.env).downloadCache, ...(probe ? { probe } : {}) },
      ...(this.d.sleep ? { sleep: this.d.sleep } : {}),
    });
  }

  private async bindWorker(inst: GpuInstance, url: string, token: string): Promise<void> {
    const client = this.newWorkerClient(url, token);
    await client.health();
    const models = await client.models();
    this.bridge.bind(inst.id, client, models);
    this.lastHealthAt = this.d.clock.now().toISOString();
    this.d.logger.info('cloud worker bound', { instance: inst.id, models: models.length });
  }

  // --- connection test and diagnostics (never provisions anything) -------------------------

  async testConnection(): Promise<{ ok: boolean; detail: string; contract?: ContractReport }> {
    const at = this.d.clock.now().toISOString();
    try {
      const api = this.api();
      const { detail } = await api.testConnection();
      const contract = await api.checkContract();
      const cdetail = contract.checked
        ? contract.ok
          ? 'API contract verified against RunPod’s published openapi.json.'
          : `WARNING: RunPod’s API changed (${[...contract.missingPaths, ...contract.missingCreateFields, ...contract.notes].join(', ')}). Provisioning is blocked until the app is updated.`
        : `Contract not verified: ${contract.notes.join(' ')}`;
      this.lastConnection = { ok: contract.ok || !contract.checked, detail: `${detail} ${cdetail}`, at };
      return { ok: this.lastConnection.ok, detail: this.lastConnection.detail, contract };
    } catch (err) {
      const e = toAppError(err);
      this.lastConnection = { ok: false, detail: e.message, at };
      return { ok: false, detail: e.message };
    }
  }

  /** Minimum VRAM a cloud GPU needs for the enabled image and video models (and the GPU setting). */
  minVramGb(): number {
    return Math.max(this.d.settings.get('gpu').minVramGb, this.d.models.minVramFor(['image', 'video']));
  }

  async offers(): Promise<Array<GpuOffer & { withinLimit: boolean }>> {
    const limits = effectiveLimits(this.d.settings, this.d.env, true);
    return (await this.cloudProvider.listOffers(this.minVramGb()))
      .map((o) => ({ ...o, withinLimit: o.available && o.hourlyRateInr <= limits.maxHourlyRateInr }))
      .sort((a, b) => a.hourlyRateInr - b.hourlyRateInr);
  }

  /** Can RunPod pull the worker image anonymously? Distinguishes public / private / missing / unreachable. */
  async checkImage(image: string): Promise<DiagnosticStep & { result: ImageCheckResult }> {
    const result = await checkImagePullable(image, {
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
      ...(this.d.registryBaseUrlFor ? { baseUrlFor: this.d.registryBaseUrlFor } : {}),
    });
    const advice: Record<ImageCheckResult['status'], string> = {
      PUBLIC: '',
      AUTH_REQUIRED:
        ' Make the package public (RUNPOD_SETUP.md step 3), or push it first if you never did. Nothing was rented.',
      NOT_FOUND: ' Build and push the worker image (RUNPOD_SETUP.md step 3). Nothing was rented.',
      UNREACHABLE: ' This says nothing about the image itself; run the diagnostics again later.',
      INVALID: ' Fix the name under Cloud GPU → Advanced → Worker image.',
    };
    this.lastImageCheck = { ...result, at: this.d.clock.now().toISOString() };
    return {
      step: 'Worker image',
      ok: result.status === 'PUBLIC' ? true : result.status === 'UNREACHABLE' ? null : false,
      detail: `${IMAGE_STATUS_LABEL[result.status]} — ${result.detail}${advice[result.status]}`,
      result,
    };
  }

  /** Throws unless RunPod can pull the worker image without credentials. Rents nothing. */
  async assertImagePullable(image = this.workerImage()): Promise<ImageCheckResult> {
    const { result, detail } = await this.checkImage(image);
    if (result.status !== 'PUBLIC') throw new AppError('PRECONDITION_FAILED', `No GPU was rented. ${detail}`);
    return result;
  }

  workerImage(): string {
    return this.d.env.cloudWorkerImage || this.d.settings.get('cloud').workerImage;
  }

  /** The dry-run GPU step: VRAM filter, price ceiling and stock, with a useful reason when nothing fits. */
  private async gpuStep(): Promise<DiagnosticStep> {
    const step = 'Compatible GPUs and price';
    const limits = effectiveLimits(this.d.settings, this.d.env, true);
    const minVram = this.minVramGb();
    const cloud = this.d.settings.get('cloud').cloudType;
    try {
      const offers = await this.offers();
      const api = this.api();
      const notes = api instanceof RunPodApi ? api.catalogNotes.join(' ') : '';
      const tail = notes ? ` [${notes}]` : '';
      const priced = offers.filter((o) => Number.isFinite(o.hourlyRateInr));
      const good = offers.filter((o) => o.withinLimit);
      const stockUnknown = notes.includes('no GPU is treated as available');
      if (good.length) {
        const best = good[0]!;
        return {
          step,
          ok: true,
          detail: `${good.length} GPU type(s) with ≥ ${minVram} GB VRAM in stock for pods in ${cloud.toLowerCase()} cloud (CUDA ≥ ${WORKER_MIN_CUDA}) at or below your ₹${limits.maxHourlyRateInr}/h limit; cheapest: ${best.gpuModel} (${best.vramGb} GB) at ₹${best.hourlyRateInr}/h, ${best.region}.${tail}`,
        };
      }
      let why: string;
      if (!offers.length)
        why = `RunPod lists no GPU type with at least ${minVram} GB VRAM${this.d.settings.get('cloud').allowedGpuTypes.trim() ? ' among your allowed GPU types' : ''}.`;
      else if (!priced.length)
        why = `RunPod listed ${offers.length} GPU type(s) with ≥ ${minVram} GB VRAM but none has a ${cloud.toLowerCase()}-cloud price, so none can be rented safely. Try the other cloud type under Advanced.`;
      else if (stockUnknown)
        why = `RunPod listed ${priced.length} priced GPU type(s) with ≥ ${minVram} GB VRAM, but did not report stock, so none is treated as available (a price is not availability).`;
      else if (!priced.some((o) => o.available))
        why = `The ${priced.length} compatible GPU type(s) (≥ ${minVram} GB VRAM, CUDA ≥ ${WORKER_MIN_CUDA}) are out of stock for pods in ${cloud.toLowerCase()} cloud right now. Try later or allow Community Cloud.`;
      else {
        const cheapest = priced.filter((o) => o.available)[0]!;
        why = `No compatible GPU is currently available below your configured hourly price (₹${limits.maxHourlyRateInr}/h). Cheapest compatible in stock: ${cheapest.gpuModel} (${cheapest.vramGb} GB) at ₹${cheapest.hourlyRateInr}/h. Raise the limit or allow Community Cloud.`;
      }
      return { step, ok: false, detail: `${why}${tail}` };
    } catch (err) {
      return { step, ok: false, detail: toAppError(err).message };
    }
  }

  /** Dry run: configuration, credentials, connectivity, contract, GPUs and prices, image, models, limits. Never provisions. */
  async diagnostics(): Promise<DiagnosticStep[]> {
    const steps: DiagnosticStep[] = [];
    for (const g of this.gates()) steps.push({ step: `Gate: ${g.name}`, ok: g.ok, detail: g.detail });
    const conn = await this.testConnection();
    steps.push({ step: 'API credentials and connectivity', ok: conn.ok, detail: conn.detail });
    if (conn.ok) steps.push(await this.gpuStep());
    const { result: _image, ...imageStep } = await this.checkImage(this.workerImage());
    steps.push(imageStep);
    for (const kind of ['image', 'video', 'tts', 'music', 'sfx'] as const) {
      const m = this.d.models.selected(kind);
      steps.push({
        step: `Model: ${kind}`,
        ok: m ? true : kind === 'music' || kind === 'sfx' ? null : false,
        detail: m
          ? `${m.name} (${m.license}${m.commercialUse === 'conditional' ? ', conditional — acknowledged' : ''})`
          : `none usable (${this.d.models
              .states()
              .filter((s) => s.type === kind)
              .map((s) => `${s.name}: ${s.blockedReason}`)
              .join('; ')})`,
      });
    }
    const l = effectiveLimits(this.d.settings, this.d.env, true);
    steps.push({
      step: 'Cost limits',
      ok: true,
      detail: `max ₹${l.maxHourlyRateInr}/h · session budget ₹${l.sessionBudgetInr} · idle ${l.idleMinutes} min · lifetime ${l.maxLifetimeMinutes} min · ${l.maxConcurrent} GPU at a time${l.cappedBy.length ? ` · capped by .env: ${l.cappedBy.join(', ')}` : ''}`,
    });
    return steps;
  }

  // --- status ----------------------------------------------------------------------------

  activeInstance(): GpuInstance | undefined {
    return this.d.gpuRepo.active().find((i) => i.provider === this.cloudProvider.id);
  }

  status(): CloudStatus {
    const inst = this.activeInstance();
    const now = this.d.clock.now().getTime();
    return {
      mode: this.mode(),
      modeLabel: this.modeLabel(),
      gates: this.gates(),
      canProvision: this.canProvision(),
      realArmed: this.realArmed(),
      provider: this.d.settings.get('cloud').provider,
      apiKey: this.d.secrets.masked('runpodApiKey'),
      apiKeySource: this.d.secrets.source('runpodApiKey'),
      connection: this.lastConnection,
      instance: inst
        ? {
            id: inst.id,
            podId: inst.provider_instance_id,
            state: inst.lifecycle_state ?? inst.status,
            gpu: inst.gpu_model,
            vramGb: inst.vram_gb,
            hourlyRateInr: inst.hourly_rate_inr,
            runtimeSec: Math.max(0, Math.round((now - new Date(inst.created_at).getTime()) / 1000)),
            spentInr: Math.round(this.d.gpu.sessionSpendInr(inst) * 100) / 100,
            sessionBudgetInr: inst.session_budget_inr ?? null,
            workerHealthy: this.bridge.isBound(inst.id),
            purpose: inst.purpose ?? 'generation',
          }
        : null,
      limits: effectiveLimits(this.d.settings, this.d.env, true),
      recovery: this.lastRecovery,
    };
  }

  // --- stopping ----------------------------------------------------------------------------

  /** Stop GPU: terminate the studio's running cloud GPU(s) (running jobs fail and can be retried). */
  async stopGpu(): Promise<number> {
    let n = 0;
    for (const inst of this.d.gpuRepo.active().filter((i) => i.provider === this.cloudProvider.id))
      if (await this.d.gpu.terminate(inst.id, 'user_stop')) n++;
    return n;
  }

  /**
   * EMERGENCY STOP GPU: terminate every GPU this installation tracks AND every
   * pod at the provider whose name marks it as created by this installation —
   * in any mode, even if the database lost track of it. Never touches pods
   * the studio did not create.
   */
  async emergencyStop(confirm: string): Promise<{ terminated: string[]; failed: string[] }> {
    if (confirm !== 'STOP') throw new AppError('PRECONDITION_FAILED', 'Emergency stop needs confirmation.');
    const terminated: string[] = [];
    const failed: string[] = [];
    for (const inst of this.d.gpuRepo.active()) {
      if (await this.d.gpu.terminate(inst.id, 'emergency_stop')) terminated.push(inst.provider_instance_id);
      else failed.push(inst.provider_instance_id);
    }
    let pods: CloudPod[] = [];
    try {
      pods = await this.api().listPods();
    } catch (err) {
      if (toAppError(err).code !== 'CLOUD_AUTH_FAILED' || this.d.secrets.source('runpodApiKey') !== 'none')
        failed.push(`provider scan failed: ${toAppError(err).message}`);
    }
    const prefix = ownedPodPrefix(this.installId);
    for (const pod of pods) {
      if (!pod.name.startsWith(prefix) || pod.state === 'terminated' || terminated.includes(pod.id)) continue;
      try {
        await this.api().terminatePod(pod.id);
        terminated.push(pod.id);
        const local = this.d.gpuRepo.byProviderId(this.cloudProvider.id, pod.id);
        if (local)
          this.d.gpuRepo.update(local.id, {
            status: 'terminated',
            lifecycle_state: 'STOPPED',
            terminated_at: this.d.clock.now().toISOString(),
            termination_reason: 'emergency_stop',
          });
      } catch (err) {
        failed.push(`${pod.id}: ${toAppError(err).message}`);
      }
    }
    this.bridge.unbind();
    this.d.logger.warn('EMERGENCY STOP GPU used', { terminated: terminated.length, failed: failed.length });
    return { terminated, failed };
  }

  // --- crash recovery ------------------------------------------------------------------------

  /**
   * On start-up: requeue interrupted jobs (keeping remote job ids), find
   * cloud GPUs this installation created, re-attach usable ones (idle timer
   * keeps running) and terminate the rest, so nothing is left billing.
   */
  async recoverOnStartup(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      at: this.d.clock.now().toISOString(),
      jobsRecovered: this.d.jobs.recoverInterrupted(),
      ownedPods: [],
      terminated: [],
      reattachable: [],
      warnings: [],
    };
    const tracked = this.d.gpuRepo.active().filter((i) => i.provider === this.cloudProvider.id);
    let pods: CloudPod[] | null = null;
    if (
      this.d.secrets.source('runpodApiKey') !== 'none' &&
      this.d.settings.get('cloud').provider === 'runpod'
    ) {
      try {
        pods = await this.api().listPods();
      } catch (err) {
        report.warnings.push(`Could not check RunPod for leftover GPUs: ${toAppError(err).message}`);
      }
    } else if (tracked.length) {
      report.warnings.push(
        `${tracked.length} cloud GPU(s) were running when the app closed, but no API key is available to check them. Add the key, or terminate them in the RunPod console.`,
      );
    }
    if (pods) {
      const prefix = ownedPodPrefix(this.installId);
      const owned = pods.filter((p) => p.name.startsWith(prefix) && p.state !== 'terminated');
      report.ownedPods = owned.map((p) => ({ id: p.id, name: p.name, state: p.rawStatus, gpu: p.gpuName }));
      const usable = this.d.gpu.currentProvider === this.cloudProvider;
      for (const pod of owned) {
        const local = tracked.find((t) => t.provider_instance_id === pod.id);
        if (usable && local && local.status === 'running' && pod.state === 'running') {
          // Keep it: the idle timer (from its last activity) and max lifetime still apply.
          this.d.gpuRepo.update(local.id, { lifecycle_state: 'IDLE' });
          report.reattachable.push(pod.id);
          continue;
        }
        try {
          await this.api().terminatePod(pod.id);
          report.terminated.push(pod.id);
        } catch (err) {
          report.warnings.push(`Failed to terminate leftover GPU ${pod.id}: ${toAppError(err).message}`);
        }
      }
      const ownedIds = new Set(owned.map((p) => p.id));
      for (const t of tracked) {
        if (report.reattachable.includes(t.provider_instance_id)) continue;
        if (!ownedIds.has(t.provider_instance_id) || report.terminated.includes(t.provider_instance_id))
          this.d.gpuRepo.update(t.id, {
            status: 'terminated',
            lifecycle_state: 'STOPPED',
            terminated_at: this.d.clock.now().toISOString(),
            termination_reason: 'recovered_after_restart',
          });
      }
    }
    if (report.terminated.length || report.reattachable.length || report.warnings.length)
      this.d.logger.warn('cloud recovery on start-up', { ...report });
    this.lastRecovery = report;
    return report;
  }
}
