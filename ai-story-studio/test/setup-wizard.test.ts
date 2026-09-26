import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWebApp } from '../src/web/app.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/** FIRST-RUN SETUP WIZARD (7 steps) against a local mock RunPod, then the AI storage location. */
describe('First-run setup wizard', () => {
  const rp = new MockRunPod();
  const registry = new MockRegistry();
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;

  before(async () => {
    await rp.start();
    await registry.start();
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.2.0': { platforms: ['linux/amd64'] } },
    });
    s = testStudio({
      firstRun: true,
      env: { mockGeneration: false, enableCloudGpu: true },
      cloud: {
        runpodBaseUrl: rp.baseUrl,
        sleep: async () => undefined,
        pollMs: 1,
        workerPollMs: 1,
        registryBaseUrlFor: () => registry.base,
      },
    });
    const { handle } = createWebApp(s);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rp.stop();
    await registry.stop();
    s.cleanup();
  });

  it('a fresh install opens the wizard: WELCOME, seven steps', async () => {
    const p = await web.get('/');
    assert.equal(p.url, '/welcome');
    assert.match(p.text, /WELCOME TO AI STORY STUDIO/);
    for (const step of [
      'Choose Storage',
      'Check Application Dependencies',
      'Connect RunPod',
      'Test AI Engine',
      'Configure Narrator',
      'Optional YouTube Connection',
      'READY',
    ])
      assert.ok(p.text.includes(step), step);
    assert.match(p.text, /Step 1 of 7: Choose Storage/);
    assert.ok(p.text.includes(s.env.dataDir), 'shows the storage location');
    assert.match(p.text, /Keep this location/);
  });

  it('step 2 lists the dependencies with plain fixes', async () => {
    const p = await web.get('/welcome?step=2');
    assert.match(p.text, /Node\.js/);
    assert.match(p.text, /FFmpeg/);
    assert.match(p.text, /Database/);
    assert.match(p.text, /Secret storage/);
    assert.match(p.text, /no NVIDIA GPU, Python or CUDA/);
  });

  it('step 3 connects RunPod (a wrong key is refused and not saved), step 4 tests it', async () => {
    let p = await web.get('/welcome?step=3');
    p = await web.submit('/welcome/runpod', { api_key: `rpa_${'W'.repeat(24)}` });
    assert.equal(p.url.split('?')[0], '/welcome');
    assert.match(p.error ?? '', /Not saved/);
    assert.equal(s.secrets.source('runpodApiKey'), 'none');
    p = await web.submit('/welcome/runpod', { api_key: rp.apiKey });
    assert.match(p.notice ?? '', /RUNPOD CONNECTED ✓/);
    assert.match(p.text, /Step 4 of 7/);
    assert.ok(!p.html.includes(rp.apiKey), 'the key never reaches the page');
    assert.match(p.text, /READY ✓/);
    p = await web.submit('/welcome/test');
    assert.match(p.notice ?? '', /Connection OK/);
    p = await web.get('/welcome?step=3');
    assert.match(p.text, /RunPod key saved ✓/);
  });

  it('step 5 saves the narrator; step 6 offers YouTube without requiring it', async () => {
    await web.get('/welcome?step=5');
    const p = await web.submit('/welcome/narrator', {
      narrator: 'male',
      language: 'hi',
      backgroundMusic: 'calm',
    });
    assert.match(p.text, /Step 6 of 7: Optional YouTube Connection/);
    assert.match(p.text, /Skip for now/);
    const a = s.settings.get('app');
    assert.deepEqual([a.narrator, a.language, a.backgroundMusic], ['male', 'hi', 'calm']);
  });

  it('step 7 READY summarises and FINISH goes to Create; Home no longer redirects', async () => {
    let p = await web.get('/welcome?step=7');
    assert.match(p.text, /AI Engine — RUNPOD READY ✓/);
    assert.match(p.text, /YouTube — not connected \(optional\)/);
    p = await web.submit('/welcome/finish');
    assert.equal(p.url.split('?')[0], '/create');
    assert.equal(s.settings.get('app').firstRunComplete, true);
    p = await web.get('/');
    assert.match(p.text, /Turn your idea into a complete animated video/);
  });
});

describe('First-run wizard: skip, and upgrades', () => {
  it('Skip setup for now goes Home and does not ask again', async () => {
    const s = testStudio({ firstRun: true });
    const { handle } = createWebApp(s);
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const web = WebDriver.fromServer(server);
      await web.get('/');
      const p = await web.submit('/welcome/skip');
      assert.equal(p.url.split('?')[0], '/');
      assert.match(p.text, /Turn your idea into a complete animated video/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.cleanup();
    }
  });

  it('an existing library (upgrade) is not sent to the wizard', async () => {
    const s = testStudio({ firstRun: true });
    s.projects.create({ name: 'Old project' });
    const { handle } = createWebApp(s);
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const p = await WebDriver.fromServer(server).get('/');
      assert.equal(p.url, '/');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.cleanup();
    }
  });
});

