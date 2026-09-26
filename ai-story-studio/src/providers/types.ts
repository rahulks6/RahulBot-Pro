import type { CloudLifecycleState } from '../domain/enums.ts';
/**
 * Replaceable AI component interfaces (spec §19–§31, §40, §89).
 *
 * The application talks only to these interfaces. Phase 1 registers mock
 * implementations; later phases add adapters (e.g. FLUX/SDXL images, LTX/Wan
 * image-to-video, open-source TTS/music/SFX/lip-sync, RunPod/TensorDock/Vast
 * GPUs) without changing the rest of the application.
 */
import type { ErrorCode } from '../lib/errors.ts';
import type { QualityMode } from '../domain/enums.ts';

/** Where a component runs, used to pick the cheapest suitable location (local CPU vs rented GPU). */
export type ComputeLocation = 'local_cpu' | 'local_gpu' | 'cloud_gpu';

export interface ProviderInfo {
  id: string;
  displayName: string;
  isMock: boolean;
  openSource: boolean;
  computeLocation: ComputeLocation;
  /** True if using this provider can cost money (cloud GPU / paid API). Mocks are always false. */
  requiresPaidResources: boolean;
  /** Minimum VRAM a GPU must have to run this model (0 for CPU components). */
  minVramGb: number;
  modelVersion: string;
  license: string;
}

export interface RunContext {
  signal?: AbortSignal;
  /** Deterministic seed for mock behaviour (failures, timings). */
  attemptKey: string;
  /** 1-based attempt number of the job being executed. */
  attemptNumber?: number;
  /** Remote worker job tracking (cloud recovery): resume instead of resubmitting. */
  remote?: {
    resumeJobId?: string;
    onSubmitted?: (remoteJobId: string) => void;
    onDownloading?: () => void;
    /** Polled while waiting: true when the user cancelled the job (the remote job is cancelled too). */
    isCancelled?: () => boolean;
  };
}

export interface GeneratedFile {
  data: Uint8Array;
  mime: string;
  ext: string;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
}

export interface ModelResult {
  file: GeneratedFile;
  model: string;
  modelVersion: string;
  /** Seconds of compute the provider spent (simulated for mocks). */
  generationSeconds: number;
  /** True when the output was produced at the requested resolution rather than upscaled. */
  isNativeResolution: boolean;
  settings: Record<string, unknown>;
  logs: string[];
}

/** Error thrown by providers; the code drives retry decisions. */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export interface ReferenceInput {
  role: 'character' | 'location' | 'prop' | 'style' | 'image';
  storageKey: string;
  label: string;
}

export interface ImageRequest {
  mode: 'text_to_image' | 'image_to_image';
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  quality: QualityMode;
  references: ReferenceInput[];
  initImage?: Uint8Array;
  strength?: number;
  /** Approved character references for identity conditioning (IP-Adapter where the model supports it). */
  referenceImages?: Uint8Array[];
  referenceStrength?: number;
  settings: Record<string, unknown>;
}

export interface ImageModel {
  readonly info: ProviderInfo;
  generate(req: ImageRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface VideoRequest {
  /** Approved still image the clip must start from (image-first workflow). */
  image: Uint8Array;
  imageStorageKey: string;
  motionPrompt: string;
  negativePrompt: string;
  seed: number;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  quality: QualityMode;
  references: ReferenceInput[];
  /** 0 = barely moving … 1 = strong motion. */
  motionStrength?: number;
  cameraMovement?: string;
  settings: Record<string, unknown>;
}

export interface VideoModel {
  readonly info: ProviderInfo;
  animate(req: VideoRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface UpscaleRequest {
  kind: 'image' | 'video';
  source: Uint8Array;
  sourceMime: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}

export interface Upscaler {
  readonly info: ProviderInfo;
  upscale(req: UpscaleRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface VoiceSettings {
  voiceModel: string;
  voiceIdentity: string;
  presentation: 'male' | 'female' | 'neutral';
  pitch: number;
  speed: number;
  speakingStyle: string;
  referenceAudio?: Uint8Array;
}

export interface TtsRequest {
  text: string;
  language: string;
  emotion: string;
  speed: number;
  voice: VoiceSettings;
}

export interface TextToSpeechProvider {
  readonly info: ProviderInfo;
  synthesize(req: TtsRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface MusicRequest {
  mood: string;
  genre: string;
  energy: string;
  durationSec: number;
  storyContext: string;
}

export interface MusicProvider {
  readonly info: ProviderInfo;
  compose(req: MusicRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface SfxRequest {
  tag: string;
  durationSec: number;
  /** Ambience beds must loop cleanly. */
  loopable: boolean;
  description: string;
}

export interface SoundEffectProvider {
  readonly info: ProviderInfo;
  create(req: SfxRequest, ctx: RunContext): Promise<ModelResult>;
}

export interface LipSyncRequest {
  video: Uint8Array;
  videoMime: string;
  audio: Uint8Array;
  durationSec: number;
}

export interface LipSyncProvider {
  readonly info: ProviderInfo;
  sync(req: LipSyncRequest, ctx: RunContext): Promise<ModelResult>;
}

// ---------------------------------------------------------------------------
// GPU providers (spec §40–§44)
// ---------------------------------------------------------------------------

export interface GpuOffer {
  offerId: string;
  gpuModel: string;
  vramGb: number;
  hourlyRateInr: number;
  available: boolean;
  region: string;
}

export interface ProviderInstance {
  providerInstanceId: string;
  tags: string[];
  status: 'provisioning' | 'running' | 'stopped' | 'terminated';
  gpuModel: string;
  hourlyRateInr: number;
  createdAt: string;
}

/** How to reach the AI worker running on a provisioned GPU (cloud providers). */
export interface WorkerEndpoint {
  url: string;
  token: string;
}

export interface GPUProvider {
  readonly id: string;
  readonly isMock: boolean;
  /** True when using this provider can cost money (cloud rental). Paid providers need explicit enabling. */
  readonly paid: boolean;
  /** True for a machine we already own (local GPU worker): rental preferences such as minimum VRAM do not apply. */
  readonly local: boolean;
  listOffers(minVramGb: number): Promise<GpuOffer[]>;
  /** Create an instance tagged with `tags`. Must return quickly; readiness is polled separately. */
  provision(offer: GpuOffer, tags: string[]): Promise<{ providerInstanceId: string; startupSeconds: number }>;
  terminate(providerInstanceId: string): Promise<void>;
  /** All instances visible on the account (the watchdog filters by tag). */
  listInstances(): Promise<ProviderInstance[]>;
  /**
   * Cloud providers: wait until the instance runs and its worker answers an authenticated
   * request. Providers without it (mock, local worker) are usable immediately.
   */
  awaitReady?(
    providerInstanceId: string,
    opts: {
      timeoutMs: number;
      signal?: AbortSignal;
      onState?: (state: CloudLifecycleState, detail: string) => void;
    },
  ): Promise<WorkerEndpoint>;
  /** Cloud providers: the worker endpoint of an existing instance (crash recovery). */
  endpointFor?(providerInstanceId: string): WorkerEndpoint | undefined;
}

// ---------------------------------------------------------------------------
// Media probing (ffprobe in later phases, manifest-based for mock outputs)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  exists: boolean;
  readable: boolean;
  decodes: boolean;
  container: string;
  durationSec: number;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; sampleRate: number; channels: number; peakDb: number; clippedSamples: number };
  isMock: boolean;
  notes: string[];
}

export interface MediaProbe {
  readonly id: string;
  probe(storageKey: string): Promise<ProbeResult>;
}
