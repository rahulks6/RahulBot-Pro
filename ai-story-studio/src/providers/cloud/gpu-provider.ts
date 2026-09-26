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

/** Every pod this installation creates is named `ais-<installId>-<random>`; only those are ever touched. */
export const POD_NAME_PREFIX = 'ais-';
export const WORKER_PORT = 8765;
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
}

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
    const types = await this.d.api().listGpuTypes(cloud.cloudType);
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
        // A GPU without a reported price is never chosen automatically.
        available: t.available !== false && t.hourlyUsd !== null,
        region: `${this.d.api().displayName} ${cloud.cloudType.toLowerCase()}${t.stock ? ` · stock ${t.stock}` : ''}`,
      }));
  }

  private image(): string {
    return this.d.env.cloudWorkerImage || this.d.cloud().workerImage;
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
    const spec: CloudPodSpec = {
      name: `${ownedPodPrefix(this.d.installId)}${suffix}`,
      image: this.image(),
      gpuTypeId: offer.offerId,
      gpuCount: 1,
      cloud: cloud.cloudType,
      env,
      ports: [`${WORKER_PORT}/http`],
      containerDiskGb: cloud.containerDiskGb,
      ...(cloud.networkVolumeId
        ? { volume: { kind: 'network' as const, volumeId: cloud.networkVolumeId, path: '/workspace' } }
        : cloud.volumeGb > 0
          ? { volume: { kind: 'persistent' as const, sizeGb: cloud.volumeGb, path: '/workspace' } }
          : {}),
      ...(cloud.registryAuthId ? { registryAuthId: cloud.registryAuthId } : {}),
    };
    const pod = await this.d.api().createPod(spec);
    this.d.secrets.saveWorkerToken(pod.id, token);
    this.d.logger.info('cloud pod created', {
      provider: this.id,
      pod: pod.id,
      gpu: offer.gpuModel,
      image: spec.image,
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
    const deadline = this.now() + opts.timeoutMs;
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
    const minutes = Math.round(opts.timeoutMs / 60_000);
    throw new AppError(
      'WORKER_START_TIMEOUT',
      `Cloud worker did not become healthy within ${minutes} minute${minutes === 1 ? '' : 's'}${lastError ? ` (last error: ${lastError.slice(0, 160)})` : ''}.`,
    );
  }
}
