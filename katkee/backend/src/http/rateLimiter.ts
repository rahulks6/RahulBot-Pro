import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A minimal in-memory, fixed-window rate limiter — see config/env.ts's
 * `rateLimit` section for why in-memory is the right tradeoff in this
 * sandbox (no Redis/shared store available, single process). Each
 * instance owns its own bucket map, so a strict per-route limiter and a
 * generous global one never share counters.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    // Bounds memory over a long-running process — without this, every
    // distinct key (IP) this limiter has ever seen would stay in the map
    // forever. unref() so this timer never keeps the process — or a test
    // run — alive on its own.
    this.sweepTimer = setInterval(() => this.sweep(), windowMs).unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Throws HttpError(429) once `key` has exceeded this limiter's max requests within the current window. */
  check(key: string): void {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    existing.count += 1;
    if (existing.count > this.max) {
      const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
      throw new HttpError(429, `Too many requests — try again in ${retryAfterSeconds}s.`);
    }
  }

  /** Test-only escape hatch so a test can start from a clean window instead of waiting one out for real. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * No reverse proxy sits in front of this server in this sandbox, so the
 * raw socket address is the real, unspoofable client address. Trusting an
 * `X-Forwarded-For` header instead would be *wrong* without also
 * configuring which upstream proxies are trusted — a client could just
 * set that header itself and evade the limiter entirely. A deployment
 * that does add a reverse proxy needs to update this to read a
 * proxy-set header, after configuring trust for it.
 */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
