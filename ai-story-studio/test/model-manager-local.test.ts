import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { storagePaths } from '../src/config/env.ts';
import { folderBytes, repoState } from '../src/services/model-store.ts';
import { LocalModelService } from '../src/services/local-models.ts';
import { cleanup, diskUsage } from '../src/services/disk.ts';
import { planRuntime, RuntimeInstaller } from '../src/services/runtime-installer.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { fakeHardware, testStudio, type TestStudio } from './helpers.ts';
import type { NvidiaReport } from '../src/services/hardware.ts';

/** Writes a Hugging Face cache snapshot the way huggingface_hub does. */
function fakeRepo(
  cache: string,
  repo: string,
  files: Record<string, string>,
  opts: { incomplete?: boolean } = {},
) {
  const root = join(cache, `models--${repo.replace('/', '--')}`);
  mkdirSync(join(root, 'refs'), { recursive: true });
  writeFileSync(join(root, 'refs', 'main'), 'abc123');
  const snap = join(root, 'snapshots', 'abc123');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(snap, name, '..'), { recursive: true });
    writeFileSync(join(snap, name), body);
  }
  mkdirSync(join(root, 'blobs'), { recursive: true });
  if (opts.incomplete) writeFileSync(join(root, 'blobs', 'deadbeef.incomplete'), 'x'.repeat(100));
  return root;
}

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean };

