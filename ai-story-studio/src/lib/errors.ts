/**
 * Application error with a stable machine-readable code. Every failure the
 * generation pipeline can hit (spec §68) maps to one of these codes so jobs,
 * attempts and logs record *why* something failed.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'LOCKED',
  'FORBIDDEN',
  'MOCK_MODE_REQUIRED',
  'CLOUD_GPU_DISABLED',
  'GPU_UNAVAILABLE',
  'PRICE_TOO_HIGH',
  'BUDGET_EXCEEDED',
  'PROVISION_FAILED',
  'API_TIMEOUT',
  'WORKER_UNAVAILABLE',
  'CUDA_FAILURE',
  'OUT_OF_MEMORY',
  'MODEL_LOAD_FAILED',
  'IMAGE_GENERATION_FAILED',
  'VIDEO_GENERATION_FAILED',
  'TTS_FAILED',
  'MUSIC_FAILED',
  'SFX_FAILED',
  'LIPSYNC_FAILED',
  'UPSCALE_FAILED',
  'DOWNLOAD_FAILED',
  'FFMPEG_FAILED',
  'STORAGE_FAILED',
  'NETWORK_FAILURE',
  'CANCELLED',
  'PRECONDITION_FAILED',
  'INTERNAL',
  // Phase 5: cloud GPU
  'CLOUD_AUTH_FAILED',
  'CLOUD_RATE_LIMITED',
  'CLOUD_UNAVAILABLE',
  'CLOUD_BAD_REQUEST',
  'WORKER_START_TIMEOUT',
  'SESSION_BUDGET_REACHED',
  'GPU_LIMIT',
  'NOT_SUPPORTED',
  // LOCAL GPU
  'MODEL_NOT_INSTALLED',
  'INSUFFICIENT_VRAM',
  'CUDA_UNAVAILABLE',
  'DISK_FULL',
  // v1.2: story writing and YouTube publishing
  'STORY_GENERATION_FAILED',
  'YOUTUBE_NOT_CONNECTED',
  'YOUTUBE_AUTH_FAILED',
  'YOUTUBE_QUOTA_EXCEEDED',
  'YOUTUBE_UPLOAD_FAILED',
  'YOUTUBE_BLOCKED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Failure types worth retrying automatically (still bounded by max attempts + budget). */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'API_TIMEOUT',
  'WORKER_UNAVAILABLE',
  'NETWORK_FAILURE',
  'DOWNLOAD_FAILED',
  'IMAGE_GENERATION_FAILED',
  'VIDEO_GENERATION_FAILED',
  'TTS_FAILED',
  'MUSIC_FAILED',
  'SFX_FAILED',
  'LIPSYNC_FAILED',
  'UPSCALE_FAILED',
  'CLOUD_RATE_LIMITED',
  'CLOUD_UNAVAILABLE',
  'STORY_GENERATION_FAILED',
]);

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: FieldError[];

  constructor(code: ErrorCode, message: string, details: FieldError[] = []) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', message);
}

export function notFound(what: string, id: string): AppError {
  return new AppError('NOT_FOUND', `${what} not found: ${id}`);
}
