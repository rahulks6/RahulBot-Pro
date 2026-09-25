import { AppError, type ErrorCode } from '../../lib/errors.ts';

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

/**
 * How a request may be retried:
 *  - 'idempotent': network errors, 5xx and 429 are retried (GET, DELETE, state actions).
 *  - 'no-duplicate': only 429 (an explicit "not processed") is retried. Used for
 *    create calls, where a lost response could otherwise create a second billed pod.
 */
export type RetryMode = 'idempotent' | 'no-duplicate';

export class CloudHttpError extends AppError {
  readonly status: number;
  constructor(code: ErrorCode, message: string, status: number) {
    super(code, message);
    this.status = status;
  }
}

export function backoffMs(attempt: number, policy: RetryPolicy, retryAfterHeader?: string | null): number {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(policy.maxDelayMs, retryAfter * 1000);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

export interface JsonRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  retry: RetryMode;
  timeoutMs?: number;
  /** Friendly name of the provider for error messages ("RunPod"). */
  provider: string;
}

/** Map an HTTP status to a clear, non-retryable-or-retryable error (never includes credentials). */
export function httpError(provider: string, status: number, detail: string): CloudHttpError {
  const d = detail ? `: ${detail.slice(0, 300)}` : '';
  if (status === 401 || status === 403)
    return new CloudHttpError(
      'CLOUD_AUTH_FAILED',
      `${provider} authentication failed. Check your API key.`,
      status,
    );
  if (status === 404) return new CloudHttpError('NOT_FOUND', `${provider}: not found${d}`, status);
  if (status === 429)
    return new CloudHttpError(
      'CLOUD_RATE_LIMITED',
      `${provider} is rate-limiting requests; try again shortly${d}`,
      status,
    );
  if (status >= 500)
    return new CloudHttpError(
      'CLOUD_UNAVAILABLE',
      `${provider} is temporarily unavailable (HTTP ${status})${d}`,
      status,
    );
  return new CloudHttpError(
    'CLOUD_BAD_REQUEST',
    `${provider} rejected the request (HTTP ${status})${d}`,
    status,
  );
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body : '';
  const b = body as Record<string, unknown>;
  const e = b['error'];
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as Record<string, unknown>)['message'] === 'string')
    return (e as Record<string, string>)['message']!;
  if (typeof b['message'] === 'string') return b['message'];
  return '';
}

/** JSON request with bounded exponential backoff. The response body is returned parsed (or null). */
export async function requestJson<T = unknown>(
  req: JsonRequest,
  deps: { fetch: FetchFn; sleep: SleepFn; policy?: RetryPolicy },
): Promise<{ status: number; body: T }> {
  const policy = deps.policy ?? DEFAULT_RETRY;
  let last: CloudHttpError | undefined;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, {
        method: req.method,
        headers: {
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...req.headers,
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      });
    } catch (err) {
      last = new CloudHttpError(
        'CLOUD_UNAVAILABLE',
        `${req.provider} could not be reached (${(err as Error).name === 'TimeoutError' ? 'timeout' : 'network error'}). Check your internet connection.`,
        0,
      );
      // A create that may or may not have reached the provider is never repeated.
      if (req.retry === 'no-duplicate') throw last;
      if (attempt < policy.attempts) await deps.sleep(backoffMs(attempt, policy));
      continue;
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return { status: res.status, body: body as T };
    last = httpError(req.provider, res.status, errorDetail(body));
    const retryable = res.status === 429 || (req.retry === 'idempotent' && res.status >= 500);
    if (!retryable || attempt === policy.attempts) throw last;
    await deps.sleep(backoffMs(attempt, policy, res.headers.get('retry-after')));
  }
  throw last ?? new CloudHttpError('CLOUD_UNAVAILABLE', `${req.provider} request failed`, 0);
}