describe('AI storage location', () => {
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;
  const scratch = mkdtempSync(join(tmpdir(), 'ais-move-'));

  before(async () => {
    s = testStudio();
    const { handle } = createWebApp(s);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    s.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('shows one location organised into Models, Cache, Projects, Characters, … Temp', async () => {
    await s.storage.put('projects/prj_x/references/ref1.png', Buffer.alloc(2048, 1));
    await s.storage.put('projects/prj_x/masters/m1.mp4', Buffer.alloc(4096, 1));
    await s.storage.put('videos/vid_x/captions.srt', Buffer.from('1\n'));
    await s.storage.put('videos/vid_x/short-1.mp4', Buffer.alloc(1024, 1));
    const p = await web.get('/settings/storage');
    for (const label of [
      'Models',
      'Cache',
      'Projects',
      'Characters',
      'Assets',
      'Videos',
      'Shorts',
      'Captions',
      'Thumbnails',
      'Exports',
      'Temp',
    ])
      assert.ok(new RegExp(`\\b${label}\\b`).test(p.text), label);
    assert.ok(p.text.includes(s.env.dataDir));
    const settings = await web.get('/settings');
    assert.ok(web.links(/AI storage location/).includes('/settings/storage'), settings.url);
  });

  it('refuses unsafe targets: relative, inside the current folder, not empty', async () => {
    await web.get('/settings/storage');
    let p = await web.submit('/settings/storage/move', { path: 'relative/folder', understood: 'true' });
    assert.match(p.error ?? '', /full path/);
    p = await web.submit('/settings/storage/move', {
      path: join(s.env.dataDir, 'inner'),
      understood: 'true',
    });
    assert.match(p.error ?? '', /outside the current storage location/);
    writeFileSync(join(scratch, 'marker'), 'x');
    p = await web.submit('/settings/storage/move', { path: scratch, understood: 'true' });
    assert.match(p.error ?? '', /not empty/);
  });

  it('copies everything, points .env at the new folder, keeps the old one, asks for a restart', async () => {
    s.secrets.set('hfToken', `hf_${'x'.repeat(20)}`);
    writeFileSync(s.engine.envFile, 'MOCK_GENERATION=true\nDATA_DIR=./data\n');
    const target = join(scratch, 'new-home');
    await web.get('/settings/storage');
    await web.submit('/settings/storage/move', { path: target, understood: 'true' });
    for (let i = 0; i < 200 && s.storageMover.state?.state === 'copying'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.storageMover.state?.state, 'done', s.storageMover.state?.error ?? '');
    // The copy: database (with the data), encrypted secrets, generated files.
    const copy = new DatabaseSync(join(target, 'studio.sqlite'));
    const n = (copy.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'app'").get() as { n: number }).n;
    copy.close();
    assert.equal(n, 1);
    assert.ok(existsSync(join(target, 'secrets.json')));
    assert.equal(
      readFileSync(join(target, 'storage', 'projects', 'prj_x', 'masters', 'm1.mp4')).length,
      4096,
    );
    for (const dir of ['models', 'tmp', 'logs', 'backups']) assert.ok(existsSync(join(target, dir)), dir);
    // .env points there; the previous .env was kept; other lines untouched.
    const env = readFileSync(s.engine.envFile, 'utf8');
    assert.match(env, new RegExp(`^DATA_DIR=${target.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}$`, 'm'));
    assert.match(env, /^MOCK_GENERATION=true$/m);
    assert.ok(readdirSync(join(s.engine.envFile, '..')).some((f) => f.startsWith('.env.backup-')));
    // The old folder is untouched; a restart is required and new videos wait.
    assert.ok(existsSync(s.storage.localPath('projects/prj_x/masters/m1.mp4')));
    const p = await web.get('/settings/storage');
    assert.match(p.text, /RESTART NEEDED/);
    assert.match(p.text, /was not deleted/);
    assert.throws(
      () =>
        s.orchestrator.create({
          idea: 'Milo the fox cub finds a star.',
          length: 'short',
          customMinutes: 1,
          styleId: '3d_kids',
          makeEpisode: true,
          makeShorts: false,
          shortsCount: 0,
          language: 'en',
          narrator: 'female',
          musicMood: 'auto',
          reviewPlan: false,
        }),
      /start it again/,
    );
  });
});
