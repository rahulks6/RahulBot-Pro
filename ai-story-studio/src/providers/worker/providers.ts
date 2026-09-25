import type { ErrorCode } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import type {
  GPUProvider,
  GpuOffer,
  ImageModel,
  ImageRequest,
  LipSyncProvider,
  LipSyncRequest,
  ModelResult,
  MusicProvider,
  MusicRequest,
  ProviderInfo,
  ProviderInstance,
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
import { ProviderError } from '../types.ts';
import type { WorkerClient, WorkerJob, WorkerModel, WorkerOutput, WorkerSystem } from './client.ts';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'application/vnd.ai-story-studio.mock-video+json': 'json',
};

/** ProviderInfo derived from what the worker reports (mock flag, VRAM, licence). */
function infoFor(model: WorkerModel | undefined, kind: string): ProviderInfo {
  if (!model) {
    return {
      id: `worker-${kind}-missing`,
      displayName: `No ${kind} model on worker`,
      isMock: false,
      openSource: true,
      computeLocation: 'local_gpu',
      requiresPaidResources: false,
      minVramGb: 0,
      modelVersion: 'n/a',
      license: 'n/a',
    };
  }
  return {
    id: model.id,
    displayName: `${model.display_name} (worker)`,
    isMock: model.mock,
    openSource: true,
    computeLocation: model.device === 'cpu' ? 'local_cpu' : 'local_gpu',
    requiresPaidResources: false,
    minVramGb: model.mock ? 0 : model.min_vram_gb,
    modelVersion: model.version,
    license: model.license,
  };
}

/** Translate app-side mock controls into worker settings (attempt-aware failure injection stays in the app). */
function workerSettings(
  settings: Record<string, unknown> | undefined,
  ctx: RunContext,
  code: ErrorCode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const forced = settings?.['mockForceFailure'];
  const failFirst = settings?.['mockFailAttempts'];
  if (typeof forced === 'string' && forced) out['mock_fail'] = forced;
  else if (typeof failFirst === 'number' && (ctx.attemptNumber ?? 1) <= failFirst) out['mock_fail'] = code;
  return out;
}

function result(job: WorkerJob, file: { meta: WorkerOutput; data: Buffer }, info: ProviderInfo): ModelResult {
  const m = file.meta;
  return {
    file: {
      data: file.data,
      mime: m.mime,
      ext: EXT[m.mime] ?? 'json',
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.duration_sec ? { durationSec: m.duration_sec } : {}),
      ...(m.fps ? { fps: m.fps } : {}),
    },
    model: job.model.id ?? info.id,
    modelVersion: job.model.version ?? info.modelVersion,
    generationSeconds: (job.metrics['run_seconds'] ?? 0) + (job.metrics['load_seconds'] ?? 0),
    isNativeResolution: m.native_resolution,
    settings: { workerJob: job.id, workerModel: job.model.id, mock: m.mock },
    logs: job.logs.slice(-10),
  };
}

function first(
  files: Array<{ meta: WorkerOutput; data: Buffer }>,
  what: string,
): { meta: WorkerOutput; data: Buffer } {
  const f = files[0];
  if (!f) throw new ProviderError('DOWNLOAD_FAILED', `Worker returned no ${what}`);
  return f;
}

const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64');

export class WorkerImageModel implements ImageModel {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'image');
  }
  async generate(req: ImageRequest, ctx: RunContext): Promise<ModelResult> {
    const body: Record<string, unknown> = {
      model: this.info.id,
      prompt: req.prompt || 'untitled',
      negative_prompt: req.negativePrompt,
      seed: req.seed,
      width: req.width,
      height: req.height,
      quality: req.quality,
      settings: workerSettings(req.settings, ctx, 'IMAGE_GENERATION_FAILED'),
    };
    if (req.initImage) body['init_image'] = b64(req.initImage);
    const { job, files } = await this.client.run('/generate/image', body, ctx);
    return result(job, first(files, 'image'), this.info);
  }
}

export class WorkerVideoModel implements VideoModel {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'video');
  }
  async animate(req: VideoRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/generate/image-to-video',
      {
        model: this.info.id,
        image: b64(req.image),
        motion_prompt: req.motionPrompt,
        negative_prompt: req.negativePrompt,
        seed: req.seed,
        duration_sec: req.durationSec,
        fps: req.fps,
        width: req.width,
        height: req.height,
        quality: req.quality,
        settings: workerSettings(req.settings, ctx, 'VIDEO_GENERATION_FAILED'),
      },
      ctx,
    );
    return result(job, first(files, 'clip'), this.info);
  }
}

