import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStudio, type Studio } from '../src/app/studio.ts';
import { fileSink } from '../src/lib/logger.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/**
 * Create / edit / delete for every library page, driven through the real forms (see
 * web-driver.ts), plus validation messages, settings round-trips, API-key masking and the
 * Logs page. Temporary FILE database and data folder; mock mode; never the user's data.
 */
const FAKE_KEY = 'rpa_TESTONLY0123456789abcdefXYZ';

describe('create / edit / delete through the web forms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-crud-'));
  const dataDir = join(dir, 'data');
  let studio: Studio;
  let server: Server;
  let web: WebDriver;
  let projectId = '';
  let storyId = '';

  async function boot(): Promise<void> {
    studio = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir,
        logLevel: 'info',
        mockFailureRate: 0,
        assemblyMode: 'mock',
      },
      dbPath: join(dataDir, 'studio.sqlite'),
      logSinks: [fileSink(join(dataDir, 'logs', 'studio.log'))],
      secretEnv: {},
    });
    const { handle } = createWebApp(studio);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  }
  async function shutdown(): Promise<void> {
    await new Promise<void>((r) => server.close(() => r()));
    studio.close();
  }

  before(boot);
  after(async () => {
    await shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Asserts a normal page (not the error page) and returns it. */
  const ok = (p: Awaited<ReturnType<WebDriver['get']>>, notice?: string | RegExp) => {
    assert.equal(p.status, 200, `${p.url}: ${p.text.slice(0, 300)}`);
    assert.equal(p.error, null, `${p.url}: unexpected error "${p.error}"`);
    if (notice) assert.match(p.notice ?? '', typeof notice === 'string' ? new RegExp(notice) : notice);
    return p;
  };
  const idFrom = (url: string) => url.split('/')[2]!.split('?')[0]!;

  it('projects: create, edit, validation', async () => {
    await web.get('/projects');
    let p = ok(await web.submit('/projects', { name: 'CRUD Project', series: 'Series A' }));
    projectId = idFrom(p.url);
    p = ok(
      await web.submit(`/projects/${projectId}/update`, {
        name: 'CRUD Project (renamed)',
        series: 'Series B',
      }),
      'Saved',
    );
    assert.match(p.text, /CRUD Project \(renamed\)/);
    assert.equal(studio.projects.get(projectId).series, 'Series B');
    // A blank name is refused with a message and nothing changes.
    p = await web.submit(`/projects/${projectId}/update`, { name: '' });
    assert.ok(p.error, 'blank project name reports an error');
    assert.equal(studio.projects.get(projectId).name, 'CRUD Project (renamed)');
  });

  it('stories: add, edit, delete', async () => {
    await web.get(`/projects/${projectId}`);
    let p = ok(await web.submit(`/projects/${projectId}/stories`, { title: 'Draft story' }));
    const draftId = idFrom(p.url);
    p = ok(await web.submit(`/stories/${draftId}/update`, { title: 'Edited story', episode_number: '' }));
    assert.equal(studio.stories.get(draftId).title, 'Edited story');
    p = ok(await web.submit(`/stories/${draftId}/delete`), 'Story deleted');
    assert.match(p.url, new RegExp(`^/projects/${projectId}\\?`));
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM stories WHERE id = ?', draftId), 0);
    await web.get(`/projects/${projectId}`);
    p = ok(await web.submit(`/projects/${projectId}/stories`, { title: 'Kept story' }));
    storyId = idFrom(p.url);
  });

  it('scenes: add three, edit, move, delete; shots: add, edit, delete', async () => {
    await web.get(`/stories/${storyId}`);
    for (const title of ['One', 'Two', 'Three']) {
      ok(await web.submit(`/stories/${storyId}/scenes`, { title, summary: `Scene ${title}` }), 'Scene added');
    }
    const order = () =>
      studio.db
        .all<{ title: string }>('SELECT title FROM scenes WHERE story_id = ? ORDER BY position', storyId)
        .map((x) => x.title);
    assert.deepEqual(order(), ['One', 'Two', 'Three']);
    const sceneId = (t: string) =>
      studio.db.get<{ id: string }>('SELECT id FROM scenes WHERE story_id = ? AND title = ?', storyId, t)!.id;

    ok(await web.submit(`/scenes/${sceneId('Two')}/update`, { title: 'Two (edited)' }), 'Scene saved');
    ok(await web.submit(`/scenes/${sceneId('Three')}/move`, { direction: 'up' }));
    assert.deepEqual(order(), ['One', 'Three', 'Two (edited)']);
    ok(await web.submit(`/scenes/${sceneId('One')}/delete`), 'Scene deleted');
    assert.deepEqual(order(), ['Three', 'Two (edited)']);

    const sc = sceneId('Three');
    let p = ok(
      await web.submit(`/scenes/${sc}/shots`, { title: 'Wide', action: 'A wide shot' }),
      'Shot added',
    );
    const shotId = idFrom(p.url);
    p = ok(await web.submit(`/shots/${shotId}/update`, { action: 'A wider shot' }), 'Shot saved');
    assert.equal(studio.stories.getShot(shotId).action, 'A wider shot');
    await web.get(`/shots/${shotId}`);
    p = ok(await web.submit(`/shots/${shotId}/delete`), 'Shot deleted');
    assert.match(p.url, new RegExp(`^/stories/${storyId}\\?`), 'back on the story');
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM shots WHERE id = ?', shotId), 0);
  });

  it('characters: create, edit, duplicate name refused, delete', async () => {
    await web.get(`/characters?project=${projectId}`);
    let p = ok(
      await web.submit(/^\/characters\?project=/, {
        name: 'Milo',
        role: 'Main character',
        personality: 'Curious, kind',
      }),
      'Character created',
    );
    const id = idFrom(p.url);
    p = ok(await web.submit(`/characters/${id}/update`, { personality: 'Curious, kind, brave' }), 'Saved');
    assert.equal(studio.characters.get(id).personality, 'Curious, kind, brave');
    await web.get(`/characters?project=${projectId}`);
    p = await web.submit(/^\/characters\?project=/, { name: 'Milo' });
    assert.match(p.error ?? '', /already exists/);
    await web.get(`/characters/${id}`);
    ok(await web.submit(`/characters/${id}/delete`), 'Character deleted');
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM characters WHERE id = ?', id), 0);
  });

  it('locations: create, edit, delete', async () => {
    await web.get(`/locations?project=${projectId}`);
    let p = ok(await web.submit('/locations', { name: 'Magical Forest' }), 'Location created');
    const id = idFrom(p.url);
    p = ok(await web.submit(`/locations/${id}/update`, { name: 'Magical Forest at night' }), 'Saved');
    assert.equal(studio.characters.getLocation(id).name, 'Magical Forest at night');
    ok(await web.submit(`/locations/${id}/delete`), 'Location deleted');
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM locations WHERE id = ?', id), 0);
  });

  it('props: create with a character, change the characters, edit, delete', async () => {
    await web.get(`/characters?project=${projectId}`);
    const milo = idFrom(ok(await web.submit(/^\/characters\?project=/, { name: 'Milo' })).url);
    await web.get(`/characters?project=${projectId}`);
    const luna = idFrom(ok(await web.submit(/^\/characters\?project=/, { name: 'Luna' })).url);
    await web.get(`/props?project=${projectId}`);
    let p = ok(
      await web.submit('/props', {
        name: 'Glowing Star',
        description: 'A tiny warm golden magical star emitting a soft glow.',
        characters: [milo],
      }),
      'Prop created',
    );
    const id = idFrom(p.url);
    assert.deepEqual(studio.characters.propCharacters(id), [milo]);
    // The detail page shows the current characters selected; saving without changes keeps them.
    p = ok(await web.submit(`/props/${id}/update`, { colors: 'gold' }), 'Saved');
    assert.deepEqual(studio.characters.propCharacters(id), [milo]);
    assert.equal(studio.characters.getProp(id).colors, 'gold');
    p = ok(await web.submit(`/props/${id}/update`, { characters: [luna] }), 'Saved');
    assert.deepEqual(studio.characters.propCharacters(id), [luna]);
    p = ok(await web.submit(`/props/${id}/update`, { characters: [] }), 'Saved');
    assert.deepEqual(studio.characters.propCharacters(id), []);
    ok(await web.submit(`/props/${id}/delete`), 'Prop deleted');
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM props WHERE id = ?', id), 0);
  });

  it('props: a character from another project cannot be attached', async () => {
    const other = studio.projects.create({ name: 'Other project' });
    const stranger = studio.characters.create(other.id, { name: 'Stranger' });
    await web.get(`/props?project=${projectId}`);
    const p = await web.post('/props', { _project: projectId, name: 'Lantern', characters: stranger.id });
    assert.match(p.error ?? '', /does not belong to this project/);
    assert.equal(studio.db.scalar<number>("SELECT COUNT(*) FROM props WHERE name = 'Lantern'"), 0);
  });

  it('styles: create, edit, delete', async () => {
    await web.get('/styles');
    let p = ok(await web.submit('/styles', { name: 'Warm 3D Kids Adventure' }), 'Style created');
    const id = idFrom(p.url);
    p = ok(await web.submit(`/styles/${id}/update`, { name: 'Warm 3D Kids Adventure v2' }), 'Saved');
    assert.equal(studio.projects.getStyle(id).name, 'Warm 3D Kids Adventure v2');
    ok(await web.submit(`/styles/${id}/delete`), 'Style deleted');
    assert.equal(studio.db.scalar<number>('SELECT COUNT(*) FROM style_presets WHERE id = ?', id), 0);
  });

  it('settings: every section saves and reads back; bad values are refused with a message', async () => {
    const changes: Record<string, Record<string, string>> = {
      budget: {},
      gpu: {},
      generation: {},
      audioMix: { musicDb: '-21.5' },
      quality: { similarityWarnPercent: '77' },
      encoding: { videoCrf: '21', preset: 'fast' },
    };
    for (const [section, values] of Object.entries(changes)) {
      await web.get('/settings/advanced');
      ok(await web.submit(`/settings/${section}`, values), 'Settings saved');
    }
    assert.equal(studio.settings.get('audioMix').musicDb, -21.5);
    assert.equal(studio.settings.get('quality').similarityWarnPercent, 77);
    assert.equal(studio.settings.get('encoding').videoCrf, 21);
    assert.equal(studio.settings.get('encoding').preset, 'fast');
    // Survives a restart (settings live in the database).
    await shutdown();
    await boot();
    assert.equal(studio.settings.get('encoding').videoCrf, 21);
    const page = ok(await web.get('/settings/advanced'));
    assert.ok(page.html.includes('value="21"'), 'the form shows the saved value');
    const before = studio.settings.get('encoding').videoCrf;
    const bad = await web.submit('/settings/encoding', { videoCrf: 'not-a-number' });
    assert.ok(bad.error, 'invalid value reports an error');
    assert.equal(studio.settings.get('encoding').videoCrf, before, 'nothing changed');
  });

  it('cloud: the saved API key is never shown, logged or stored in the database', async () => {
    await web.get('/cloud');
    ok(await web.submit('/cloud/key', { api_key: FAKE_KEY }), /API key saved/);
    const page = ok(await web.get('/cloud'));
    assert.ok(!page.html.includes(FAKE_KEY), 'key not in the Cloud page');
    assert.ok(!page.html.includes(FAKE_KEY.slice(4, 20)), 'no partial key either');
    assert.match(page.text, /DEVELOPER TEST MODE/);
    assert.ok(
      !readFileSync(join(dataDir, 'secrets.json'), 'utf8').includes(FAKE_KEY),
      'key encrypted in the secret store',
    );
    const logs = ok(await web.get('/logs'));
    assert.ok(!logs.html.includes(FAKE_KEY));
    const log = readFileSync(join(dataDir, 'logs', 'studio.log'), 'utf8');
    assert.ok(!log.includes(FAKE_KEY), 'key not in the log file');
    assert.ok(!readFileSync(join(dataDir, 'studio.sqlite')).includes(FAKE_KEY), 'key not in the database');
    for (const f of readdirSync(dataDir))
      if (f.endsWith('.json') && f !== 'secrets.json')
        assert.ok(!readFileSync(join(dataDir, f), 'utf8').includes(FAKE_KEY), `key not in ${f}`);
    // Real generation stays off: saving a key does not enable the cloud.
    assert.equal(studio.env.enableCloudGpu, false);
    await web.get('/cloud');
    ok(await web.submit('/cloud/key/delete'), /removed/);
    assert.equal(studio.secrets.source('runpodApiKey'), 'none');
  });

  it('logs: operations are recorded with timestamps, levels and IDs', async () => {
    const page = ok(await web.get('/logs'));
    assert.ok(existsSync(join(dataDir, 'logs', 'studio.log')));
    const records = readFileSync(join(dataDir, 'logs', 'studio.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const created = records.find((r) => r['msg'] === 'story created');
    assert.ok(created, 'story creation is logged');
    assert.match(String(created['ts']), /^\d{4}-\d\d-\d\dT/);
    assert.equal(created['level'], 'info');
    assert.match(String(created['story']), /^sto_/);
    assert.match(String(created['project']), /^prj_/);
    assert.ok(records.some((r) => r['msg'] === 'settings changed' && r['section'] === 'encoding'));
    assert.match(page.text, /story created/);
  });

  it('project delete removes its stories and library, and nothing else', async () => {
    const keep = studio.projects.create({ name: 'Keep me' });
    await web.get(`/projects/${projectId}`);
    const p = ok(await web.submit(`/projects/${projectId}/delete`), 'Project deleted');
    assert.equal(p.url.split('?')[0], '/projects');
    for (const t of ['stories', 'characters', 'locations', 'props'])
      assert.equal(
        studio.db.scalar<number>(`SELECT COUNT(*) FROM ${t} WHERE project_id = ?`, projectId),
        0,
        t,
      );
    assert.equal(studio.projects.get(keep.id).name, 'Keep me');
    assert.equal(studio.db.scalar<string>('PRAGMA integrity_check'), 'ok');
    assert.equal(studio.db.all('PRAGMA foreign_key_check').length, 0);
  });
});
