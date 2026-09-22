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
    accessSecret: required("JWT_ACCESS_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    accessTtlSeconds: optionalInt("JWT_ACCESS_TTL_SECONDS", 900),
    refreshTtlSeconds: optionalInt("JWT_REFRESH_TTL_SECONDS", 60 * 60 * 24 * 30),
  },
} as const;
