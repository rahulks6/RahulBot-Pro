import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '../lib/paths.ts';
import type { Database } from './database.ts';

export interface MigrationResult {
  applied: string[];
  current: number;
  /** Copy of the database taken before the first pending migration (existing databases only). */
  backupPath: string | null;
}

export interface MigrateOptions {
  /** Folder for automatic pre-migration backups; none are taken without it. */
  backupDir?: string;
  /** Automatic backups kept (older ones are deleted; manual backups are never touched). */
  keepBackups?: number;
}

const BACKUP_PREFIX = 'studio-before-migration-';

/**
 * Apply numbered SQL migrations from `migrations/` (NNNN_name.sql) in order.
 * Each migration runs in its own transaction and is recorded in
 * `schema_migrations`, so re-running is a no-op.
 */
export function migrate(
  db: Database,
  dir = join(appRoot(), 'migrations'),
  opts: MigrateOptions = {},
): MigrationResult {
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
  const pending = files.filter((f) => !done.has(Number(f.slice(0, 4))));
  let backupPath: string | null = null;
  // An existing database (it has applied migrations) is copied before its schema changes, so a
  // failed or unwanted upgrade can be undone by restoring the copy. New databases have nothing to lose.
  if (pending.length && done.size && opts.backupDir && db.path !== ':memory:') {
    backupPath = backupBeforeMigration(db, opts.backupDir, pending[0]!, opts.keepBackups ?? 5);
  }
  const applied: string[] = [];
  for (const file of pending) {
    const version = Number(file.slice(0, 4));
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
  return { applied, current, backupPath };
}

/** Consistent copy of the live database (VACUUM INTO), named after the first pending migration. */
function backupBeforeMigration(db: Database, backupDir: string, firstPending: string, keep: number): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(backupDir, `${BACKUP_PREFIX}${firstPending.slice(0, 4)}-${stamp}.sqlite`);
  db.run('VACUUM INTO ?', path);
  const old = readdirSync(backupDir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.sqlite'))
    .sort()
    .reverse()
    .slice(Math.max(1, keep));
  for (const f of old) rmSync(join(backupDir, f), { force: true });
  return path;
}
