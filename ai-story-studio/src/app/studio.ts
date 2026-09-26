import { join } from 'node:path';
import type { AppEnv } from '../config/env.ts';
import { loadDotEnv, readEnv } from '../config/env.ts';
import { Database } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';
import type { Clock } from '../lib/clock.ts';
import { systemClock } from '../lib/clock.ts';
import { fileSink, Logger, stdoutSink, type LogSink } from '../lib/logger.ts';
import { findFfmpeg, type FfmpegTools } from '../media/ffmpeg.ts';
import type { ProviderSet } from '../providers/registry.ts';
import type { WorkerConnection } from '../providers/worker/connect.ts';
import { createMockProviders } from '../providers/registry.ts';
import { AssetRepository } from '../repositories/assets.ts';
import { CharacterRepository } from '../repositories/characters.ts';
import { GpuRepository } from '../repositories/gpu.ts';
import { JobRepository } from '../repositories/jobs.ts';
import { ensureBuiltinStyles, ProjectRepository } from '../repositories/projects.ts';
import { ReportRepository } from '../repositories/reports.ts';
import { StoryRepository } from '../repositories/stories.ts';
import { TimelineRepository } from '../repositories/timeline.ts';
import { AudioPipeline } from '../services/audio-pipeline.ts';
import { BudgetService } from '../services/budget.ts';
import { ExportService } from '../services/export.ts';
import { GenerationService } from '../services/generation.ts';
import { GpuSupervisor } from '../services/gpu-supervisor.ts';
import { QualityService } from '../services/quality/quality-service.ts';
import { SettingsService } from '../services/settings.ts';
import { TimelineService } from '../services/timeline.ts';
import { VoiceReferenceService } from '../services/voice-reference.ts';
import { CloudService, type CloudServiceDeps } from '../services/cloud.ts';
import { CloudGpuTest } from '../services/cloud-test.ts';
import { ModelManager } from '../services/model-manager.ts';
import { SecretStore } from '../services/secrets.ts';
import type { StorageProvider } from '../storage/storage.ts';
import { LocalStorageProvider } from '../storage/storage.ts';

/**
 * Composition root: one object holding the database, storage, providers,
 * repositories and services. The web layer (and a future Next.js UI) only
 * talks to this.
 */
export interface Studio {
  env: AppEnv;
  db: Database;
  storage: StorageProvider;
  clock: Clock;
  logger: Logger;
  providers: ProviderSet;
  settings: SettingsService;
  projects: ProjectRepository;
  characters: CharacterRepository;
  stories: StoryRepository;
  assets: AssetRepository;
  jobs: JobRepository;
  gpuRepo: GpuRepository;
  timelines: TimelineRepository;
  reports: ReportRepository;
  budget: BudgetService;
  gpu: GpuSupervisor;
  generation: GenerationService;
  audio: AudioPipeline;
  /** Consented voice reference recordings (Phase 4). */
  voiceRefs: VoiceReferenceService;
  timeline: TimelineService;
  quality: QualityService;
  exports: ExportService;
  /** Local FFmpeg for episode assembly (Phase 4); null = mock master manifest. */
  ffmpeg: FfmpegTools | null;
  /** Local secret store (cloud API key, worker session tokens). Never exposed to the browser. */
  secrets: SecretStore;
  /** Cloud model registry (Phase 5). */
  models: ModelManager;
  /** Cloud GPU orchestration (Phase 5). */
  cloud: CloudService;
  /** Guided first real GPU test. */
  cloudTest: CloudGpuTest;
  /** Set when connected to the local Python worker (Phase 2); null = in-process mock providers. */
  worker: WorkerConnection | null;
  close(): void;
}

