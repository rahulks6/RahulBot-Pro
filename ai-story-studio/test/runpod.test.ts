import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { Logger, MemorySink } from '../src/lib/logger.ts';
import { backoffMs } from '../src/providers/cloud/http.ts';
import { normalizePodState, parseGpuType, RunPodApi } from '../src/providers/cloud/runpod.ts';
import { UnsupportedCloudApi } from '../src/providers/cloud/unsupported.ts';
import { SecretStore } from '../src/services/secrets.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';

describe('RunPod API v2 adapter (against a local mock RunPod; nothing is billed)', () => {
  const rp = new MockRunPod();
  const sleeps: number[] = [];
  const api = (key = rp.apiKey) =>
    new RunPodApi({
      apiKey: key,
      baseUrl: rp.baseUrl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    });
  const spec = {
    name: 'ais-abc123-x1',
    image: 'ghcr.io/example/worker:1',
    gpuTypeId: 'NVIDIA RTX A5000',
    gpuCount: 1,
    cloud: 'SECURE' as const,
    env: { WORKER_AUTH_TOKEN: 'aisw_secret' },
    ports: ['8765/http'],
    containerDiskGb: 40,
    volume: { kind: 'persistent' as const, sizeGb: 60, path: '/workspace' },
  };

  before(async () => {
    await rp.start();
  });
  after(() => rp.stop());
  beforeEach(() => {
    rp.requests = [];
    rp.failures = [];
    rp.dropCreateFields = [];
    rp.pods.clear();
    sleeps.length = 0;
  });

  it('tests the connection and reports an invalid key clearly, without retrying', async () => {
    assert.match((await api().testConnection()).detail, /key accepted/);
    rp.requests = [];
    await assert.rejects(api('rpa_WRONGKEY0000000000').testConnection(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_AUTH_FAILED');
      assert.equal(e.message, 'RunPod authentication failed. Check your API key.');
      assert.ok(!e.message.includes('WRONGKEY'), 'the key never appears in errors');
      return true;
    });
    assert.equal(rp.requests.length, 1, '401 is never retried');
    assert.equal(rp.requests[0]!.auth, 'Bearer rpa_WRONGKEY0000000000');
  });

  it('lists GPU types with price, VRAM and stock', async () => {
    const gpus = await api().listGpuTypes('SECURE');
    const a5000 = gpus.find((g) => g.id === 'NVIDIA RTX A5000')!;
    assert.deepEqual([a5000.vramGb, a5000.hourlyUsd, a5000.available], [24, 0.27, true]);
    assert.equal(gpus.find((g) => g.id === 'NVIDIA L4')!.available, false, 'stock None = unavailable');
    assert.equal(
      (await api().listGpuTypes('COMMUNITY')).find((g) => g.id === 'NVIDIA RTX A5000')!.hourlyUsd,
      0.16,
    );
  });

  it('checks the published contract and sends only declared optional fields', async () => {
    const report = await api().checkContract();
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.ok(report.createFields.includes('containerDiskInGb'));
    const pod = await api().createPod(spec);
    assert.equal(pod.state, 'starting');
    const post = rp.requests.find((r) => r.method === 'POST')!;
    assert.deepEqual(post.body, {
      name: 'ais-abc123-x1',
      image: 'ghcr.io/example/worker:1',
      gpu: { id: 'NVIDIA RTX A5000', count: 1 },
      cloud: 'SECURE',
      env: { WORKER_AUTH_TOKEN: 'aisw_secret' },
      ports: ['8765/http'],
      mounts: { persistent: { size: 60, path: '/workspace' } },
      containerDiskInGb: 40,
    });
  });

  it('refuses to create anything when RunPod API drifted', async () => {
    rp.dropCreateFields = ['gpu'];
    await assert.rejects(api().createPod(spec), (e: AppError) =>
      /no longer matches.*field gpu.*Nothing was created/s.test(e.message),
    );
    assert.equal(rp.requests.filter((r) => r.method === 'POST').length, 0);
    rp.dropCreateFields = ['containerDiskInGb'];
    const a = api();
    await a.createPod(spec);
    assert.ok(
      !('containerDiskInGb' in (rp.requests.find((r) => r.method === 'POST')!.body as object)),
      'undeclared optional field omitted',
    );
  });

  it('never retries a create after an ambiguous failure, but does after 429', async () => {
    const a = api();
    await a.checkContract();
    rp.failNext('POST', /^\/pods$/, 500);
    await assert.rejects(a.createPod(spec), (e: AppError) => e.code === 'CLOUD_UNAVAILABLE');
    rp.failNext('POST', /^\/pods$/, 0, 1, { drop: true });
    await assert.rejects(a.createPod(spec), (e: AppError) => e.code === 'CLOUD_UNAVAILABLE');
    assert.equal(rp.requests.filter((r) => r.method === 'POST').length, 2, 'one attempt each');
    rp.failNext('POST', /^\/pods$/, 429, 1, { retryAfter: '2' });
    const pod = await a.createPod(spec);
    assert.ok(pod.id);
    assert.deepEqual(sleeps, [1000], 'Retry-After honoured (capped at maxDelay)');
    assert.equal(rp.livePods().length, 1, 'exactly one pod exists');
  });

  it('retries idempotent calls with backoff, pages through pods, terminates idempotently', async () => {
    const a = api();
    for (let i = 0; i < 5; i++) rp.addPod(`ais-abc123-p${i}`);
    rp.failNext('GET', /^\/pods$/, 503, 2);
    const pods = await a.listPods();
    assert.equal(pods.length, 5, 'three pages of two');
    assert.deepEqual(sleeps, [100, 200], 'exponential backoff');
    const id = pods[0]!.id;
    assert.equal((await a.getPod(id))!.state, 'running');
    await a.terminatePod(id);
    await a.terminatePod(id); // already gone: still fine
    assert.equal(await a.getPod(id), null);
    rp.failNext('GET', /^\/pods$/, 400, 1);
    await assert.rejects(a.listPods(), (e: AppError) => e.code === 'CLOUD_BAD_REQUEST');
  });

  it('gives up after bounded retries when RunPod is down', async () => {
    rp.failNext('GET', /^\/catalog\/gpus$/, 502, 10);
    await assert.rejects(api().listGpuTypes(), (e: AppError) => e.code === 'CLOUD_UNAVAILABLE');
    assert.equal(rp.requests.filter((r) => r.path === '/catalog/gpus').length, 3, 'attempts = 3');
    assert.equal(sleeps.length, 2, 'bounded backoff between the attempts');
  });

  it('builds the pod proxy URL', () => {
    assert.equal(
      new RunPodApi({ apiKey: 'k' }).workerUrl('abc123', 8765),
      'https://abc123-8765.proxy.runpod.net',
    );
  });
});

