import type { Studio } from '../../app/studio.ts';
import { AppError } from '../../lib/errors.ts';
import { activeSelections } from '../../services/benchmarks.ts';
import { WorkerClient, type WorkerModel, type WorkerSystem } from './client.ts';
import {
  LocalWorkerGpuProvider,
  WorkerImageModel,
  WorkerLipSync,
  WorkerMusic,
  WorkerSfx,
  WorkerTts,
  WorkerUpscaler,
  WorkerVideoModel,
} from './providers.ts';

export interface WorkerConnection {
  url: string;
  client: WorkerClient;
  connectedAt: string;
  version: string;
  system: WorkerSystem;
  models: WorkerModel[];
}

/**
 * Switch the studio's AI providers to the local Python worker (Phase 2).
 * Only done when WORKER_URL is configured. The cost-safety gate still
 * applies: with MOCK_GENERATION=true, generation refuses to run if the
 * worker reports any non-mock model.
 */
export async function connectWorker(studio: Studio): Promise<WorkerConnection> {
  const { workerUrl, workerToken, workerTimeoutSec } = studio.env;
  if (!workerUrl) throw new AppError('PRECONDITION_FAILED', 'WORKER_URL is not configured');
  if (!/^https?:\/\/[^\s]+$/.test(workerUrl))
    throw new AppError('VALIDATION_FAILED', 'WORKER_URL must be an http(s) URL');
  if (workerToken.length < 24)
    throw new AppError('VALIDATION_FAILED', 'WORKER_AUTH_TOKEN must be set (at least 24 characters)');
  const client = new WorkerClient({ baseUrl: workerUrl, token: workerToken, timeoutSec: workerTimeoutSec });
  const health = await client.health();
  const [models, system] = await Promise.all([client.models(), client.system()]);
  // A human model selection (Benchmarks page) wins over the worker's default model for that kind.
  const selected = activeSelections(studio.db);
  const pick = (kind: WorkerModel['kind']) =>
    models.find((m) => m.kind === kind && m.id === selected.get(kind)) ??
    models.find((m) => m.kind === kind && m.default) ??
    models.find((m) => m.kind === kind);
  studio.gpu.useProvider(new LocalWorkerGpuProvider(client, system));
  Object.assign(studio.providers, {
    image: new WorkerImageModel(client, pick('image')),
    video: new WorkerVideoModel(client, pick('video')),
    upscaler: new WorkerUpscaler(client, pick('upscale')),
    tts: new WorkerTts(client, pick('tts')),
    music: new WorkerMusic(client, pick('music')),
    sfx: new WorkerSfx(client, pick('sfx')),
    lipsync: new WorkerLipSync(client, pick('lipsync')),
    gpu: studio.gpu.currentProvider,
  });
  const connection: WorkerConnection = {
    url: workerUrl,
    client,
    connectedAt: new Date().toISOString(),
    version: health.version,
    system,
    models,
  };
  studio.worker = connection;
  studio.logger.info('worker connected', {
    url: workerUrl,
    version: health.version,
    models: models.length,
    mockOnly: models.every((m) => m.mock),
  });
  return connection;
}
