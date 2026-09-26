import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Database } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { appRoot } from '../src/lib/paths.ts';

/** Before an existing database's schema changes, a consistent copy is taken (rollback = restore it). */
describe('automatic backup before database migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-migrate-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const all = readdirSync(join(appRoot(), 'migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  it('a new database gets no backup; an upgraded one does, holding the old schema and data', () => {
    const older = join(dir, 'older');
    mkdirSync(older);
    for (const f of all.slice(0, -1)) copyFileSync(join(appRoot(), 'migrations', f), join(older, f));
    const backups = join(dir, 'backups');
    const dbPath = join(dir, 'studio.sqlite');
    let db = new Database(dbPath);
    const first = migrate(db, older, { backupDir: backups });
    assert.equal(first.backupPath, null, 'nothing to back up in a new database');
    db.run(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_keep', 'Milo Test Episode', 'x', 'x')",
    );
    db.close();

    db = new Database(dbPath);
    const second = migrate(db, join(appRoot(), 'migrations'), { backupDir: backups });
    assert.deepEqual(second.applied, [all.at(-1)]);
    assert.ok(second.backupPath && existsSync(second.backupPath), 'backup written');
    db.close();

    const copy = new Database(second.backupPath!);
    assert.equal(copy.scalar<number>('SELECT MAX(version) FROM schema_migrations'), all.length - 1);
    assert.equal(copy.scalar<string>("SELECT name FROM projects WHERE id = 'prj_keep'"), 'Milo Test Episode');
    copy.close();

    db = new Database(dbPath);
    assert.equal(migrate(db, join(appRoot(), 'migrations'), { backupDir: backups }).backupPath, null);
    db.close();
  });

  it('keeps only the newest automatic backups', () => {
    const backups = join(dir, 'prune');
    mkdirSync(backups);
    for (let i = 0; i < 7; i++)
      copyFileSync(
        join(dir, 'studio.sqlite'),
        join(backups, `studio-before-migration-0001-2026-01-0${i + 1}.sqlite`),
      );
    copyFileSync(join(dir, 'studio.sqlite'), join(backups, 'my-manual-backup.sqlite'));
    const older = join(dir, 'older2');
    mkdirSync(older);
    copyFileSync(join(appRoot(), 'migrations', all[0]!), join(older, all[0]!));
    const db = new Database(join(dir, 'b.sqlite'));
    migrate(db, older);
    migrate(db, join(appRoot(), 'migrations'), { backupDir: backups, keepBackups: 3 });
    db.close();
    const left = readdirSync(backups);
    assert.equal(left.filter((f) => f.startsWith('studio-before-migration-')).length, 3);
    assert.ok(left.includes('my-manual-backup.sqlite'), 'manual backups are never deleted');
  });
});
