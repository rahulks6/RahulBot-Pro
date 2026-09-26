import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { appRoot } from '../lib/paths.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppEnv {
  /** When true (the default) nothing paid can run: mock providers only. */
  mockGeneration: boolean;
  /** Independent second gate for cloud GPUs. No real cloud provider exists yet. */
  enableCloudGpu: boolean;
  host: string;
  port: number;
  dataDir: string;
  mockFailureRate: number;
  logLevel: LogLevel;
  /** Local AI worker (Phase 2). Empty = in-process mock providers. */
  workerUrl: string;
  /** Bearer token for the worker. Server-side only: never rendered, logged or sent to the browser. */
  workerToken: string;
  workerTimeoutSec: number;
  /**
   * Episode assembly (Phase 4): `auto` encodes a real MP4 with local FFmpeg when
   * it is installed and falls back to the mock manifest otherwise; `ffmpeg`
   * requires FFmpeg; `mock` always writes the mock manifest.
   */
  assemblyMode: AssemblyMode;
  /**
   * Optional heavy-storage locations (e.g. a second SSD). Unset = inside DATA_DIR. Resolve with
   * `storagePaths(env)`, never read directly. Nothing is moved automatically.
   */
  paths?: {
    generatedAssets?: string;
    tempRender?: string;
    downloadCache?: string;
    modelCache?: string;
  };
  /** Phase 5 cloud GPU provider. Only 'runpod' is implemented. */
  cloudProvider: 'runpod' | 'vast' | 'tensordock';
  /** Optional worker image override (otherwise Settings → Cloud GPU). */
  cloudWorkerImage: string;
  /**
   * Hard caps from .env (rupees / minutes / count). Settings can lower them but never exceed them.
   * Undefined = no extra cap beyond Settings.
   */
  caps: {
    maxGpuHourlyRateInr?: number;
    sessionBudgetInr?: number;
    idleShutdownMinutes?: number;
    maxGpuLifetimeMinutes?: number;
    maxConcurrentGpuInstances: number;
  };
}

export type AssemblyMode = 'auto' | 'ffmpeg' | 'mock';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cap(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readCaps(source: NodeJS.ProcessEnv): AppEnv['caps'] {
  const caps: AppEnv['caps'] = {
    // Default 1: never more than one paid GPU at a time unless .env explicitly allows more.
    maxConcurrentGpuInstances: Math.max(
      1,
      Math.min(4, Math.floor(cap(source.MAX_CONCURRENT_GPU_INSTANCES) ?? 1)),
    ),
  };
  const rate = cap(source.MAX_GPU_HOURLY_RATE);
  const budget = cap(source.SESSION_BUDGET);
  const idle = cap(source.IDLE_SHUTDOWN_MINUTES);
  const life = cap(source.MAX_GPU_LIFETIME_MINUTES);
  if (rate !== undefined) caps.maxGpuHourlyRateInr = rate;
  if (budget !== undefined) caps.sessionBudgetInr = budget;
  if (idle !== undefined) caps.idleShutdownMinutes = idle;
  if (life !== undefined) caps.maxGpuLifetimeMinutes = life;
  return caps;
}

let envLoaded = false;

/** Load `.env` (if present) into process.env once. Existing variables win. */
export function loadDotEnv(root = appRoot()): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function optPath(key: string, value: string | undefined): Record<string, string> {
  const v = value?.trim();
  if (!v) return {};
  return { [key]: isAbsolute(v) ? v : join(appRoot(), v) };
}

export interface StoragePaths {
  /** Generated and imported media (images, clips, audio, finished videos). */
  generatedAssets: string;
  /** FFmpeg work folders for BUILD FINAL (deleted after each build). */
  tempRender: string;
  /** Cloud downloads being validated before they are stored. */
  downloadCache: string;
  /** Model weights for the optional LOCAL worker (cloud GPUs keep their own cache). */
  modelCache: string;
}

/** Where heavy files go: the .env overrides, or folders inside DATA_DIR. */
export function storagePaths(env: Pick<AppEnv, 'dataDir' | 'paths'>): StoragePaths {
  const p = env.paths ?? {};
  return {
    generatedAssets: p.generatedAssets ?? join(env.dataDir, 'storage'),
    tempRender: p.tempRender ?? join(env.dataDir, 'tmp'),
    downloadCache: p.downloadCache ?? join(env.dataDir, 'tmp', 'downloads'),
    modelCache: p.modelCache ?? join(env.dataDir, 'models'),
  };
}

const PATH_VARS: Array<[keyof Omit<StoragePaths, 'modelCache'>, string]> = [
  ['generatedAssets', 'GENERATED_ASSETS_PATH'],
  ['tempRender', 'TEMP_RENDER_PATH'],
  ['downloadCache', 'DOWNLOAD_CACHE_PATH'],
];

/**
 * Checks the storage folders set in .env before anything is written. A missing drive (e.g. D:
 * not connected yet) stops the start with a plain message instead of failing every generation
 * later, and never falls back silently (that would split media across two places). The folders
 * are created when the drive exists. MODEL_CACHE_PATH is only used by the local worker.
 */
export function checkStoragePaths(env: Pick<AppEnv, 'dataDir' | 'paths'>): void {
  const problems: string[] = [];
  for (const [key, name] of PATH_VARS) {
    const dir = env.paths?.[key];
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'error';
      problems.push(`${name}=${dir} is not available (${code})`);
    }
  }
  if (problems.length)
    throw new Error(
      `${problems.join('; ')}. Connect that drive, or remove the line from .env to keep using the data folder.`,
    );
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const level = (source.LOG_LEVEL ?? 'info').toLowerCase();
  const dataDir = source.DATA_DIR?.trim() || './data';
  return {
    // MOCK_GENERATION defaults to TRUE: an unset or empty value never enables paid generation.
    mockGeneration: bool(source.MOCK_GENERATION, true),
    enableCloudGpu: bool(source.ENABLE_CLOUD_GPU, false),
    host: source.HOST?.trim() || '127.0.0.1',
    port: num(source.PORT, 3000),
    dataDir: isAbsolute(dataDir) ? dataDir : join(appRoot(), dataDir),
    mockFailureRate: Math.min(1, Math.max(0, num(source.MOCK_FAILURE_RATE, 0))),
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as LogLevel,
    workerUrl: (source.WORKER_URL ?? '').trim().replace(/\/+$/, ''),
    workerToken: source.WORKER_AUTH_TOKEN ?? '',
    workerTimeoutSec: Math.max(10, num(source.WORKER_TIMEOUT_SEC, 1800)),
    assemblyMode:
      (['auto', 'ffmpeg', 'mock'] as const).find((m) => m === source.ASSEMBLY_MODE?.trim().toLowerCase()) ??
      'auto',
    cloudProvider:
      (['runpod', 'vast', 'tensordock'] as const).find(
        (m) => m === source.CLOUD_GPU_PROVIDER?.trim().toLowerCase(),
      ) ?? 'runpod',
    cloudWorkerImage: source.CLOUD_WORKER_IMAGE?.trim() ?? '',
    paths: {
      ...optPath('generatedAssets', source.GENERATED_ASSETS_PATH),
      ...optPath('tempRender', source.TEMP_RENDER_PATH),
      ...optPath('downloadCache', source.DOWNLOAD_CACHE_PATH),
      ...optPath('modelCache', source.MODEL_CACHE_PATH),
    },
    caps: readCaps(source),
  };
}