describe('cloud helpers', () => {
  it('normalises pod states and parses GPU variants', () => {
    assert.equal(normalizePodState('RUNNING'), 'running');
    assert.equal(normalizePodState('EXITED'), 'stopped');
    assert.equal(normalizePodState('TERMINATED'), 'terminated');
    assert.equal(normalizePodState('CREATED'), 'starting');
    assert.equal(normalizePodState('???'), 'unknown');
    const g = parseGpuType(
      { id: 'x', memoryInGb: '48', lowestPrice: { uninterruptablePrice: '0.5', stockStatus: 'Low' } },
      'SECURE',
    );
    assert.deepEqual([g.vramGb, g.hourlyUsd, g.available], [48, 0.5, true]);
    assert.equal(parseGpuType({ id: 'y' }, 'SECURE').hourlyUsd, null);
  });

  it('computes bounded exponential backoff and honours Retry-After', () => {
    const p = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 8000 };
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => backoffMs(n, p)),
      [1000, 2000, 4000, 8000, 8000],
    );
    assert.equal(backoffMs(1, p, '3'), 3000);
  });

  it('refuses every call on unsupported providers', async () => {
    const vast = new UnsupportedCloudApi('vast');
    await assert.rejects(
      vast.createPod(),
      (e: AppError) => e.code === 'NOT_SUPPORTED' && /Vast\.ai is not supported/.test(e.message),
    );
    await assert.rejects(
      new UnsupportedCloudApi('tensordock').listPods(),
      (e: AppError) => e.code === 'NOT_SUPPORTED',
    );
  });
});

describe('secret store and log redaction', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ais-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores, masks and prefers .env; file is private', () => {
    const s = new SecretStore(dir, {});
    assert.equal(s.masked('runpodApiKey'), 'not set');
    s.set('runpodApiKey', '  rpa_ABCDEFGHIJKLMNOP1234  ');
    assert.equal(s.get('runpodApiKey'), 'rpa_ABCDEFGHIJKLMNOP1234');
    assert.equal(s.masked('runpodApiKey'), '••••••••1234');
    assert.equal(s.source('runpodApiKey'), 'store');
    if (process.platform !== 'win32') assert.equal(statSync(s.path).mode & 0o777, 0o600);
    const fromEnv = new SecretStore(dir, { RUNPOD_API_KEY: 'rpa_FROMENV000000009999' });
    assert.equal(fromEnv.get('runpodApiKey'), 'rpa_FROMENV000000009999');
    assert.equal(fromEnv.source('runpodApiKey'), 'env');
    assert.throws(() => s.set('runpodApiKey', 'has space'), /valid key/);
    const t = SecretStore.newWorkerToken();
    assert.match(t, /^aisw_[0-9a-f]{64}$/);
    s.saveWorkerToken('pod1', t);
    assert.equal(new SecretStore(dir, {}).workerToken('pod1'), t);
    s.forgetWorkerToken('pod1');
    assert.equal(new SecretStore(dir, {}).workerToken('pod1'), undefined);
  });

  it('never logs API keys or worker tokens', () => {
    const sink = new MemorySink();
    const log = new Logger('debug', [sink]);
    const token = SecretStore.newWorkerToken();
    log.info('provisioning', {
      url: `x?key=rpa_ABCDEFGHIJKLMNOP1234`,
      note: `token ${token}`,
      apiKey: 'plain',
      hf: 'hf_abcdefghijklmnopqrstu',
    });
    const line = sink.lines.join('\n');
    for (const secret of ['rpa_ABCDEFGHIJKLMNOP1234', token, 'plain', 'hf_abcdefghijklmnopqrstu'])
      assert.ok(!line.includes(secret), secret);
  });
});
