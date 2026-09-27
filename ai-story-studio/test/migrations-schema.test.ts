import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createStudio } from '../src/app/studio.ts';
import { Database } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { ManualClock } from '../src/lib/clock.ts';
import { appRoot } from '../src/lib/paths.ts';
import { createMockProviders } from '../src/providers/registry.ts';
import { LocalStorageProvider } from '../src/storage/storage.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/**
 * The real migration files on a real SQLite FILE (not :memory:): a clean install, an upgrade from
 * the previous release's schema, the schema they produce (tables, indexes, foreign keys), the app
 * starting on that database, and the installer's list of required migrations.
 */
const dir = join(appRoot(), 'migrations');
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
  .sort();
const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const declared = (re: RegExp) => [...sql.matchAll(re)].map((m) => m[1]!);
const TABLES = declared(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi);
const INDEXES = declared(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)?\s+([a-z_]+)/gi);

describe('database migrations (real files, real SQLite file)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ais-schema-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'studio.sqlite');

  it('a clean database: every migration applies in order, once', () => {
    assert.equal(files.length, 9, files.join());
    files.forEach((f, i) => assert.equal(Number(f.slice(0, 4)), i + 1, `numbering gap at ${f}`));
    const db = new Database(dbPath);
    const r = migrate(db);
    assert.deepEqual(r.applied, files);
    assert.equal(r.current, files.length);
    assert.deepEqual(migrate(db).applied, [], 'running again changes nothing');
    db.close();
  });

  it('every declared table and index exists; series/localization/channel tables are there', () => {
    const db = new Database(dbPath);
    const have = (type: string) =>
      new Set(
        db.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ?', type).map((x) => x.name),
      );
    const tables = have('table');
    const indexes = have('index');
    for (const t of TABLES) assert.ok(tables.has(t), `table ${t}`);
    for (const i of INDEXES) assert.ok(indexes.has(i), `index ${i}`);
    for (const t of [
      'series',
      'seasons',
      'episodes',
      'series_characters',
      'continuity_facts',
      'localizations',
      'channel_profiles',
      'publications',
      'videos',
    ])
      assert.ok(tables.has(t), `v1.3 table ${t}`);
    assert.ok(TABLES.length >= 40, `${TABLES.length} tables declared`);
    db.close();
  });

  it('foreign keys point where they should and the file passes integrity checks', () => {
    const db = new Database(dbPath);
    const fks = (t: string) =>
      db
        .all<{ table: string; from: string; on_delete: string }>(`PRAGMA foreign_key_list(${t})`)
        .map((x) => `${x.from}→${x.table}:${x.on_delete}`)
        .sort();
    assert.deepEqual(fks('series'), ['project_id→projects:RESTRICT']);
    assert.deepEqual(fks('seasons'), ['series_id→series:CASCADE']);
    assert.deepEqual(fks('episodes'), [
      'season_id→seasons:CASCADE',
      'series_id→series:CASCADE',
      'video_id→videos:SET NULL',
    ]);
    assert.deepEqual(fks('continuity_facts'), [
      'episode_id→episodes:CASCADE',
      'season_id→seasons:CASCADE',
      'series_id→series:CASCADE',
    ]);
    assert.deepEqual(fks('localizations'), [
      'export_id→exports:SET NULL',
      'short_id→video_shorts:CASCADE',
      'story_id→stories:SET NULL',
      'video_id→videos:CASCADE',
    ]);
    assert.ok(fks('publications').includes('channel_profile_id→channel_profiles:SET NULL'));
    assert.ok(fks('publications').includes('localization_id→localizations:CASCADE'));
    assert.equal(db.scalar<number>('PRAGMA foreign_keys'), 1, 'enforced');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(db.scalar<string>('PRAGMA integrity_check'), 'ok');
    // Constraints really bite: an episode for a series that does not exist is refused.
    assert.throws(() =>
      db.run(
        "INSERT INTO episodes (id, series_id, season_id, number, created_at, updated_at) VALUES ('e', 'nope', 'nope', 1, 'x', 'x')",
      ),
    );
    db.close();
  });

  it('upgrade from the v1.2 schema (0001–0008) keeps data and adds the v1.3 columns with defaults', () => {
    const older = join(tmp, 'older');
    mkdirSync(older);
    for (const f of files.slice(0, -1)) copyFileSync(join(dir, f), join(older, f));
    const path = join(tmp, 'upgrade.sqlite');
    let db = new Database(path);
    migrate(db, older);
    db.run(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_old', 'Old project', 'x', 'x')",
    );
    db.close();
    db = new Database(path);
    const r = migrate(db, dir, { backupDir: join(tmp, 'backups') });
    assert.deepEqual(r.applied, [files.at(-1)]);
    assert.ok(r.backupPath && existsSync(r.backupPath), 'backup taken before the upgrade');
    assert.equal(db.scalar<string>("SELECT name FROM projects WHERE id = 'prj_old'"), 'Old project');
    const cols = (t: string) =>
      new Map(
        db
          .all<{ name: string; dflt_value: string | null }>(`PRAGMA table_info(${t})`)
          .map((c) => [c.name, c.dflt_value]),
      );
    assert.equal(cols('publications').get('language'), "'en'");
    assert.equal(cols('stories').get('voice_overrides_json'), "'{}'");
    assert.ok(cols('dialogue_lines').has('speech_text'));
    assert.equal(cols('videos').get('localizations_json'), "'[]'");
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    db.close();
  });

  it('the app starts on the migrated database and its pages answer', async () => {
    const data = join(tmp, 'app');
    const studio = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir: data,
        logLevel: 'error',
        mockFailureRate: 0,
        assemblyMode: 'mock',
      },
      dbPath,
      clock: new ManualClock('2026-09-27T09:00:00.000Z'),
      providers: createMockProviders(new LocalStorageProvider(join(data, 'storage')), 0),
      logSinks: [],
      envFile: join(data, '.env'),
      secretEnv: {},
    });
    studio.settings.set('app', { ...studio.settings.get('app'), firstRunComplete: true });
    const { handle } = createWebApp(studio);
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const web = WebDriver.fromServer(server);
      for (const path of [
        '/',
        '/series',
        '/create',
        '/videos',
        '/publish',
        '/publish/youtube',
        '/settings',
      ]) {
        const page = await web.get(path);
        assert.ok(!page.error, `${path}: ${page.error}`);
        assert.doesNotMatch(page.text, /Something went wrong|Internal error/, path);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      studio.close();
    }
  });
});

describe('Windows installer integrity check', () => {
  const ps1 = readFileSync(join(appRoot(), 'installer', 'windows', 'install.ps1'), 'utf8');
  const block = (name: string) => {
    const m = new RegExp(`\\$${name} = @\\(([\\s\\S]*?)\\n  \\)`).exec(ps1);
    assert.ok(m, `${name} list in install.ps1`);
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };

  it('checks exactly the migrations of this release (not one arbitrary file)', () => {
    assert.deepEqual(block('expectedMigrations'), files);
    assert.doesNotMatch(ps1, /Test-Path 'migrations\\0008_story_format\.sql'/);
  });

  it('every file it requires exists in the release (built files from their sources)', () => {
    for (const f of block('requiredFiles')) {
      const rel = f.replace(/\\/g, '/');
      const src = rel.startsWith('dist/') ? rel.slice(5).replace(/\.js$/, '.ts') : rel;
      assert.ok(existsSync(join(appRoot(), src)), `${f} (${src})`);
    }
  });
});
