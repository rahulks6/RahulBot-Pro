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
  /** What the request does, for error messages ("GPU catalog"). */
  what?: string;
}

/** Map an HTTP status to a clear, non-retryable-or-retryable error (never includes credentials). */
export function httpError(provider: string, status: number, detail: string, what?: string): CloudHttpError {
  const d = detail ? `: ${detail}` : '';
  const req = what ? `the ${what} request` : 'the request';
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
  return new CloudHttpError('CLOUD_BAD_REQUEST', `${provider} rejected ${req} (HTTP ${status})${d}`, status);
}

const MAX_DETAIL = 400;
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[^\s"',;]+/gi,
  /\b(?:rpa|rps|aisw|hf|ghp|gho|ghs|github_pat)_[A-Za-z0-9_-]{6,}/g,
  /\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
  // Long opaque strings (keys, signed URLs, JWTs) are never useful in a validation message.
  /\b[A-Za-z0-9+/_=-]{40,}\b/g,
];

/** Remove anything credential-like, markup and control characters; keep it short. */
export function sanitizeDetail(text: string): string {
  let t = text;
  for (const re of SECRET_PATTERNS)
    t = t.replace(re, (_m, name?: string, sep?: string) =>
      typeof name === 'string' && typeof sep === 'string' ? `${name}${sep}[redacted]` : '[redacted]',
    );
  t = [...t]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1)}…` : t;
}

const field = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
    return parts.length ? parts.join('.') : null;
  }
  return null;
};

/** One readable line from a single validation issue in any of the common shapes. */
function issueText(issue: unknown): string | null {
  if (typeof issue === 'string') return issue.trim() || null;
  if (!issue || typeof issue !== 'object') return null;
  const i = issue as Record<string, unknown>;
  const msg =
    field(i['message']) ??
    field(i['msg']) ??
    field(i['detail']) ??
    field(i['description']) ??
    field(i['reason']);
  const where =
    field(i['field']) ??
    field(i['param']) ??
    field(i['parameter']) ??
    field(i['path']) ??
    field(i['loc']) ??
    field(i['name']);
  if (!msg) return where ? `${where}: invalid` : null;
  return where && !msg.includes(where) ? `${where}: ${msg}` : msg;
}

/**
 * The useful part of an error response, in the shapes APIs commonly use:
 * {error: "..."} · {error: {message, details: [...]}} · {message} · {errors: [...]} ·
 * {detail: "..." | [{loc, msg}]} (FastAPI) · {title, detail, errors} (RFC 7807) · {issues: [...]}.
 * HTML error pages are dropped. The result is sanitized: it can never contain a credential.
 */
export function errorDetail(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return /^\s*</.test(body) ? '' : sanitizeDetail(body);
  if (typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  const add = (v: unknown) => {
    const t = issueText(v);
    if (t && !parts.includes(t)) parts.push(t);
  };
  const e = b['error'];
  if (typeof e === 'string') add(e);
  else if (e && typeof e === 'object' && !Array.isArray(e)) {
    const eo = e as Record<string, unknown>;
    add(eo['message'] ?? eo['detail'] ?? eo['code']);
    for (const k of ['details', 'errors', 'issues', 'fields'])
      if (Array.isArray(eo[k])) for (const d of eo[k] as unknown[]) add(d);
  }
  if (typeof b['message'] === 'string') add(b['message']);
  if (typeof b['detail'] === 'string') add(b['detail']);
  for (const k of ['detail', 'errors', 'issues', 'details', 'violations'])
    if (Array.isArray(b[k])) for (const d of b[k] as unknown[]) add(d);
  if (b['errors'] && typeof b['errors'] === 'object' && !Array.isArray(b['errors']))
    for (const [k, v] of Object.entries(b['errors'] as Record<string, unknown>)) {
      const t = issueText(Array.isArray(v) ? v.join(', ') : v);
      if (t) parts.push(`${k}: ${t}`);
    }
  if (!parts.length && typeof b['title'] === 'string') add(b['title']);
  return sanitizeDetail(parts.slice(0, 6).join('; '));
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
    last = httpError(req.provider, res.status, errorDetail(body), req.what);
    const retryable = res.status === 429 || (req.retry === 'idempotent' && res.status >= 500);
    if (!retryable || attempt === policy.attempts) throw last;
    await deps.sleep(backoffMs(attempt, policy, res.headers.get('retry-after')));
  }
  throw last ?? new CloudHttpError('CLOUD_UNAVAILABLE', `${req.provider} request failed`, 0);
}
