import type { ErrorCode } from '../../lib/errors.ts';
import { prng, seedFrom } from '../../lib/hash.ts';
import type { ProviderInfo, RunContext } from '../types.ts';
import { ProviderError } from '../types.ts';

export const MOCK_VIDEO_MIME = 'application/vnd.ai-story-studio.mock-video+json';
export const MOCK_MASTER_MIME = 'application/vnd.ai-story-studio.mock-master+json';

export interface MockOptions {
  /** Probability 0..1 that an operation fails (deterministic per attempt key). */
  failureRate?: number;
}

export function mockInfo(
  id: string,
  displayName: string,
  computeLocation: ProviderInfo['computeLocation'],
  minVramGb = 0,
): ProviderInfo {
  return {
    id,
    displayName,
    isMock: true,
    openSource: true,
    computeLocation,
    requiresPaidResources: false,
    minVramGb,
    modelVersion: 'mock-1',
    license: 'n/a (placeholder output)',
  };
}

/**
 * Failure injection: `settings.mockFailAttempts = n` fails the first n
 * attempts with a retryable error; `settings.mockForceFailure` (an error code)
 * always fails; otherwise fail with probability `failureRate`, seeded by the
 * attempt key so results are reproducible.
 */
export function maybeFail(
  ctx: RunContext,
  settings: Record<string, unknown> | undefined,
  rate: number | undefined,
  code: ErrorCode,
): void {
  if (ctx.signal?.aborted) throw new ProviderError('CANCELLED', 'Cancelled');
  const failFirst = settings?.['mockFailAttempts'];
  if (typeof failFirst === 'number' && (ctx.attemptNumber ?? 1) <= failFirst) {
    throw new ProviderError(
      code,
      `Simulated failure on attempt ${ctx.attemptNumber ?? 1} (mockFailAttempts=${failFirst})`,
    );
  }
  const forced = settings?.['mockForceFailure'];
  if (typeof forced === 'string' && forced.length > 0) {
    throw new ProviderError(forced as ErrorCode, `Simulated failure (${forced})`);
  }
  if (rate && rate > 0 && prng(seedFrom(`fail:${ctx.attemptKey}`))() < rate) {
    throw new ProviderError(code, 'Simulated random failure (MOCK_FAILURE_RATE)');
  }
}

/** Simulated compute seconds with ±15 % deterministic jitter. */
export function simulatedSeconds(base: number, key: string): number {
  const r = prng(seedFrom(`time:${key}`))();
  return Math.round(base * (0.85 + r * 0.3) * 10) / 10;
}
