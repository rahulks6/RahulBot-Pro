import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createWebApp } from '../src/web/app.ts';
import { testStudio, type TestStudio } from './helpers.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/**
 * Settings → AI Engine against a local mock RunPod (nothing leaves the machine, nothing is rented):
 * paste key → TEST CONNECTION → SAVE → "RUNPOD CONNECTED ✓", Replace, Delete, and the switch out
 * of developer test mode. The key never reaches a page, a log or the database.
 */
describe('AI Engine (Simple Mode)', () => {
  const rp = new MockRunPod();
  const registry = new MockRegistry();
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;
  const logged: string[] = [];

  before(async () => {
    await rp.start();
    await registry.start();
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    s = testStudio({
      env: { mockGeneration: false, enableCloudGpu: true, logLevel: 'info' },
      secretEnv: {},
      cloud: {
        runpodBaseUrl: rp.baseUrl,
        sleep: async () => undefined,
        pollMs: 1,
        workerPollMs: 1,
        registryBaseUrlFor: () => registry.base,
      },
    });
    // Capture every log record (the test studio writes no log file).
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const orig = s.logger[level].bind(s.logger);
      s.logger[level] = (msg: string, ctx?: Record<string, unknown>) => {
        logged.push(JSON.stringify([level, msg, ctx ?? {}]));
        orig(msg, ctx);
      };
    }
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

  it('a new install is real AI with the engine asking for RunPod (Home says so, no mock option)', async () => {
    const home = await web.get('/');
    assert.match(home.text, /Turn your idea into a complete animated video/);
    assert.match(home.text, /Needs attention/);
    assert.match(home.text, /RunPod is not connected yet/);
    assert.ok(!/MOCK|placeholder/i.test(home.text), 'Simple Mode offers no mock engine');
    assert.equal(s.engine.status().state, 'NEEDS_ATTENTION');
  });

  it('TEST CONNECTION with a wrong key: clear failure, nothing saved', async () => {
    await web.get('/settings/ai-engine');
    const p = await web.submit('/settings/ai-engine/key', {
      api_key: 'rpa_WRONGKEY0000000000',
      action: 'test',
    });
    assert.match(p.error ?? '', /Connection failed: RunPod authentication failed/);
    assert.equal(s.secrets.source('runpodApiKey'), 'none');
  });

  it('TEST CONNECTION then SAVE: RUNPOD CONNECTED ✓, engine READY, key never shown or logged', async () => {
    await web.get('/settings/ai-engine');
    const tested = await web.submit('/settings/ai-engine/key', { api_key: rp.apiKey, action: 'test' });
    assert.match(tested.notice ?? '', /Connection OK/);
    assert.equal(s.secrets.source('runpodApiKey'), 'none', 'a test never saves the key');
    const saved = await web.submit('/settings/ai-engine/key', { api_key: rp.apiKey, action: 'save' });
    assert.match(saved.notice ?? '', /RUNPOD CONNECTED ✓/);
    assert.match(saved.text, /RUNPOD CONNECTED ✓/);
    assert.ok(!saved.html.includes(rp.apiKey), 'the full key never reaches the browser');
    assert.match(saved.text, new RegExp(`••••••••${rp.apiKey.slice(-4)}`));
    const st = s.engine.status();
    assert.equal(st.state, 'READY', JSON.stringify(st.issues));
    assert.equal(s.settings.get('execution').mode, 'cloud_gpu');
    assert.equal(s.cloud.realArmed(), true);
    const home = await web.get('/');
    assert.match(home.text, /READY ✓/);
    assert.ok(!/CUDA|VRAM|\bpod\b|RTX|A100|H100/i.test(home.text), `no GPU jargon on Home: ${home.text}`);
    const log = logged.join('\n');
    assert.ok(!log.includes(rp.apiKey), 'key not in the log');
    assert.ok(log.includes('ai engine connected'));
    assert.ok(!readFileSync(join(s.env.dataDir, 'secrets.json'), 'utf8').includes(rp.apiKey), 'encrypted');
    assert.equal(rp.livePods().length, 0, 'connecting rents nothing');
  });

  it('REPLACE with a bad key keeps the working one; DELETE KEY forgets it', async () => {
    await web.get('/settings/ai-engine');
    const bad = await web.submit('/settings/ai-engine/key', {
      api_key: 'rpa_WRONGKEY0000000000',
      action: 'save',
    });
    assert.match(bad.error ?? '', /Not saved/);
    assert.equal(s.secrets.get('runpodApiKey'), rp.apiKey, 'the working key is kept');
    await web.get('/settings/ai-engine');
    const del = await web.submit('/settings/ai-engine/delete');
    assert.match(del.notice ?? '', /deleted/);
    assert.equal(s.secrets.source('runpodApiKey'), 'none');
    assert.equal(s.engine.status().state, 'NEEDS_ATTENTION');
  });

  it('an unpublished AI worker is reported as the remaining step', async () => {
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'private',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    await s.engine.connect(rp.apiKey);
    const st = s.engine.status();
    assert.equal(st.state, 'NEEDS_ATTENTION');
    assert.match(st.issues.map((i) => i.message).join(' '), /cannot download the AI worker/);
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    await s.engine.retest();
    assert.equal(s.engine.status().state, 'READY');
  });

  it('SWITCH TO REAL AI leaves developer test mode: .env updated (backup kept), applied without restart', async () => {
    writeFileSync(
      s.engine.envFile,
      '# AI Story Studio\nMOCK_GENERATION=true\nENABLE_CLOUD_GPU=false\nPORT=3000\n',
    );
    s.env.mockGeneration = true;
    s.env.enableCloudGpu = false;
    await s.router.apply();
    const home = await web.get('/');
    assert.match(home.text, /DEVELOPER TEST MODE/);
    assert.equal(s.engine.status().state, 'DEVELOPER_TEST_MODE');
    await web.get('/settings/ai-engine');
    const p = await web.submit('/settings/ai-engine/switch-to-real');
    assert.match(p.notice ?? '', /Real AI is on/);
    const env = readFileSync(s.engine.envFile, 'utf8');
    assert.match(env, /^MOCK_GENERATION=false$/m);
    assert.match(env, /^ENABLE_CLOUD_GPU=true$/m);
    assert.match(env, /^PORT=3000$/m, 'other lines kept');
    const dir = join(s.engine.envFile, '..');
    const backups = readdirSync(dir).filter((f) => f.startsWith('.env.backup-'));
    assert.equal(backups.length, 1);
    assert.match(readFileSync(join(dir, backups[0]!), 'utf8'), /MOCK_GENERATION=true/);
    assert.equal(s.env.mockGeneration, false);
    assert.equal(s.engine.status().state, 'READY');
    assert.ok(existsSync(s.engine.envFile));
  });

  it('Advanced Mode shows every tool; Simple Mode hides them', async () => {
    let page = await web.get('/');
    assert.ok(!page.html.includes('href="/benchmarks"'));
    await web.submit('/ui-mode', { mode: 'advanced' });
    page = await web.get('/dashboard');
    assert.ok(page.html.includes('href="/benchmarks"'));
    assert.ok(page.html.includes('href="/settings/advanced"'));
    await web.submit('/ui-mode', { mode: 'simple' });
    assert.equal(s.settings.get('app').uiMode, 'simple');
  });
});
