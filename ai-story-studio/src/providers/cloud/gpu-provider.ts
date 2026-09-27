import type { AppEnv } from '../../config/env.ts';
import type { CloudLifecycleState } from '../../domain/enums.ts';
import { AppError, toAppError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { SecretStore } from '../../services/secrets.ts';
import type { CloudSettings, GpuSettings } from '../../services/settings.ts';
import { WorkerClient, type WorkerSystem } from '../worker/client.ts';
import type { GPUProvider, GpuOffer, ProviderInstance, WorkerEndpoint } from '../types.ts';
import { realSleep, type SleepFn } from './http.ts';
import type { CloudGpuApi, CloudPodSpec, CloudProviderId } from './types.ts';
import { BOOTSTRAP_ENTRYPOINT, bootstrapScript, workerBundle } from './worker-bundle.ts';

/** Every pod this installation creates is named `ais-<installId>-<random>`; only those are ever touched. */
export const POD_NAME_PREFIX = 'ais-';
export const WORKER_PORT = 8765;
/**
 * The worker image is built on PyTorch 2.7.1 + CUDA 12.6 (worker/Dockerfile.cuda), so it needs a
 * host whose driver supports CUDA 12.6 or newer. Used for the availability query and pod create.
 */
export const WORKER_MIN_CUDA = '12.6';
/** Must match STUDIO_TAG in services/gpu-supervisor.ts (kept literal to avoid an import cycle). */
const STUDIO_TAG = 'ai-story-studio';

export interface CloudGpuProviderDeps {
  /** Resolved on every use, so a newly saved API key takes effect without a restart. */
  api: () => CloudGpuApi;
  providerId: CloudProviderId;
  secrets: SecretStore;
  installId: string;
  env: AppEnv;
  logger: Logger;
  cloud: () => CloudSettings;
  gpu: () => GpuSettings;
  /** Current effective idle / lifetime limits in minutes (for the pod-side guard). */
  limits: () => { idleMinutes: number; maxLifetimeMinutes: number };
  sleep?: SleepFn;
  now?: () => number;
  /** Tests: worker poll interval. */
  pollMs?: number;
  /** Per-session worker settings (enabled models, acknowledged licences). */
  extraEnv?: () => Record<string, string>;
  /** Refuses (throws) when the worker image cannot be pulled; runs before anything is rented. */
  preflightImage?: (image: string) => Promise<void>;
  /** The app's worker folder (bootstrap pods receive their code from here). */
  workerDir?: string;
}

/** The image a pod runs: the public base image (bootstrap) or a prebuilt worker image. */
export function effectiveWorkerImage(env: AppEnv, cloud: CloudSettings): string {
  if (usesBootstrap(env, cloud)) return cloud.bootstrapImage;
  return env.cloudWorkerImage || cloud.workerImage;
}

/** Bootstrap unless the person chose a prebuilt image (setting, or CLOUD_WORKER_IMAGE in .env). */
export function usesBootstrap(env: AppEnv, cloud: CloudSettings): boolean {
  return cloud.workerSource === 'bootstrap' && !env.cloudWorkerImage;
}

/** Minutes a bootstrap pod may take to install its libraries on first use. */
const BOOTSTRAP_MIN_TIMEOUT_MS = 25 * 60_000;

export function ownedPodPrefix(installId: string): string {
  return `${POD_NAME_PREFIX}${installId}-`;
}

/**
 * Adapts a CloudGpuApi (RunPod) to the studio's GPUProvider interface.
 *
 * Provisioning creates a pod running the AI worker image with a fresh random
 * worker token (never reused, never logged, stored only in the local secret
 * store for crash recovery). `awaitReady` then walks BOOTING → WORKER_STARTING
 * → READY by polling the provider and the worker's authenticated API.
 */
export class CloudGpuProvider implements GPUProvider {
  readonly id: string;
  readonly isMock = false;
  readonly paid = true;
  readonly local = false;
  private readonly d: CloudGpuProviderDeps;
  private readonly sleep: SleepFn;
  private readonly now: () => number;

  constructor(deps: CloudGpuProviderDeps) {
    this.d = deps;
    this.id = deps.providerId;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
  }

  get api(): CloudGpuApi {
    return this.d.api();
  }

  private allowed(): Set<string> {
    return new Set(
      this.d
        .cloud()
        .allowedGpuTypes.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  async listOffers(minVramGb: number): Promise<GpuOffer[]> {
    const cloud = this.d.cloud();
    const allowed = this.allowed();
    const types = await this.d.api().listGpuTypes(cloud.cloudType, { minCudaVersion: WORKER_MIN_CUDA });
    return types
      .filter((t) => t.vramGb >= minVramGb && (allowed.size === 0 || allowed.has(t.id)))
      .map((t) => ({
        offerId: t.id,
        gpuModel: t.displayName,
        vramGb: t.vramGb,
        hourlyRateInr:
          t.hourlyUsd === null
            ? Number.POSITIVE_INFINITY
            : Math.round(t.hourlyUsd * cloud.usdToInr * 100) / 100,
        // Rentable only with a reported price AND reported stock: a price alone never means "available".
        available: t.available === true && t.hourlyUsd !== null,
        region: `${this.d.api().displayName} ${cloud.cloudType.toLowerCase()}${t.stock ? ` · stock ${t.stock}` : ''}`,
      }));
  }

  private image(): string {
    return effectiveWorkerImage(this.d.env, this.d.cloud());
  }

  private bootstrap(): boolean {
    return usesBootstrap(this.d.env, this.d.cloud());
  }

  async provision(
    offer: GpuOffer,
    tags: string[],
  ): Promise<{ providerInstanceId: string; startupSeconds: number }> {
    if (!tags.includes(STUDIO_TAG))
      throw new AppError('PRECONDITION_FAILED', 'Cloud resources must carry the studio tag');
    const cloud = this.d.cloud();
    // A pod whose image cannot be pulled never starts but may still be billed: check first.
    if (!cloud.registryAuthId) await this.d.preflightImage?.(this.image());
    const token = SecretStore.newWorkerToken();
    const suffix = Math.random().toString(36).slice(2, 8);
    const limits = this.d.limits();
    const env: Record<string, string> = {
      WORKER_AUTH_TOKEN: token,
      WORKER_HOST: '0.0.0.0',
      WORKER_PORT: String(WORKER_PORT),
      WORKER_MOCK_MODELS: 'false',
      WORKER_ALLOW_NONCOMMERCIAL: 'false',
      WORKER_MODEL_CACHE_DIR: '/workspace/models',
      HF_HOME: '/workspace/hf',
      AIS_OWNER: this.d.installId,
      // Pod-side dead-man switch (worker/ais_worker/pod_guard.py): a backup for when this PC is off.
      AIS_POD_MAX_LIFETIME_MIN: String(Math.ceil(limits.maxLifetimeMinutes + 5)),
      AIS_POD_IDLE_MIN: String(Math.ceil(limits.idleMinutes + 10)),
    };
    Object.assign(env, { WORKER_MODELS_FILE: '/app/models.cloud.json' }, this.d.extraEnv?.() ?? {});
    const hf = this.d.secrets.get('hfToken');
    if (hf) env['HF_TOKEN'] = hf;
    const bootstrap = this.bootstrap();
    if (bootstrap) {
      if (!this.d.workerDir)
        throw new AppError('PRECONDITION_FAILED', 'The AI worker code location is not configured.');
      const bundle = workerBundle(this.d.workerDir);
      Object.assign(env, {
        AIS_BOOTSTRAP: bootstrapScript(this.d.workerDir),
        AIS_CODE_SHA256: bundle.sha256,
        AIS_APP_DIR: '/app',
        AIS_PYENV_ROOT: '/workspace/ais-pyenv',
        AIS_BOOTSTRAP_WAIT_MIN: String(Math.ceil(limits.maxLifetimeMinutes / 2) || 20),
        WORKER_DATA_DIR: '/workspace/worker-data',
        WORKER_MAX_UPLOAD_MB: '128',
        PYTHONUNBUFFERED: '1',
      });
    }
    const spec: CloudPodSpec = {
      name: `${ownedPodPrefix(this.d.installId)}${suffix}`,
      image: this.image(),
      gpuTypeId: offer.offerId,
      gpuCount: 1,
      cloud: cloud.cloudType,
      env,
      ports: [`${WORKER_PORT}/http`],
      containerDiskGb: cloud.containerDiskGb,
      minCudaVersion: WORKER_MIN_CUDA,
      ...(cloud.networkVolumeId
        ? { volume: { kind: 'network' as const, volumeId: cloud.networkVolumeId, path: '/workspace' } }
        : cloud.volumeGb > 0
          ? { volume: { kind: 'persistent' as const, sizeGb: cloud.volumeGb, path: '/workspace' } }
          : {}),
      ...(cloud.registryAuthId && !bootstrap ? { registryAuthId: cloud.registryAuthId } : {}),
      ...(bootstrap ? { entrypoint: BOOTSTRAP_ENTRYPOINT } : {}),
    };
    const pod = await this.d.api().createPod(spec);
    this.d.secrets.saveWorkerToken(pod.id, token);
    this.d.logger.info('cloud pod created', {
      provider: this.id,
      pod: pod.id,
      gpu: offer.gpuModel,
      image: spec.image,
      workerSource: bootstrap ? 'bootstrap' : 'image',
    });
    return { providerInstanceId: pod.id, startupSeconds: 0 };
  }

  async terminate(providerInstanceId: string): Promise<void> {
    await this.d.api().terminatePod(providerInstanceId);
    this.d.secrets.forgetWorkerToken(providerInstanceId);
  }

  async listInstances(): Promise<ProviderInstance[]> {
    const prefix = ownedPodPrefix(this.d.installId);
    return (await this.d.api().listPods()).map((p) => ({
      providerInstanceId: p.id,
      // Ownership comes only from the name this installation gave the pod.
      tags: p.name.startsWith(prefix) ? [STUDIO_TAG] : [],
      status:
        p.state === 'terminated'
          ? 'terminated'
          : p.state === 'stopped'
            ? 'stopped'
            : p.state === 'running'
              ? 'running'
              : 'provisioning',
      gpuModel: p.gpuName ?? 'unknown GPU',
      hourlyRateInr: p.hourlyUsd === null ? 0 : Math.round(p.hourlyUsd * this.d.cloud().usdToInr * 100) / 100,
      createdAt: p.createdAt ?? '',
    }));
  }

  endpointFor(providerInstanceId: string): WorkerEndpoint | undefined {
    const token = this.d.secrets.workerToken(providerInstanceId);
    return token ? { url: this.d.api().workerUrl(providerInstanceId, WORKER_PORT), token } : undefined;
  }

  /**
   * A bootstrap pod answers /health with `bootstrapping` until the worker runs. Sends the worker
   * code when the pod asks for it, reports setup progress, and fails fast when setup failed.
   * Returns 'worker' when the real worker answers (or the pod is not a bootstrap pod).
   */
  private async bootstrapStep(
    endpoint: WorkerEndpoint,
    onState?: (s: CloudLifecycleState, detail: string) => void,
  ): Promise<'bootstrapping' | 'worker'> {
    const health = await fetch(`${endpoint.url}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await health.json().catch(() => ({}))) as { status?: string };
    if (body.status !== 'bootstrapping') return 'worker';
    const auth = { Authorization: `Bearer ${endpoint.token}` };
    const res = await fetch(`${endpoint.url}/bootstrap/status`, {
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401)
      throw new AppError('WORKER_UNAVAILABLE', 'The GPU setup rejected its session token.');
    const st = (await res.json()) as { stage: string; detail: string; error: string | null };
    if (st.stage === 'failed')
      throw new AppError(
        'PROVISION_FAILED',
        `The AI worker could not be set up on the GPU: ${(st.error ?? st.detail).slice(-400)}`,
      );
    if (st.stage === 'waiting_for_code') {
      const bundle = workerBundle(this.d.workerDir!);
      onState?.(
        'WORKER_STARTING',
        `sending the AI worker code (${Math.round(bundle.data.length / 1024)} KB)`,
      );
      const up = await fetch(`${endpoint.url}/bootstrap/code`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/gzip' },
        body: new Uint8Array(bundle.data),
        signal: AbortSignal.timeout(120_000),
      });
      if (up.status !== 202 && up.status !== 409) {
        const msg = ((await up.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${up.status}`;
        throw new AppError('PROVISION_FAILED', `The GPU refused the AI worker code: ${msg}`);
      }
      this.d.logger.info('worker code sent to bootstrap pod', { bytes: bundle.data.length });
    } else onState?.('WORKER_STARTING', `setting up the AI worker: ${st.detail}`);
    return 'bootstrapping';
  }

  /**
   * Wait until the pod runs AND the worker answers an authenticated request.
   * Throws WORKER_START_TIMEOUT after `timeoutMs`; the supervisor then terminates the pod.
   */
  async awaitReady(
    providerInstanceId: string,
    opts: {
      timeoutMs: number;
      signal?: AbortSignal;
      onState?: (s: CloudLifecycleState, detail: string) => void;
    },
  ): Promise<WorkerEndpoint> {
    const endpoint = this.endpointFor(providerInstanceId);
    if (!endpoint)
      throw new AppError(
        'WORKER_UNAVAILABLE',
        'The worker token for this GPU is missing; it cannot be used.',
      );
    const started = this.now();
    let deadline = started + opts.timeoutMs;
    const poll = this.d.pollMs ?? 5000;
    let state: CloudLifecycleState = 'BOOTING';
    opts.onState?.('BOOTING', 'waiting for the GPU machine to start');
    let lastError = '';
    let delay = poll;
    while (this.now() < deadline) {
      if (opts.signal?.aborted) throw new AppError('CANCELLED', 'Cancelled while the GPU was starting');
      const pod = await this.d.api().getPod(providerInstanceId);
      if (!pod)
        throw new AppError(
          'PROVISION_FAILED',
          'The GPU pod disappeared while starting (the provider removed it).',
        );
      if (pod.state === 'terminated' || pod.state === 'stopped')
        throw new AppError(
          'PROVISION_FAILED',
          `The GPU pod stopped while starting (status ${pod.rawStatus}).`,
        );
      if (pod.state === 'running') {
        if (state !== 'WORKER_STARTING') {
          state = 'WORKER_STARTING';
          opts.onState?.('WORKER_STARTING', 'GPU is running; waiting for the AI worker');
        }
        let system: WorkerSystem | null = null;
        const setup = await this.bootstrapStep(endpoint, opts.onState).catch((err: unknown) => {
          const e = toAppError(err);
          if (e.code === 'PROVISION_FAILED' || e.code === 'WORKER_UNAVAILABLE') throw e;
          lastError = e.message;
          return 'unknown' as const;
        });
        if (setup === 'bootstrapping') {
          // First-time library installation takes longer than a prebuilt image: allow for it.
          deadline = Math.max(deadline, started + BOOTSTRAP_MIN_TIMEOUT_MS);
          await this.sleep(delay);
          delay = Math.min(delay * 1.5, poll * 3);
          continue;
        }
        try {
          const client = new WorkerClient({ baseUrl: endpoint.url, token: endpoint.token, timeoutSec: 60 });
          await client.health();
          system = await client.system(); // authenticated: proves the token and the worker both work
        } catch (err) {
          lastError = toAppError(err).message;
          if (toAppError(err).code === 'FORBIDDEN')
            throw new AppError('WORKER_UNAVAILABLE', 'The cloud worker rejected its session token.');
        }
        if (system) {
          // Healthy but unusable: fail now (the caller terminates the pod) instead of waiting out the timeout.
          if (!system.gpu?.available)
            throw new AppError(
              'PROVISION_FAILED',
              `The rented machine reports no usable NVIDIA GPU (${system.gpu?.reason ?? 'none detected'}).`,
            );
          if (system.torch?.installed && !system.torch.cuda_available)
            throw new AppError(
              'PROVISION_FAILED',
              `The GPU is visible but PyTorch cannot use it${system.torch.error ? ` (${system.torch.error.slice(0, 120)})` : ''}. Check the worker image's CUDA version.`,
            );
          if (system.mock_models)
            throw new AppError(
              'PROVISION_FAILED',
              'The cloud worker started with placeholder models (WORKER_MOCK_MODELS). Check the worker image.',
            );
          const gpu = system.gpu.gpus[0];
          opts.onState?.(
            'READY',
            `worker healthy${gpu ? ` · ${gpu.name}, ${Math.round(gpu.vram_total_mb / 1024)} GB VRAM` : ''}${system.gpu.cuda_version ? ` · CUDA ${system.gpu.cuda_version}` : ''}`,
          );
          return endpoint;
        }
      }
      await this.sleep(delay);
      delay = Math.min(delay * 1.5, poll * 3);
    }
    const minutes = Math.round((deadline - started) / 60_000);
    throw new AppError(
      'WORKER_START_TIMEOUT',
      `Cloud worker did not become healthy within ${minutes} minute${minutes === 1 ? '' : 's'}${lastError ? ` (last error: ${lastError.slice(0, 160)})` : ''}.`,
    );
  }
}
