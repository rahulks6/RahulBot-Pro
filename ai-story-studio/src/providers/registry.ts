import type { AppEnv } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import type { StorageProvider } from '../storage/storage.ts';
import {
  MockLipSyncProvider,
  MockMusicProvider,
  MockSoundEffectProvider,
  MockTextToSpeechProvider,
} from './mock/audio.ts';
import { MockGPUProvider } from './mock/gpu.ts';
import { MockImageModel, MockUpscaler, MockVideoModel } from './mock/image.ts';
import { MockMediaProbe } from './mock/probe.ts';
import type {
  GPUProvider,
  ImageModel,
  LipSyncProvider,
  MediaProbe,
  MusicProvider,
  ProviderInfo,
  SoundEffectProvider,
  TextToSpeechProvider,
  Upscaler,
  VideoModel,
} from './types.ts';

/** The set of AI components the studio uses. Each slot is independently replaceable. */
export interface ProviderSet {
  image: ImageModel;
  video: VideoModel;
  upscaler: Upscaler;
  tts: TextToSpeechProvider;
  music: MusicProvider;
  sfx: SoundEffectProvider;
  lipsync: LipSyncProvider;
  gpu: GPUProvider;
  probe: MediaProbe;
}

export function createMockProviders(storage: StorageProvider, failureRate = 0): ProviderSet {
  const opts = { failureRate };
  return {
    image: new MockImageModel(opts),
    video: new MockVideoModel(opts),
    upscaler: new MockUpscaler(opts),
    tts: new MockTextToSpeechProvider(opts),
    music: new MockMusicProvider(opts),
    sfx: new MockSoundEffectProvider(opts),
    lipsync: new MockLipSyncProvider(opts),
    gpu: new MockGPUProvider(),
    probe: new MockMediaProbe(storage),
  };
}

export function providerInfos(set: ProviderSet): ProviderInfo[] {
  return [
    set.image.info,
    set.video.info,
    set.upscaler.info,
    set.tts.info,
    set.music.info,
    set.sfx.info,
    set.lipsync.info,
  ];
}

/**
 * Cost-safety gate evaluated before ANY generation work (spec §64, §86).
 *
 *  - MOCK_GENERATION=true (default): only mock models may run, on a mock or
 *    local (never paid) GPU provider.
 *  - MOCK_GENERATION=false: no real model adapters exist yet (Phase 3), so generation is
 *    refused rather than silently falling back to mocks.
 *  - A provider that can cost money additionally needs ENABLE_CLOUD_GPU=true.
 */
export function assertGenerationAllowed(env: AppEnv, set: ProviderSet): void {
  const infos = providerInfos(set);
  if (env.mockGeneration) {
    const real = infos.filter((i) => !i.isMock);
    if (real.length > 0 || set.gpu.paid) {
      const names = [...real.map((i) => i.id), ...(set.gpu.paid ? [`GPU provider ${set.gpu.id}`] : [])];
      throw new AppError(
        'MOCK_MODE_REQUIRED',
        `MOCK_GENERATION=true but non-mock or paid providers are configured: ${names.join(', ')}`,
      );
    }
    return;
  }
  if (infos.every((i) => i.isMock)) {
    throw new AppError(
      'MOCK_MODE_REQUIRED',
      'MOCK_GENERATION=false, but no real generation models are installed yet (they arrive in Phase 3). Set MOCK_GENERATION=true.',
    );
  }
  if (infos.some((i) => i.requiresPaidResources) && !env.enableCloudGpu) {
    throw new AppError(
      'CLOUD_GPU_DISABLED',
      'Paid providers require ENABLE_CLOUD_GPU=true and explicit authorization.',
    );
  }
}