export interface StudioOptions {
  env?: Partial<AppEnv>;
  /** Use ':memory:' for tests. Defaults to <dataDir>/studio.sqlite. */
  dbPath?: string;
  clock?: Clock;
  providers?: ProviderSet;
  logSinks?: LogSink[];
  /** Override FFmpeg discovery (tests); undefined = look it up per ASSEMBLY_MODE. */
  ffmpeg?: FfmpegTools | null;
  /** Tests: point the cloud layer at a mock RunPod and speed up polling. */
  cloud?: Pick<
    CloudServiceDeps,
    | 'runpodBaseUrl'
    | 'proxyUrlTemplate'
    | 'fetch'
    | 'sleep'
    | 'pollMs'
    | 'workerPollMs'
    | 'now'
    | 'registryBaseUrlFor'
  >;
  /** Tests: secret-store environment (defaults to process.env). */
  secretEnv?: NodeJS.ProcessEnv;
}

export function createStudio(opts: StudioOptions = {}): Studio {
  loadDotEnv();
  const env: AppEnv = { ...readEnv(), ...opts.env };
  const clock = opts.clock ?? systemClock;
  const sinks = opts.logSinks ?? [stdoutSink, fileSink(join(env.dataDir, 'logs', 'studio.log'))];
  const logger = new Logger(env.logLevel, sinks, { app: 'ai-story-studio', mock: env.mockGeneration });
  const db = new Database(opts.dbPath ?? join(env.dataDir, 'studio.sqlite'));
  migrate(db);
  const storage = new LocalStorageProvider(join(env.dataDir, 'storage'));
  const providers = opts.providers ?? createMockProviders(storage, env.mockFailureRate);

  const settings = new SettingsService(db);
  const projects = new ProjectRepository(db);
  const characters = new CharacterRepository(db);
  const stories = new StoryRepository(db);
  const assets = new AssetRepository(db, storage);
  const jobs = new JobRepository(db);
  const gpuRepo = new GpuRepository(db);
  const timelines = new TimelineRepository(db);
  const reports = new ReportRepository(db);
  const budget = new BudgetService(gpuRepo, settings, clock);
  const gpu = new GpuSupervisor({
    provider: providers.gpu,
    repo: gpuRepo,
    settings,
    budget,
    clock,
    logger,
    env,
  });
  ensureBuiltinStyles(projects);
  const ffmpeg = env.assemblyMode === 'mock' ? null : opts.ffmpeg !== undefined ? opts.ffmpeg : findFfmpeg();

  const partial = {
    env,
    db,
    storage,
    clock,
    logger,
    providers,
    settings,
    projects,
    characters,
    stories,
    assets,
    jobs,
    gpuRepo,
    timelines,
    reports,
    budget,
    gpu,
    ffmpeg,
  };
  const voiceRefs = new VoiceReferenceService(partial);
  const audio = new AudioPipeline({ ...partial, voiceRefs });
  const generation = new GenerationService({ ...partial, audio });
  const timeline = new TimelineService({ ...partial, audio });
  const quality = new QualityService({ ...partial, timeline });
  const exportsService = new ExportService({ ...partial, audio, generation, timeline, quality });
  const secrets = new SecretStore(env.dataDir, opts.secretEnv ?? process.env);
  const models = new ModelManager(db);
  const cloud = new CloudService({
    env,
    db,
    settings,
    secrets,
    gpu,
    gpuRepo,
    jobs,
    providers,
    models,
    logger,
    clock,
    ffmpeg,
    ...(opts.cloud ?? {}),
  });
  try {
    cloud.refresh();
  } catch (err) {
    logger.error('cloud mode not applied', { error: (err as Error).message });
  }
  const cloudTest = new CloudGpuTest({ db, env, gpu, gpuRepo, cloud, models, storage, clock, logger });
  return {
    ...partial,
    audio,
    voiceRefs,
    generation,
    timeline,
    quality,
    exports: exportsService,
    secrets,
    models,
    cloud,
    cloudTest,
    worker: null,
    close: () => db.close(),
  };
}

/** Dependencies available to services (everything created before the services themselves). */
export type StudioCore = Pick<
  Studio,
  | 'env'
  | 'db'
  | 'storage'
  | 'clock'
  | 'logger'
  | 'providers'
  | 'settings'
  | 'projects'
  | 'characters'
  | 'stories'
  | 'assets'
  | 'jobs'
  | 'gpuRepo'
  | 'timelines'
  | 'reports'
  | 'budget'
  | 'gpu'
  | 'ffmpeg'
>;
