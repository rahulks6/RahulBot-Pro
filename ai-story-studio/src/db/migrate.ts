import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '../lib/paths.ts';
import type { Database } from './database.ts';

export interface MigrationResult {
  applied: string[];
  current: number;
}

/**
 * Apply numbered SQL migrations from `migrations/` (NNNN_name.sql) in order.
 * Each migration runs in its own transaction and is recorded in
 * `schema_migrations`, so re-running is a no-op.
 */
export function migrate(db: Database, dir = join(appRoot(), 'migrations')): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        version,
        file,
        new Date().toISOString(),
      );
    });
    applied.push(file);
  }
  const current = db.scalar<number>('SELECT COALESCE(MAX(version), 0) FROM schema_migrations') ?? 0;
  return { applied, current };
}
