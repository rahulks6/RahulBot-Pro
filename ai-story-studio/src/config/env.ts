import { existsSync } from 'node:fs';
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
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

let envLoaded = false;

/** Load `.env` (if present) into process.env once. Existing variables win. */
export function loadDotEnv(root = appRoot()): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
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
  };
}