export class WorkerUpscaler implements Upscaler {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'upscale');
  }
  async upscale(req: UpscaleRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/process/upscale',
      {
        model: this.info.id,
        source: b64(req.source),
        target_width: req.targetWidth,
        target_height: req.targetHeight,
      },
      ctx,
    );
    return result(job, first(files, 'upscaled file'), this.info);
  }
}

export class WorkerTts implements TextToSpeechProvider {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'tts');
  }
  async synthesize(req: TtsRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/generate/audio',
      {
        kind: 'tts',
        model: this.info.id,
        text: req.text,
        language: req.language,
        emotion: req.emotion,
        speed: Math.min(2, Math.max(0.5, req.speed * req.voice.speed)),
        voice_identity: `${req.voice.voiceModel}:${req.voice.voiceIdentity}`,
        presentation: req.voice.presentation,
        pitch: req.voice.pitch,
        // Only present when the voice has an active consent record (VoiceReferenceService).
        ...(req.voice.referenceAudio
          ? {
              voice_reference: Buffer.from(req.voice.referenceAudio).toString('base64'),
              voice_reference_consent: true,
            }
          : {}),
      },
      ctx,
    );
    return result(job, first(files, 'audio'), this.info);
  }
}

export class WorkerMusic implements MusicProvider {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'music');
  }
  async compose(req: MusicRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/generate/audio',
      {
        kind: 'music',
        model: this.info.id,
        mood: req.mood,
        genre: req.genre,
        energy: req.energy,
        duration_sec: req.durationSec,
      },
      ctx,
    );
    return result(job, first(files, 'music'), this.info);
  }
}

export class WorkerSfx implements SoundEffectProvider {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'sfx');
  }
  async create(req: SfxRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/generate/audio',
      {
        kind: req.loopable ? 'ambience' : 'sfx',
        model: this.info.id,
        tag: req.tag,
        duration_sec: req.durationSec,
        loopable: req.loopable,
      },
      ctx,
    );
    return result(job, first(files, 'sound'), this.info);
  }
}

export class WorkerLipSync implements LipSyncProvider {
  readonly info: ProviderInfo;
  private readonly client: WorkerClient;
  constructor(client: WorkerClient, model: WorkerModel | undefined) {
    this.client = client;
    this.info = infoFor(model, 'lipsync');
  }
  async sync(req: LipSyncRequest, ctx: RunContext): Promise<ModelResult> {
    const { job, files } = await this.client.run(
      '/process/lipsync',
      { model: this.info.id, video: b64(req.video), audio: b64(req.audio) },
      ctx,
    );
    return result(job, first(files, 'lip-synced clip'), this.info);
  }
}

/**
 * GPU provider for a machine we own (the local worker). Nothing is rented:
 * "provisioning" verifies the worker is healthy, the hourly rate is ₹0 and
 * termination simply ends the session. It is never `paid`.
 */
export class LocalWorkerGpuProvider implements GPUProvider {
  readonly id = 'local-worker';
  readonly isMock = false;
  readonly paid = false;
  readonly local = true;
  private active: ProviderInstance | undefined;
  private readonly client: WorkerClient;
  private readonly system: WorkerSystem;

  constructor(client: WorkerClient, system: WorkerSystem) {
    this.client = client;
    this.system = system;
  }

  async listOffers(): Promise<GpuOffer[]> {
    const gpu = this.system.gpu.gpus[0];
    return [
      {
        offerId: 'local',
        gpuModel: gpu ? `${gpu.name} (local worker)` : 'Local worker (CPU only)',
        vramGb: gpu ? Math.floor(gpu.vram_total_mb / 1024) : 0,
        hourlyRateInr: 0,
        available: true,
        region: 'local',
      },
    ];
  }

  async provision(
    offer: GpuOffer,
    tags: string[],
  ): Promise<{ providerInstanceId: string; startupSeconds: number }> {
    await this.client.health();
    const providerInstanceId = newId('local');
    this.active = {
      providerInstanceId,
      tags,
      status: 'running',
      gpuModel: offer.gpuModel,
      hourlyRateInr: 0,
      createdAt: new Date().toISOString(),
    };
    return { providerInstanceId, startupSeconds: 0 };
  }

  async terminate(providerInstanceId: string): Promise<void> {
    if (this.active?.providerInstanceId === providerInstanceId)
      this.active = { ...this.active, status: 'terminated' };
  }

  async listInstances(): Promise<ProviderInstance[]> {
    return this.active ? [this.active] : [];
  }
}
