import { AppError } from '../../lib/errors.ts';
import type { ModelCategory, ModelManager } from '../../services/model-manager.ts';
import type {
  ImageModel,
  ImageRequest,
  LipSyncProvider,
  LipSyncRequest,
  ModelResult,
  MusicProvider,
  MusicRequest,
  ProviderInfo,
  RunContext,
  SfxRequest,
  SoundEffectProvider,
  TextToSpeechProvider,
  TtsRequest,
  Upscaler,
  UpscaleRequest,
  VideoModel,
  VideoRequest,
} from '../types.ts';
import type { WorkerClient, WorkerModel } from '../worker/client.ts';
import {
  WorkerImageModel,
  WorkerLipSync,
  WorkerMusic,
  WorkerSfx,
  WorkerTts,
  WorkerUpscaler,
  WorkerVideoModel,
} from '../worker/providers.ts';

type Bound = {
  image: WorkerImageModel;
  video: WorkerVideoModel;
  upscaler: WorkerUpscaler;
  tts: WorkerTts;
  music: WorkerMusic;
  sfx: WorkerSfx;
  lipsync: WorkerLipSync;
};

const KIND: Record<keyof Bound, ModelCategory> = {
  image: 'image',
  video: 'video',
  upscaler: 'upscale',
  tts: 'tts',
  music: 'music',
  sfx: 'sfx',
  lipsync: 'lipsync',
};

/**
 * REAL CLOUD provider slots. The studio's ProviderSet points at these stable
 * wrappers; each cloud GPU session binds (and later unbinds) the actual worker
 * behind them. Every wrapper reports `cloud_gpu` + `requiresPaidResources`,
 * so the queue batches the work into a supervised GPU session and the cost
 * gates always apply. Without a bound session, calls fail clearly — they never
 * fall back to mock output.
 */
export class CloudWorkerBridge {
  instanceId: string | null = null;
  client: WorkerClient | null = null;
  workerModels: WorkerModel[] = [];
  private bound: Bound | null = null;
  private readonly models: ModelManager;

  constructor(models: ModelManager) {
    this.models = models;
  }

  bind(instanceId: string, client: WorkerClient, workerModels: WorkerModel[]): void {
    const mock = workerModels.filter((m) => m.mock);
    if (mock.length)
      throw new AppError(
        'MOCK_MODE_REQUIRED',
        `The cloud worker is running mock models (${mock.map((m) => m.id).join(', ')}); refusing to treat them as real generation.`,
      );
    const pick = (kind: WorkerModel['kind']) => {
      const wanted = this.models.selected(kind as ModelCategory)?.id;
      return (
        workerModels.find((m) => m.kind === kind && m.id === wanted) ??
        workerModels.find((m) => m.kind === kind && m.default) ??
        workerModels.find((m) => m.kind === kind)
      );
    };
    this.bound = {
      image: new WorkerImageModel(client, pick('image')),
      video: new WorkerVideoModel(client, pick('video')),
      upscaler: new WorkerUpscaler(client, pick('upscale')),
      tts: new WorkerTts(client, pick('tts')),
      music: new WorkerMusic(client, pick('music')),
      sfx: new WorkerSfx(client, pick('sfx')),
      lipsync: new WorkerLipSync(client, pick('lipsync')),
    };
    this.instanceId = instanceId;
    this.client = client;
    this.workerModels = workerModels;
    for (const m of workerModels) {
      const cached = (m as WorkerModel & { cached?: boolean }).cached;
      if (typeof cached === 'boolean') this.models.cachedState.set(m.id, cached);
    }
  }

  unbind(instanceId?: string): void {
    if (instanceId && instanceId !== this.instanceId) return;
    this.bound = null;
    this.instanceId = null;
    this.client = null;
    this.workerModels = [];
  }

  isBound(instanceId: string): boolean {
    return this.bound !== null && this.instanceId === instanceId;
  }

  /** Static info before a session exists: taken from the local model catalog (same ids/versions as the worker). */
  info(slot: keyof Bound): ProviderInfo {
    const real = this.bound?.[slot].info;
    const kind = KIND[slot];
    const selected = this.models.selected(kind);
    const base: ProviderInfo = real ?? {
      id: selected?.id ?? `cloud-${kind}-none`,
      displayName: selected ? `${selected.name} (cloud)` : `No ${kind} model enabled`,
      isMock: false,
      openSource: true,
      computeLocation: 'cloud_gpu',
      requiresPaidResources: true,
      minVramGb: selected?.minVramGb ?? 0,
      modelVersion: selected?.revision ?? 'n/a',
      license: selected?.license ?? 'n/a',
    };
    return { ...base, isMock: false, computeLocation: 'cloud_gpu', requiresPaidResources: true };
  }

  use<K extends keyof Bound>(slot: K): Bound[K] {
    const kind = KIND[slot];
    if (!this.models.selected(kind))
      throw new AppError(
        'PRECONDITION_FAILED',
        `No ${kind} model is enabled for cloud generation. Enable one in Settings → Cloud GPU → Models (and acknowledge its licence if required).`,
      );
    if (!this.bound) throw new AppError('WORKER_UNAVAILABLE', 'No cloud GPU session is running.');
    const model = this.bound[slot];
    if (model.info.id.endsWith('-missing'))
      throw new AppError(
        'MODEL_LOAD_FAILED',
        `The cloud worker did not load a ${kind} model (check its licence acknowledgement).`,
      );
    return model;
  }

  providers(): {
    image: ImageModel;
    video: VideoModel;
    upscaler: Upscaler;
    tts: TextToSpeechProvider;
    music: MusicProvider;
    sfx: SoundEffectProvider;
    lipsync: LipSyncProvider;
  } {
    const b = this;
    return {
      image: {
        get info() {
          return b.info('image');
        },
        generate: (req: ImageRequest, ctx: RunContext): Promise<ModelResult> =>
          b.use('image').generate(req, ctx),
      },
      video: {
        get info() {
          return b.info('video');
        },
        animate: (req: VideoRequest, ctx: RunContext) => b.use('video').animate(req, ctx),
      },
      upscaler: {
        get info() {
          return b.info('upscaler');
        },
        upscale: (req: UpscaleRequest, ctx: RunContext) => b.use('upscaler').upscale(req, ctx),
      },
      tts: {
        get info() {
          return b.info('tts');
        },
        synthesize: (req: TtsRequest, ctx: RunContext) => b.use('tts').synthesize(req, ctx),
      },
      music: {
        get info() {
          return b.info('music');
        },
        compose: (req: MusicRequest, ctx: RunContext) => b.use('music').compose(req, ctx),
      },
      sfx: {
        get info() {
          return b.info('sfx');
        },
        create: (req: SfxRequest, ctx: RunContext) => b.use('sfx').create(req, ctx),
      },
      lipsync: {
        get info() {
          return b.info('lipsync');
        },
        sync: (req: LipSyncRequest, ctx: RunContext) => b.use('lipsync').sync(req, ctx),
      },
    };
  }
}
