import * as fs from "node:fs";
import * as path from "node:path";

function loadDotEnvIfPresent(): void {
  // Resolved from the working directory (this package's root), not
  // __dirname, so it finds .env whether running from source (ts-node) or
  // from dist/ (compiled) — both are always invoked with backend/ as cwd.
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const MIN_SECRET_LENGTH = 32;

/**
 * A misconfigured deployment — a short/guessable secret, or the same
 * secret reused for both token types — is a real production risk, not a
 * theoretical one, so this fails fast at startup rather than accepting
 * whatever's in the environment. `AccessTokenClaims`/`RefreshTokenClaims`
 * already carry a `type` discriminator as defense in depth (tokens.ts),
 * but that shouldn't be the only thing standing between a leaked/weak
 * secret and a forged token.
 */
function requireStrongSecret(name: string, value: string): string {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters. Generate a real one with: ` +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: optionalInt("PORT", 4000),
  db: {
    host: process.env.PGHOST ?? "localhost",
    port: optionalInt("PGPORT", 5432),
    database: process.env.PGDATABASE ?? "katkee_dev",
    user: process.env.PGUSER ?? "katkee",
    password: process.env.PGPASSWORD ?? "",
  },
  media: {
    // Resolved from cwd (this package's root), matching loadDotEnvIfPresent's
    // reasoning above — __dirname would point into dist/ once compiled.
    storageRoot: process.env.MEDIA_STORAGE_ROOT || path.resolve(process.cwd(), "data", "media"),
  },
  stories: {
    // Overridable so tests can exercise real expiry without waiting 24h —
    // see test/env.ts. Spec section 29's 24h lifetime is the production default.
    ttlSeconds: optionalInt("STORY_TTL_SECONDS", 60 * 60 * 24),
  },
  jwt: {
    accessSecret: requireStrongSecret("JWT_ACCESS_SECRET", required("JWT_ACCESS_SECRET")),
    refreshSecret: requireStrongSecret("JWT_REFRESH_SECRET", required("JWT_REFRESH_SECRET")),
    accessTtlSeconds: optionalInt("JWT_ACCESS_TTL_SECONDS", 900),
    refreshTtlSeconds: optionalInt("JWT_REFRESH_TTL_SECONDS", 60 * 60 * 24 * 30),
  },
  rateLimit: {
    // In-memory, single-process limiter (see http/rateLimiter.ts) — there's
    // no Redis/shared store in this sandbox, so this resets on restart and
    // doesn't coordinate across instances. Real, effective protection for
    // this single-process deployment; documented as the first thing to
    // swap for a shared store if this ever runs behind a load balancer.
    // Overridable so tests can exercise real limiting without 200 real
    // requests or a real 15-minute wait — see test/env.ts.
    authWindowMs: optionalInt("RATE_LIMIT_AUTH_WINDOW_MS", 15 * 60 * 1000),
    authMax: optionalInt("RATE_LIMIT_AUTH_MAX", 10),
    globalWindowMs: optionalInt("RATE_LIMIT_GLOBAL_WINDOW_MS", 60 * 1000),
    globalMax: optionalInt("RATE_LIMIT_GLOBAL_MAX", 600),
  },
} as const;

if (config.jwt.accessSecret === config.jwt.refreshSecret) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.");
}
