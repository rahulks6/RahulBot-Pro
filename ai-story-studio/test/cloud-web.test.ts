import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Logger, fileSink } from '../src/lib/logger.ts';
import { createWebApp } from '../src/web/app.ts';
import { FakeCloudWorker } from './fixtures/fake-worker.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

const token = 'cloud-web-csrf';
const KEY = 'rpa_UIKEY1234567890SECRETabcd';

const notice = (res: Response): string =>
  new URL(res.headers.get('location') ?? '/', 'http://x').searchParams.get('notice') ?? '';

async function serve(s: TestStudio): Promise<{ base: string; server: Server }> {
  const { handle } = createWebApp(s, { csrfToken: token });
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('Cloud GPU pages', () => {
  const rp = new MockRunPod(KEY);
  const worker = new FakeCloudWorker(rp);
  const registry = new MockRegistry();
  let mock: TestStudio;
  let cloud: TestStudio;
  let mockWeb: { base: string; server: Server };
  let cloudWeb: { base: string; server: Server };
  const post = (base: string, path: string, fields: Record<string, string>) =>
    fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, _csrf: token }),
    });

  before(async () => {
    await rp.start();
    await worker.start();
    await registry.start();
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    mock = testStudio();
    seedSmall(mock);
    mockWeb = await serve(mock);
    cloud = testStudio({
      env: { mockGeneration: false, enableCloudGpu: true },
      cloud: {
        runpodBaseUrl: rp.baseUrl,
        proxyUrlTemplate: worker.template,
        sleep: async () => undefined,
        pollMs: 1,
        workerPollMs: 1,
        registryBaseUrlFor: () => registry.base,
      },
    });
    // Write logs to the studio's real log file so the redaction test reads what a user would see.
    (cloud as unknown as { logger: Logger }).logger = new Logger('info', [
      fileSink(join(cloud.env.dataDir, 'logs', 'studio.log')),
    ]);
    cloud.settings.set('gpu', { ...cloud.settings.get('gpu'), maxHourlyRateInr: 100 });
    cloudWeb = await serve(cloud);
  });
  after(async () => {
    mockWeb.server.close();
    cloudWeb.server.close();
    mock.cleanup();
    cloud.cleanup();
    await worker.stop();
    await rp.stop();
    await registry.stop();
  });

  it('shows the mode on every page; mock mode has no emergency button', async () => {
    for (const path of ['/', '/cloud', '/cloud/test', '/logs', '/gpu', '/settings']) {
      const res = await fetch(mockWeb.base + path);
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.match(body, /DEVELOPER TEST MODE/, path);
      assert.ok(!body.includes('EMERGENCY STOP GPU'), `${path}: nothing to stop in mock mode`);
    }
    const cloudPage = await (await fetch(mockWeb.base + '/cloud')).text();
    assert.match(cloudPage, /MOCK_GENERATION=false \(.env\)/);
    assert.match(cloudPage, /type="password" name="api_key"/);
  });

  it('saves the API key server-side only: masked in the page, absent from the logs', async () => {
    let res = await post(cloudWeb.base, '/cloud/key', { provider: 'runpod', api_key: KEY });
    assert.equal(res.status, 303);
    const page = await (await fetch(cloudWeb.base + '/cloud')).text();
    assert.ok(!page.includes(KEY), 'the full key never reaches the browser');
    assert.match(page, /••••••••abcd/);
    res = await post(cloudWeb.base, '/cloud/switches', { cloudEnabled: 'true', realGeneration: 'true' });
    assert.equal(res.status, 303);
    assert.equal(cloud.cloud.mode(), 'REAL_CLOUD');
    const home = await (await fetch(cloudWeb.base + '/')).text();
    assert.ok(!home.includes('MODE: REAL CLOUD'), 'Simple Mode shows no engine jargon');
    assert.ok(!home.includes('EMERGENCY STOP GPU'), 'Simple Mode shows STOP only while a GPU runs');
    await post(cloudWeb.base, '/ui-mode', { mode: 'advanced' });
    const dash = await (await fetch(cloudWeb.base + '/dashboard')).text();
    assert.match(dash, /MODE: REAL CLOUD/);
    assert.match(dash, /EMERGENCY STOP GPU/);
    await post(cloudWeb.base, '/ui-mode', { mode: 'simple' });
    res = await post(cloudWeb.base, '/cloud/test-connection', {});
    assert.match(notice(res), /key accepted/);
    const logPath = join(cloud.env.dataDir, 'logs', 'studio.log');
    assert.ok(existsSync(logPath));
    assert.ok(!readFileSync(logPath, 'utf8').includes(KEY), 'API key never written to the log');
    const logsPage = await (await fetch(cloudWeb.base + '/logs')).text();
    assert.match(logsPage, /cloud switches changed/);
    assert.ok(!logsPage.includes(KEY));
  });

  it('runs dry-run diagnostics without renting anything', async () => {
    rp.requests = [];
    registry.repos.get('rahulks6/ai-story-studio-worker')!.visibility = 'private';
    const res = await post(cloudWeb.base, '/cloud/diagnostics', {});
    assert.equal(res.status, 303);
    const page = await (await fetch(cloudWeb.base + '/cloud')).text();
    assert.match(page, /Dry-run diagnostics/);
    assert.match(page, /cheapest: RTX A5000/);
    assert.match(page, /IMAGE REQUIRES AUTHENTICATION/);
    registry.repos.get('rahulks6/ai-story-studio-worker')!.visibility = 'public';
    assert.ok(!page.includes(KEY), 'the key never reaches the page');
    assert.equal(rp.requests.filter((r) => r.method === 'POST').length, 0);
  });

  it('guided test: steps 1–3 free, then an explicit confirmation page', async () => {
    const res = await post(cloudWeb.base, '/cloud/test/prepare', { kind: 'tts' });
    const loc = res.headers.get('location')!;
    assert.match(loc, /^\/cloud\/test\/ctest_/);
    const page = await (await fetch(cloudWeb.base + loc)).text();
    assert.match(page, /Step 4 — confirm provisioning/);
    assert.match(page, /RTX A5000 at ₹23\.76\/h/);
    assert.equal(rp.pods.size, 0, 'nothing rented before confirmation');
    await post(cloudWeb.base, `${loc}/confirm`, {});
    await cloud.cloudTest.running;
    const done = await (await fetch(cloudWeb.base + loc)).text();
    assert.match(done, /GPU test SUCCESS/);
    assert.equal(rp.livePods().length, 0, 'terminated after the test');
  });

  it('EMERGENCY STOP from the banner terminates owned pods', async () => {
    const orphan = rp.addPod(`ais-${cloud.cloud.installId}-left`);
    const res = await post(cloudWeb.base, '/cloud/emergency-stop', { confirm: 'STOP' });
    assert.equal(res.status, 303);
    assert.match(notice(res), /EMERGENCY STOP: 1 GPU\(s\) terminated/);
    assert.equal(rp.pods.get(orphan)!.status, 'TERMINATED');
  });
});
