/**
 * Minimal migration runner: applies every .sql file in migrations/ that
 * hasn't run yet, in filename order, inside a transaction each. Tracks
 * applied migrations in a `schema_migrations` table.
 *
 * Deliberately hand-rolled instead of using a migration framework package
 * (Prisma/node-pg-migrate) because this sandbox cannot install npm
 * dependencies — see the note in package.json. It runs psql directly
 * (unlike src/db/psql.ts, migrations are trusted, static, developer-owned
 * SQL files, so there's no parameter-injection surface to guard here).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../src/config/env";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function psqlExec(sql: string): string {
  return execFileSync(
    "psql",
    [
      "-h",
      config.db.host,
      "-p",
      String(config.db.port),
      "-U",
      config.db.user,
      "-d",
      config.db.database,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { env: { ...process.env, PGPASSWORD: config.db.password }, encoding: "utf8" },
  );
}

function psqlExecFile(filePath: string): void {
  execFileSync(
    "psql",
    [
      "-h",
      config.db.host,
      "-p",
      String(config.db.port),
      "-U",
      config.db.user,
      "-d",
      config.db.database,
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-1", // wrap the whole file in a single transaction
      "-f",
      filePath,
    ],
    { env: { ...process.env, PGPASSWORD: config.db.password }, stdio: "inherit" },
  );
}

function ensureMigrationsTable(): void {
  psqlExec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function appliedVersions(): Set<string> {
  const out = psqlExec("SELECT version FROM schema_migrations ORDER BY version;");
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== "version" && !l.startsWith("(") && !/^-+$/.test(l)),
  );
}

function markApplied(version: string): void {
  psqlExec(`INSERT INTO schema_migrations (version) VALUES ('${version}');`);
}

function main(): void {
  ensureMigrationsTable();
  const applied = appliedVersions();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ranAny = false;
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      console.log(`skip  ${version} (already applied)`);
      continue;
    }
    console.log(`apply ${version}`);
    psqlExecFile(path.join(MIGRATIONS_DIR, file));
    markApplied(version);
    ranAny = true;
  }

  console.log(ranAny ? "Migrations complete." : "Nothing to do — schema is up to date.");
}

main();
