import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createWebApp } from '../src/web/app.ts';
import { runHealthCheck } from '../src/services/system-health.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { fakeHardware, testStudio, type TestStudio } from './helpers.ts';

/** System Health page, GPU & Costs hardware card and the Execution & GPU settings, via the real pages. */
async function serve(s: TestStudio): Promise<{ server: Server; web: WebDriver }> {
  const { handle } = createWebApp(s);
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, web: WebDriver.fromServer(server) };
}

describe('System Health and hardware status', () => {
  describe('without an NVIDIA GPU', () => {
    let s: TestStudio;
    let server: Server;
    let web: WebDriver;
    before(async () => {
      s = testStudio();
      ({ server, web } = await serve(s));
    });
    after(() => {
      server.close();
      s.cleanup();
    });

    it('health check reports NO NVIDIA GPU as a normal state with a way forward', async () => {
      const report = await runHealthCheck(s);
      const gpu = report.checks.find((c) => c.key === 'gpu')!;
      assert.equal(report.hardware.primary, 'NO_NVIDIA_GPU');
      assert.match(gpu.detail, /NO NVIDIA GPU/);
      assert.match(gpu.fix!, /MOCK mode, or CLOUD GPU/);
      assert.equal(report.checks.find((c) => c.key === 'database')!.level, 'ok');
      assert.equal(report.checks.find((c) => c.key === 'folders')!.level, 'ok');
      assert.equal(report.checks.find((c) => c.key === 'torch')!.level, 'unknown');
    });

    it('the System Health page renders every check in plain words', async () => {
      const p = await web.get('/health');
      assert.equal(p.status, 200);
      for (const label of ['Node.js', 'Python (local worker)', 'FFmpeg / FFprobe', 'Database', 'NVIDIA GPU'])
        assert.ok(p.text.includes(label), label);
      assert.match(p.text, /locked to MOCK by MOCK_GENERATION=true/);
      assert.match(p.text, /This computer — GPU/);
    });

    it('Check PyTorch runs the probe and never breaks the page', async () => {
      await web.get('/health');
      const p = await web.submit('/health/check-torch');
      assert.equal(p.status, 200);
      assert.match(p.notice ?? '', /^PyTorch: /);
      assert.ok(s.hardware.torch, 'probe result stored');
    });
  });

  describe('with an NVIDIA GPU (replayed nvidia-smi)', () => {
    let s: TestStudio;
    let server: Server;
    let web: WebDriver;
    before(async () => {
      s = testStudio({ hardware: fakeHardware({ name: 'NVIDIA GeForce RTX 4070', totalMb: 12282 }) });
      ({ server, web } = await serve(s));
    });
    after(() => {
      server.close();
      s.cleanup();
    });

    it('GPU & Costs shows GPU, driver, CUDA, VRAM total/used/free, utilization and temperature', async () => {
      const p = await web.get('/gpu');
      assert.equal(p.status, 200);
      for (const t of [
        'NVIDIA GeForce RTX 4070',
        'GPU READY',
        'CUDA (driver supports up to) 12.7',
        'VRAM total 12.0 GB',
        'VRAM free',
        'Utilization 3%',
        'Temperature 40 °C',
        'MEDIUM VRAM',
      ])
        assert.ok(p.text.includes(t), `missing "${t}"`);
      assert.ok(p.html.includes('href="/gpu?refresh=1"'), 'refresh link');
      assert.equal((await web.get('/gpu?refresh=1')).status, 200);
    });

    it('"Max VRAM usage" changes the usable VRAM and the profile', async () => {
      await web.get('/settings');
      const saved = await web.submit('/settings/execution', { maxVramPercent: '60' });
      assert.equal(saved.error, null);
      assert.equal(s.settings.get('execution').maxVramPercent, 60);
      const report = await runHealthCheck(s);
      assert.equal(report.hardware.usableVramGb, 7.2);
      assert.equal(report.hardware.profile, 'LOW');
    });

    it('execution settings persist and are validated', async () => {
      await web.get('/settings');
      const p = await web.submit('/settings/execution', {
        mode: 'local_gpu',
        defaultQuality: 'high_quality',
        cpuOffload: 'sequential',
        vaeTiling: 'on',
        allowCloudFallback: 'true',
      });
      assert.equal(p.error, null);
      const ex = s.settings.get('execution');
      assert.deepEqual(
        [ex.mode, ex.defaultQuality, ex.cpuOffload, ex.vaeTiling, ex.allowCloudFallback],
        ['local_gpu', 'high_quality', 'sequential', 'on', true],
      );
      await web.get('/settings');
      const bad = await web.submit('/settings/execution', { maxVramPercent: '5' });
      assert.ok(bad.error, 'out-of-range VRAM percent is refused');
      assert.equal(s.settings.get('execution').maxVramPercent, 60, 'nothing changed');
    });
  });
});