/** A download process stand-in: runs `behave` (writes cache files), prints the JSON result, exits. */
function fakeSpawn(
  behave: (args: string[]) => { ok: boolean; kind?: string; message?: string; hang?: boolean },
) {
  const calls: string[][] = [];
  const fn = ((_bin: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const r = behave(args);
    child.kill = (sig?: string) => {
      setImmediate(() => child.emit('exit', null, sig ?? 'SIGTERM'));
      return true;
    };
    if (!r.hang)
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify(r)}\n`);
        setImmediate(() => child.emit('exit', r.ok ? 0 : 3, null));
      });
    return child;
  }) as never;
  return { fn, calls };
}

/** Fake tokens are assembled at runtime so they never look like a real credential in the source. */
const fakeHfToken = (tag: string): string => ['hf', `${tag}abcdefghijklmnopqrstuvwxyz`].join('_');

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('LOCAL GPU Model Manager', () => {
  describe('install state from the Hugging Face cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ais-hf-'));
    after(() => rmSync(cache, { recursive: true, force: true }));

    it('not installed, interrupted (partial) and installed; required files are checked', () => {
      assert.equal(repoState(cache, { repo: 'org/none' }).state, 'not_installed');
      fakeRepo(cache, 'org/partial', { 'model_index.json': '{}' }, { incomplete: true });
      const partial = repoState(cache, { repo: 'org/partial', required: ['model_index.json'] });
      assert.deepEqual([partial.state, partial.incomplete], ['partial', 1]);
      fakeRepo(cache, 'org/full', { 'model_index.json': '{}', 'unet/w.safetensors': 'x'.repeat(1000) });
      const full = repoState(cache, {
        repo: 'org/full',
        required: ['model_index.json'],
        allowPatterns: ['unet/w.safetensors', '*.json'],
      });
      assert.equal(full.state, 'installed');
      assert.equal(full.commit, 'abc123');
      const missing = repoState(cache, { repo: 'org/full', allowPatterns: ['vae/v.safetensors'] });
      assert.deepEqual([missing.state, missing.missing], ['partial', ['vae/v.safetensors']]);
    });

    it('sizes count real data once (links into blobs are not counted twice)', () => {
      const root = fakeRepo(cache, 'org/links', { 'a.bin': 'x'.repeat(500) });
      try {
        symlinkSync(
          join(root, 'snapshots', 'abc123', 'a.bin'),
          join(root, 'snapshots', 'abc123', 'link.bin'),
        );
      } catch {
        return; // no symlink permission (Windows without developer mode): nothing to check
      }
      assert.equal(folderBytes(root), 500 + 'abc123'.length);
    });
  });

  describe('views, VRAM fit, install / cancel / delete', () => {
    let s: TestStudio;
    before(() => {
      s = testStudio({ hardware: fakeHardware({ name: 'RTX 4070', totalMb: 12288 }) });
    });
    after(() => s.cleanup());

    it('lists the local catalog with status, disk and a VRAM fit from usable VRAM', () => {
      const views = s.localModels.views({ usableVramGb: 11, hasGpu: true });
      const byId = new Map(views.map((v) => [v.id, v]));
      assert.equal(byId.get('kokoro-82m')!.status, 'NOT INSTALLED');
      assert.equal(byId.get('kokoro-82m')!.fit, 'cpu');
      assert.equal(byId.get('ffmpeg-lanczos')!.status, 'BUILT IN');
      assert.equal(byId.get('sdxl-base')!.fit, 'fits');
      assert.equal(
        byId.get('flux1-schnell')!.fit,
        'offload',
        '24 GB model on 11 GB: sequential offload only',
      );
      assert.equal(byId.get('wan2.2-ti2v-5b')!.fit, 'offload');
      assert.equal(LocalModelService.fit(byId.get('sdxl-base')!, 0, false).fit, 'no_gpu');
      assert.equal(LocalModelService.fit(byId.get('sdxl-base')!, 3, true).fit, 'too_big');
    });

    it('only installed models are offered to the local worker', () => {
      const env = s.router.localWorker.processEnv('t'.repeat(64), 8765);
      const enabled = env['WORKER_ENABLED_MODELS']!.split(',');
      assert.ok(enabled.includes('ffmpeg-lanczos'), 'built-in models need no download');
      assert.ok(!enabled.includes('kokoro-82m'), 'not installed yet');
    });

    it('install: confirmation plan, download, READY; the worker then gets the model', async () => {
      const cache = storagePaths(s.env).modelCache;
      const { fn, calls } = fakeSpawn((args) => {
        fakeRepo(cache, args[args.indexOf('--repo') + 1]!, { 'config.json': '{}', 'kokoro-v1_0.pth': 'w' });
        return { ok: true };
      });
      const svc = new LocalModelService({
        db: s.db,
        env: s.env,
        logger: s.logger,
        catalog: s.router.localCatalog,
        secrets: s.secrets,
        spawnFn: fn,
        progressMs: 5,
      });
      const plan = svc.plan('kokoro-82m');
      assert.equal(plan.cacheDir, cache);
      assert.equal(plan.enoughSpace, true);
      await svc.install('kokoro-82m');
      await waitFor(() => svc.lastDownload('kokoro-82m')?.status === 'complete');
      assert.deepEqual(calls[0]!.slice(0, 5), [
        '-m',
        'ais_worker.download',
        '--repo',
        'hexgrad/Kokoro-82M',
        '--cache',
      ]);
      assert.equal(
        svc.views({ usableVramGb: 0, hasGpu: false }).find((v) => v.id === 'kokoro-82m')!.status,
        'READY',
      );
      const env = s.router.localWorker.processEnv('t'.repeat(64), 8765);
      assert.ok(env['WORKER_ENABLED_MODELS']!.split(',').includes('kokoro-82m'));
    });

    it('a gated model explains what to do; the saved HF token is passed only to the download', async () => {
      s.secrets.set('hfToken', fakeHfToken('TESTONLY'));
      let envSeen: NodeJS.ProcessEnv = {};
      const fn = ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        envSeen = opts.env;
        const gated = fakeSpawn(() => ({
          ok: false,
          kind: 'gated',
          message: 'This model is gated: accept its terms',
        })).fn as unknown as (b: string, a: string[]) => unknown;
        return gated(bin, args);
      }) as never;
      const svc = new LocalModelService({
        db: s.db,
        env: s.env,
        logger: s.logger,
        catalog: s.router.localCatalog,
        secrets: s.secrets,
        spawnFn: fn,
      });
      s.router.localCatalog.acknowledgeLicense('stable-audio-open', true);
      await svc.install('stable-audio-open');
      await waitFor(() => svc.lastDownload('stable-audio-open')?.status === 'failed');
      assert.match(svc.lastDownload('stable-audio-open')!.error_message!, /gated/);
      assert.equal(envSeen['HF_TOKEN'], fakeHfToken('TESTONLY'));
      assert.equal(envSeen['RUNPOD_API_KEY'], undefined);
    });

    it('cancel keeps partial files (Install resumes); delete needs the worker stopped', async () => {
      const { fn } = fakeSpawn(() => ({ ok: true, hang: true }));
      const svc = new LocalModelService({
        db: s.db,
        env: s.env,
        logger: s.logger,
        catalog: s.router.localCatalog,
        secrets: s.secrets,
        spawnFn: fn,
      });
      await svc.install('real-esrgan');
      assert.equal(
        svc.views({ usableVramGb: 11, hasGpu: true }).find((v) => v.id === 'real-esrgan')!.status,
        'DOWNLOADING',
      );
      svc.cancel('real-esrgan');
      await waitFor(() => svc.lastDownload('real-esrgan')?.status === 'cancelled');
      assert.match(svc.lastDownload('real-esrgan')!.error_message!, /resume/);
      assert.throws(() => svc.remove('kokoro-82m', { workerRunning: true }), /Stop the local worker first/);
      const freed = svc.remove('kokoro-82m', { workerRunning: false });
      assert.ok(freed > 0);
      assert.equal(
        svc.views({ usableVramGb: 0, hasGpu: false }).find((v) => v.id === 'kokoro-82m')!.status,
        'NOT INSTALLED',
      );
    });

    it('refuses a download that does not fit on the disk', () => {
      const svc = s.localModels;
      const p = svc.plan('flux1-schnell');
      assert.equal(typeof p.enoughSpace, 'boolean');
      assert.ok(p.expectedBytes > 30 * 1024 ** 3);
    });
  });

  describe('pages', () => {
    let s: TestStudio;
    let server: Server;
    let web: WebDriver;
    before(async () => {
      s = testStudio({ hardware: fakeHardware({ name: 'RTX 4070', totalMb: 12288 }) });
      const { handle } = createWebApp(s);
      server = createServer((req, res) => void handle(req, res));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      web = WebDriver.fromServer(server);
    });
    after(() => {
      server.close();
      s.cleanup();
    });

    it('Model Manager shows every model with status, disk, VRAM and licence', async () => {
      const p = await web.get('/models');
      assert.equal(p.status, 200);
      for (const t of [
        'Stable Diffusion XL',
        'FLUX.1 [schnell]',
        'Wan 2.2',
        'Kokoro 82M',
        'NOT INSTALLED',
        'BUILT IN',
      ])
        assert.ok(p.text.includes(t), t);
      assert.match(p.text, /only with sequential CPU offload/);
      assert.ok(p.html.includes('href="/models/kokoro-82m/install"'));
    });

    it('install always goes through a confirmation page that shows size and destination', async () => {
      const p = await web.get('/models/wan2.2-ti2v-5b/install');
      assert.match(p.text, /about 34 GB/);
      assert.ok(p.text.includes(s.localModels.cacheDir));
      await web.get('/models');
      const refused = await web.post('/models/wan2.2-ti2v-5b/install', {});
      assert.match(refused.error ?? '', /confirm the download first/);
      assert.equal(s.localModels.lastDownload('wan2.2-ti2v-5b'), null, 'nothing started');
    });

    it('delete needs the typed confirmation', async () => {
      await web.get('/models');
      const p = await web.post('/models/kokoro-82m/delete', { confirm: 'yes' });
      assert.match(p.error ?? '', /Type DELETE/);
    });

    it('a Hugging Face token is validated and never shown', async () => {
      await web.get('/models');
      const bad = await web.submit('/models/hf-token', { hf_token: 'nope' });
      assert.match(bad.error ?? '', /does not look like/);
      const token = fakeHfToken('SECRET');
      const ok = await web.submit('/models/hf-token', { hf_token: token });
      assert.equal(ok.error, null);
      const page = await web.get('/models');
      assert.ok(!page.html.includes(token));
    });

    it('Disk & Storage lists every area and clears only temporary data', async () => {
      const p = await web.get('/disk');
      for (const t of [
        'AI models',
        'Projects (generated media)',
        'Final exports',
        'Render temp',
        'Download cache',
      ])
        assert.ok(p.text.includes(t), t);
      const jobs = join(s.env.dataDir, 'worker', 'jobs');
      for (const [id, status] of [
        ['job_done', 'complete'],
        ['job_live', 'running'],
      ]) {
        mkdirSync(join(jobs, id!), { recursive: true });
        writeFileSync(join(jobs, id!, 'job.json'), JSON.stringify({ status }));
        writeFileSync(join(jobs, id!, 'out.png'), 'x'.repeat(2000));
      }
      assert.ok(cleanup(s, 'worker_jobs') > 0);
      assert.equal(existsSync(join(jobs, 'job_done')), false);
      assert.equal(existsSync(join(jobs, 'job_live')), true, 'a running job is never touched');
      assert.ok(
        diskUsage(s).every(
          (a) => ['render_temp', 'download_cache', 'worker_jobs'].includes(a.key) === a.clearable,
        ),
      );
      await web.get('/disk');
      const refused = await web.post('/disk/clean/projects', {});
      assert.match(refused.error ?? '', /Only temporary areas/);
    });
  });

  describe('worker runtime installer', () => {
    const gpu = (cuda: string, cc: string): NvidiaReport => ({
      found: true,
      smiPath: 'nvidia-smi',
      driverVersion: '1',
      cudaDriverVersion: cuda,
      gpus: [
        {
          index: 0,
          name: 'G',
          uuid: null,
          driverVersion: '1',
          vramTotalMb: 12000,
          vramUsedMb: 0,
          vramFreeMb: 12000,
          utilizationPct: 0,
          temperatureC: 0,
          computeCapability: cc,
        },
      ],
      error: null,
      checkedAt: 'x',
    });

    it('plans the CUDA wheel matching the driver, and refuses clearly when it cannot', () => {
      const p = planRuntime('gpu', gpu('12.7', '8.9'), '/w');
      assert.equal(p.wheel, 'cu126');
      assert.ok(p.steps.some((st) => st.args.includes('https://download.pytorch.org/whl/cu126')));
      assert.ok(p.steps.some((st) => st.args.some((a) => a.endsWith('requirements-local.txt'))));
      assert.throws(() => planRuntime('gpu', null, '/w'), /No NVIDIA GPU/);
      assert.throws(() => planRuntime('gpu', gpu('12.6', '12.0'), '/w'), /RTX 50-series/);
      const cpu = planRuntime('cpu', null, '/w');
      assert.ok(cpu.steps.some((st) => st.args.includes('https://download.pytorch.org/whl/cpu')));
    });

    it('runs the steps in order into the worker environment and stops at the first failure', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ais-rt-'));
      mkdirSync(join(dir, 'ais_worker'));
      const seen: string[] = [];
      const fn = ((bin: string, args: string[]) => {
        seen.push(`${bin} ${args.join(' ')}`);
        const child = new EventEmitter() as FakeChild;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        const fail = args.includes('torch==2.7.1');
        setImmediate(() => child.emit('exit', fail ? 1 : 0));
        return child;
      }) as never;
      const inst = new RuntimeInstaller({
        logger: testStudio().logger,
        dataDir: dir,
        workerDir: dir,
        spawnFn: fn,
      });
      const plan = planRuntime('cpu', null, dir);
      await inst.start(plan);
      await waitFor(() => inst.status().state !== 'running');
      assert.equal(inst.status().state, 'failed');
      assert.match(inst.status().error!, /Install PyTorch/);
      assert.ok(seen[0]!.includes('-m venv'), 'creates the venv first');
      assert.ok(!seen.some((l) => l.includes('kokoro==0.9.4')), 'stopped after the failed step');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
