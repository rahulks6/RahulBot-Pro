import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { encodePng } from '../src/media/png.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';
import { FakeCloudWorker } from './fixtures/fake-worker.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';

/**
 * Cloud GPU lifecycle against a mock RunPod v2 API and a fake cloud worker.
 * These run the REAL supervisor / queue / cloud service code paths; nothing
 * talks to RunPod and nothing can be billed.
 */
const rp = new MockRunPod();
const worker = new FakeCloudWorker(rp);
const registry = new MockRegistry();
const WORKER_REPO = 'rahulks6/ai-story-studio-worker';
const noSleep = async () => undefined;

function cloudStudio(
  opts: {
    env?: Record<string, unknown>;
    cloud?: Record<string, unknown>;
    now?: () => number;
    key?: string;
  } = {},
): TestStudio {
  const s = testStudio({
    env: { mockGeneration: false, enableCloudGpu: true, ...(opts.env ?? {}) },
    secretEnv: { RUNPOD_API_KEY: opts.key ?? rp.apiKey },
    cloud: {
      runpodBaseUrl: rp.baseUrl,
      proxyUrlTemplate: worker.template,
      sleep: noSleep,
      pollMs: 1,
      workerPollMs: 1,
      registryBaseUrlFor: () => registry.base,
      ...(opts.now ? { now: opts.now } : {}),
    },
  });
  s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 100 });
  s.settings.set('cloud', {
    ...s.settings.get('cloud'),
    cloudEnabled: true,
    realGeneration: true,
    workerStartTimeoutMinutes: 2,
    ...(opts.cloud ?? {}),
  });
  s.cloud.refresh();
  return s;
}

/** The second narration line of the seeded story. */
function nar2(s: TestStudio): string {
  return s.db.get<{ id: string }>('SELECT id FROM narration_lines ORDER BY rowid LIMIT 1 OFFSET 1')!.id;
}

function queueNarration(s: TestStudio): string {
  const { story } = seedSmall(s);
  const scene = s.stories.tree(story.id).scenes[0]!;
  return s.generation.queueNarrationAudio(scene.narration[0]!.id).id;
}

describe('cloud GPU lifecycle (mock RunPod + fake worker, ₹0)', () => {
  let s: TestStudio | undefined;
  before(async () => {
    await rp.start();
    await worker.start();
    await registry.start();
  });
  after(async () => {
    await worker.stop();
    await rp.stop();
    await registry.stop();
  });
  beforeEach(() => {
    rp.pods.clear();
    rp.requests = [];
    rp.failures = [];
    worker.jobs.clear();
    worker.submitted = [];
    worker.cancels = [];
    worker.unhealthyFor = 0;
    worker.neverHealthy = false;
    worker.notReadyFor = 0;
    worker.noGpu = false;
    worker.torchNoCuda = false;
    worker.corruptDownloads = 0;
    worker.jobPolls = 0;
    rp.catalog.rejectAvailability = false;
    registry.repos.clear();
    registry.repos.set(WORKER_REPO, {
      visibility: 'public',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
  });
  afterEach(() => {
    s?.cleanup();
    s = undefined;
  });

  it('mock mode stays mock: no RunPod call, placeholders only', async () => {
    s = testStudio({ secretEnv: { RUNPOD_API_KEY: rp.apiKey } });
    assert.equal(s.cloud.mode(), 'MOCK');
    assert.match(s.cloud.modeLabel(), /MOCK/);
    assert.equal(s.gpu.currentProvider.paid, false);
    queueNarration(s);
    await s.generation.processQueue();
    assert.equal(rp.requests.length, 0, 'RunPod was never contacted');
    assert.ok(s.assets.list({}).every((a) => a.is_mock === 1));
  });

  it('cloud mode cannot start by accident: every gate is required', async () => {
    s = cloudStudio({ cloud: { cloudEnabled: false } });
    assert.equal(s.cloud.mode(), 'MOCK');
    assert.equal(s.gpu.currentProvider.paid, false);
    assert.equal(s.cloud.canProvision(), false);
    s.settings.set('cloud', { ...s.settings.get('cloud'), cloudEnabled: true, realGeneration: false });
    s.cloud.refresh();
    assert.equal(s.cloud.mode(), 'MOCK', 'cloud GPU usable, but real generation not armed');
    queueNarration(s);
    await assert.rejects(s.generation.processQueue(), /no real models are connected/);
    assert.equal(rp.livePods().length, 0, 'nothing rented without the real-generation switch');
    s.cleanup();
    s = cloudStudio({ env: { enableCloudGpu: false } });
    assert.equal(s.cloud.canProvision(), false);
    assert.equal(s.cloud.gates().find((g) => g.name.startsWith('ENABLE_CLOUD_GPU'))!.ok, false);
  });

  it('reports an invalid API key clearly and rents nothing', async () => {
    s = cloudStudio({ key: 'rpa_WRONG000000000000000' });
    const t = await s.cloud.testConnection();
    assert.equal(t.ok, false);
    assert.equal(t.detail, 'RunPod authentication failed. Check your API key.');
    queueNarration(s);
    const r = await s.generation.processQueue();
    assert.equal(r.failed, 1);
    assert.match(s.jobs.list({})[0]!.error_message ?? '', /authentication failed/);
    assert.equal(rp.livePods().length, 0);
  });

  it('runs a full session: provision → boot → worker → generate → download → terminate', async () => {
    s = cloudStudio();
    assert.equal(s.cloud.mode(), 'REAL_CLOUD');
    const jobId = queueNarration(s);
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1, r.messages.join(' '));
    const job = s.jobs.get(jobId);
    assert.equal(job.status, 'complete');
    assert.equal(job.remote_job_id, null, 'remote bookkeeping cleared after success');
    const pod = [...rp.pods.values()][0]!;
    assert.match(pod.name, new RegExp(`^ais-${s.cloud.installId}-`), 'pod named for ownership');
    assert.match(pod.env['WORKER_AUTH_TOKEN']!, /^aisw_[0-9a-f]{64}$/, 'fresh per-session token');
    assert.equal(pod.env['WORKER_MOCK_MODELS'], 'false');
    assert.match(pod.env['WORKER_ENABLED_MODELS']!, /kokoro-82m/);
    assert.ok(Number(pod.env['AIS_POD_MAX_LIFETIME_MIN']) > 0, 'pod-side guard configured');
    assert.equal(pod.status, 'TERMINATED', 'after_batch: terminated when no work remains');
    const inst = s.gpuRepo.list()[0]!;
    assert.equal(inst.status, 'terminated');
    assert.equal(inst.lifecycle_state, 'STOPPED');
    const states = s.gpuRepo
      .events(100)
      .map((e) => e.event)
      .reverse()
      .filter((e) => e.startsWith('state:'));
    for (const st of ['BOOTING', 'WORKER_STARTING', 'READY', 'GENERATING', 'TERMINATING', 'STOPPED'])
      assert.ok(states.includes(`state:${st}`), `${st} in ${states.join(',')}`);
    const audio = s.assets.list({}).find((a) => a.kind === 'audio')!;
    assert.equal(audio.is_mock, 0, 'real (non-mock) asset from the cloud worker');
    assert.equal(s.secrets.workerToken(pod.id), undefined, 'session token forgotten');
    assert.equal(s.cloud.bridge.instanceId, null, 'providers unbound');
    assert.equal(worker.submitted[0]!.body['kind'], 'tts');
  });

  it('starts shot images from the approved character reference (image-to-image)', async () => {
    s = cloudStudio();
    const { ari, shots } = seedSmall(s);
    const png = encodePng(32, 32, () => [200, 120, 40]);
    const ref = await s.assets.createReference(
      s.characters.get(ari.id).project_id,
      'character',
      ari.id,
      png,
      'png',
      'image/png',
      'front',
      false,
    );
    const cref = s.characters.addReference(ari.id, ref, { slot_type: 'view', slot: 'front' });
    s.characters.setReferenceApproval(cref.id, true);
    s.generation.queueImage(shots[0]!.id);
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1, r.messages.join(' '));
    const body = worker.submitted.find((x) => x.path === '/generate/image')!.body;
    assert.equal(body['init_image'], png.toString('base64'), 'the approved reference is the starting point');
    assert.equal(body['strength'], 0.8);
    s.settings.set('generation', { ...s.settings.get('generation'), characterReferenceStrength: 0 });
    s.generation.queueImage(shots[1]!.id);
    await s.generation.processQueue();
    assert.equal(
      worker.submitted.filter((x) => x.path === '/generate/image').at(-1)!.body['init_image'],
      undefined,
      '0 = off',
    );
  });

  it('terminates the GPU when the worker never becomes healthy', async () => {
    let t = Date.now();
    s = cloudStudio({ now: () => (t += 20_000) });
    worker.neverHealthy = true;
    queueNarration(s);
    const r = await s.generation.processQueue();
    assert.equal(r.failed, 1);
    const msg = s.jobs.list({})[0]!.error_message ?? '';
    assert.match(
      msg,
      /Cloud worker did not become healthy within 2 minutes.*The GPU has been terminated to prevent additional charges/,
    );
    assert.equal(rp.livePods().length, 0);
    assert.equal(s.gpuRepo.list()[0]!.termination_reason, 'worker_start_timeout');
  });

  it('handles provisioning failures and provider outages without leaving anything', async () => {
    s = cloudStudio();
    rp.failNext('POST', /^\/pods$/, 500);
    queueNarration(s);
    let r = await s.generation.processQueue();
    assert.equal(r.failed, 1);
    assert.equal(rp.livePods().length, 0);
    assert.equal(s.gpuRepo.list()[0]!.status, 'failed');
    rp.failNext('GET', /^\/catalog\/gpus$/, 503, 10);
    s.generation.queueNarrationAudio(nar2(s!));
    r = await s.generation.processQueue();
    assert.match(r.messages.join(' '), /temporarily unavailable/);
    assert.equal(rp.requests.filter((q) => q.method === 'POST').length, 1, 'no create during the outage');
  });

  it('refuses a GPU above the hourly price and a batch above the session budget', async () => {
    s = cloudStudio();
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 5 });
    queueNarration(s);
    let r = await s.generation.processQueue();
    assert.match(
      r.messages.join(' '),
      /No compatible GPU is currently available below your configured hourly price/,
    );
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 100 });
    s.settings.set('cloud', {
      ...s.settings.get('cloud'),
      sessionBudgetInr: 1,
      allowedGpuTypes: 'NVIDIA GeForce RTX 4090',
    });
    s.generation.queueNarrationAudio(nar2(s!));
    for (const d of s.db.all<{ id: string }>('SELECT id FROM dialogue_lines'))
      s.generation.queueDialogueAudio(d.id);
    r = await s.generation.processQueue();
    assert.match(r.messages.join(' '), /above your session budget/);
    assert.equal(rp.pods.size, 0, 'nothing rented');
  });

  it('enforces .env hard caps over Settings', async () => {
    s = cloudStudio({
      env: { caps: { maxConcurrentGpuInstances: 1, sessionBudgetInr: 20, maxGpuHourlyRateInr: 30 } },
    });
    s.settings.set('cloud', { ...s.settings.get('cloud'), sessionBudgetInr: 500, maxConcurrentInstances: 4 });
    const l = s.gpu.limits();
    assert.deepEqual([l.sessionBudgetInr, l.maxConcurrent, l.maxHourlyRateInr], [20, 1, 30]);
    assert.deepEqual(l.cappedBy.sort(), [
      'MAX_CONCURRENT_GPU_INSTANCES',
      'MAX_GPU_HOURLY_RATE',
      'SESSION_BUDGET',
    ]);
  });

  it('stops for the session budget, idle timeout and maximum lifetime', async () => {
    s = cloudStudio({ cloud: { autoTerminate: 'idle_timeout', sessionBudgetInr: 10 } });
    queueNarration(s);
    await s.generation.processQueue();
    let inst = s.gpuRepo.active()[0]!;
    assert.equal(inst.lifecycle_state, 'IDLE', 'kept warm (idle_timeout policy)');
    s.clockCtl.advanceSeconds(9 * 60);
    assert.deepEqual(await s.gpu.enforceTimers(), [], 'within idle timeout');
    s.clockCtl.advanceSeconds(2 * 60);
    assert.deepEqual(await s.gpu.enforceTimers(), [inst.id]);
    assert.equal(s.gpuRepo.get(inst.id).termination_reason, 'idle_timeout');
    assert.equal(rp.livePods().length, 0);

    // Session budget: ₹10 at ≈₹23.8/h is reached after ≈25 minutes of wall-clock time.
    s.settings.set('gpu', { ...s.settings.get('gpu'), idleTimeoutMinutes: 240, maxLifetimeMinutes: 600 });
    s.generation.queueNarrationAudio(nar2(s!));
    await s.generation.processQueue();
    inst = s.gpuRepo.active()[0]!;
    s.clockCtl.advanceSeconds(30 * 60);
    await s.gpu.enforceTimers();
    assert.equal(s.gpuRepo.get(inst.id).termination_reason, 'session_budget_reached');
    const spent = s.gpuRepo.sessionCost(inst.id);
    assert.ok(spent >= 11 && spent < 13, `wall-clock billing reconciled (₹${spent})`);

    // Maximum lifetime.
    s.settings.set('cloud', { ...s.settings.get('cloud'), sessionBudgetInr: 1000 });
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxLifetimeMinutes: 30 });
    const t = await s.cloudTest.prepare('tts');
    assert.ok(t.prepared);
    await s.cloudTest.confirm(t.prepared.id); // a started-and-terminated test proves start works; now keep one alive:
    const plan = await s.gpu.plan(0, 60);
    const session = await s.gpu.start(plan);
    s.clockCtl.advanceSeconds(31 * 60);
    await s.gpu.enforceTimers();
    assert.equal(s.gpuRepo.get(session.id).termination_reason, 'max_lifetime');
  });

  it('allows only one GPU at a time by default', async () => {
    s = cloudStudio();
    const plan = await s.gpu.plan(0, 60);
    await s.gpu.start(plan);
    await assert.rejects(
      s.gpu.start(plan),
      (e: AppError) => e.code === 'GPU_LIMIT' && /already running \(limit 1\)/.test(e.message),
    );
    assert.equal(rp.livePods().length, 1);
  });

  it('retries a corrupted download, and discards one that stays corrupted', async () => {
    s = cloudStudio();
    worker.corruptDownloads = 1;
    const id = queueNarration(s);
    await s.generation.processQueue();
    assert.equal(s.jobs.get(id).status, 'complete', 'second download attempt was valid');
    worker.corruptDownloads = 100;
    const id2 = s.generation.queueNarrationAudio(nar2(s!)).id;
    const before = s.assets.list({}).length;
    await s.generation.processQueue();
    const j = s.jobs.get(id2);
    assert.equal(j.status, 'failed');
    assert.match(
      j.error_message ?? '',
      /Asset download failed validation.*checksum mismatch.*The corrupted file was discarded/,
    );
    assert.equal(s.assets.list({}).length, before, 'no asset from a corrupted download');
    assert.equal(rp.livePods().length, 0, 'GPU still terminated');
  });

  it('EMERGENCY STOP terminates only this installation’s pods', async () => {
    s = cloudStudio({ cloud: { autoTerminate: 'idle_timeout' } });
    queueNarration(s);
    await s.generation.processQueue();
    const orphan = rp.addPod(`ais-${s.cloud.installId}-crash1`);
    const foreign = rp.addPod('my-own-jupyter-notebook');
    const other = rp.addPod('ais-someotherpc-xyz');
    await assert.rejects(s.cloud.emergencyStop('nope'), /confirmation/);
    const r = await s.cloud.emergencyStop('STOP');
    assert.equal(r.failed.length, 0);
    assert.ok(r.terminated.includes(orphan));
    assert.equal(rp.pods.get(foreign)!.status, 'RUNNING', 'never touches pods the studio did not create');
    assert.equal(rp.pods.get(other)!.status, 'RUNNING', 'nor another installation’s pods');
    assert.equal(s.gpuRepo.active().length, 0);
    assert.equal(rp.livePods().filter((p) => p.name.startsWith(`ais-${s!.cloud.installId}`)).length, 0);
  });

  it('recovers after a crash: requeues jobs, terminates leftover GPUs', async () => {
    s = cloudStudio({ cloud: { cloudEnabled: false } }); // restarted with cloud switched off
    const jobId = queueNarration(s);
    s.jobs.setStatus(jobId, 'generating_audio', 'was running when the app crashed');
    const leftover = rp.addPod(`ais-${s.cloud.installId}-leftover`);
    const foreign = rp.addPod('someone-else');
    const report = await s.cloud.recoverOnStartup();
    assert.equal(report.jobsRecovered, 1);
    assert.equal(s.jobs.get(jobId).status, 'waiting');
    assert.deepEqual(report.terminated, [leftover]);
    assert.equal(rp.pods.get(foreign)!.status, 'RUNNING');
  });

  it('never pays twice for a job after a restart: it re-polls the remote job', async () => {
    s = cloudStudio({ cloud: { autoTerminate: 'idle_timeout' } });
    queueNarration(s);
    await s.generation.processQueue(); // warm GPU stays up (idle policy)
    const inst = s.gpuRepo.active()[0]!;
    const job = s.generation.queueNarrationAudio(nar2(s));
    // Simulate: submitted to the worker, then the app crashed before downloading.
    const token = s.secrets.workerToken(inst.provider_instance_id)!;
    const remote = (await (
      await fetch(`${inst.worker_url}/generate/audio`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'tts', text: 'x' }),
      })
    ).json()) as { id: string };
    s.jobs.setRemote(job.id, {
      remoteJobId: remote.id,
      gpuInstanceId: inst.id,
      at: new Date().toISOString(),
    });
    s.jobs.setStatus(job.id, 'generating_audio');
    s.jobs.recoverInterrupted();
    const submittedBefore = worker.generateCount();
    await s.generation.processQueue();
    assert.equal(s.jobs.get(job.id).status, 'complete');
    assert.equal(worker.generateCount(), submittedBefore, 'no second generation was submitted');
  });

  it('cancels the remote job when the batch is aborted', async () => {
    s = cloudStudio();
    worker.jobPolls = 1_000_000;
    queueNarration(s);
    const ctrl = new AbortController();
    const run = s.generation.processQueue({ signal: ctrl.signal });
    while (worker.submitted.length === 0) await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await run;
    assert.equal(worker.cancels.length, 1, 'worker job cancelled');
    assert.equal(rp.livePods().length, 0, 'GPU terminated on cancellation');
  });

  it('guided first GPU test: free preparation, explicit confirmation, always terminated', async () => {
    s = cloudStudio();
    const prep = await s.cloudTest.prepare('tts');
    assert.ok(prep.prepared, prep.record.error_message ?? '');
    const steps = s.cloudTest.steps(prep.record);
    assert.deepEqual(
      steps.slice(0, 3).map((x) => x.status),
      ['ok', 'ok', 'ok'],
    );
    assert.match(steps[2]!.detail, /₹23\.76\/h/);
    assert.equal(steps[3]!.status, 'running', 'waiting for confirmation');
    assert.equal(rp.pods.size, 0, 'nothing rented before confirmation');
    const done = await s.cloudTest.confirm(prep.prepared.id);
    assert.equal(done.status, 'success', done.error_message ?? '');
    const final = s.cloudTest.steps(done);
    assert.ok(
      final.every((x) => x.status === 'ok'),
      JSON.stringify(final.filter((x) => x.status !== 'ok')),
    );
    assert.match(final[11]!.detail, /SUCCESS · RTX A5000 · runtime \d+ s · estimated cost ₹/);
    assert.ok(done.output_key && (await s.storage.exists(done.output_key)));
    assert.equal(rp.livePods().length, 0, 'GPU terminated');
    // Cancelling before confirmation rents nothing.
    const again = await s.cloudTest.prepare('tts');
    s.cloudTest.cancel(again.prepared!.id);
    assert.equal(s.cloudTest.get(again.prepared!.id).status, 'cancelled');
    assert.equal(rp.pods.size, 1);
  });

  it('dry-run diagnostics never provision', async () => {
    s = cloudStudio();
    const steps = await s.cloud.diagnostics();
    const byName = new Map(steps.map((x) => [x.step, x]));
    assert.equal(byName.get('API credentials and connectivity')!.ok, true);
    assert.match(
      byName.get('Compatible GPUs and price')!.detail,
      /cheapest: RTX A5000 \(24 GB\) at ₹23\.76\/h/,
    );
    assert.equal(byName.get('Model: music')!.ok, null, 'Stable Audio needs a licence acknowledgement first');
    assert.equal(rp.requests.filter((r) => r.method === 'POST').length, 0);
  });

  it('dry-run acceptance target: every non-gate check is OK against the published catalog contract', async () => {
    s = cloudStudio();
    const steps = await s.cloud.diagnostics();
    const byName = new Map(steps.map((x) => [x.step, x]));
    for (const name of [
      'API credentials and connectivity',
      'Compatible GPUs and price',
      'Worker image',
      'Model: image',
      'Model: video',
      'Model: tts',
      'Cost limits',
    ])
      assert.equal(byName.get(name)?.ok, true, `${name}: ${byName.get(name)?.detail}`);
    assert.match(byName.get('Worker image')!.detail, /^IMAGE EXISTS AND PUBLICLY PULLABLE/);
    assert.match(
      byName.get('Compatible GPUs and price')!.detail,
      /in stock for pods in secure cloud \(CUDA ≥ 12\.6\).*include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12\.6/,
    );
    assert.equal(rp.livePods().length, 0, 'nothing rented');
  });

  it('dry-run GPU step filters by minimum VRAM and the price ceiling, and says what to change', async () => {
    s = cloudStudio();
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 20 });
    let step = (await s.cloud.diagnostics()).find((x) => x.step === 'Compatible GPUs and price')!;
    assert.equal(step.ok, false);
    assert.match(
      step.detail,
      /below your configured hourly price \(₹20\/h\)\. Cheapest compatible in stock: RTX A5000 \(24 GB\) at ₹23\.76\/h/,
    );
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 100, minVramGb: 48 });
    step = (await s.cloud.diagnostics()).find((x) => x.step === 'Compatible GPUs and price')!;
    assert.equal(step.ok, false, 'only the 80 GB H100 is big enough, and it costs more than ₹100/h');
    assert.match(step.detail, /Cheapest compatible in stock: H100 SXM \(80 GB\)/);
    s.settings.set('gpu', { ...s.settings.get('gpu'), minVramGb: 96 });
    step = (await s.cloud.diagnostics()).find((x) => x.step === 'Compatible GPUs and price')!;
    assert.match(step.detail, /no GPU type with at least 96 GB VRAM/);
    assert.equal(rp.livePods().length, 0);
  });

  it('worker readiness: waits for ready=true, then checks the GPU the worker reports', async () => {
    s = cloudStudio();
    worker.notReadyFor = 2;
    const t = await s.cloudTest.prepare('tts');
    const done = await s.cloudTest.confirm(t.prepared!.id);
    assert.equal(done.status, 'success', done.error_message ?? '');
    const steps = s.cloudTest.steps(done);
    assert.match(steps.find((x) => x.n === 7)!.detail, /NVIDIA RTX A5000, 24 GB VRAM · CUDA 12\.6/);
    assert.equal(rp.livePods().length, 0);
  });

  it('a machine without a usable NVIDIA GPU fails fast and is terminated', async () => {
    s = cloudStudio();
    worker.noGpu = true;
    const t = await s.cloudTest.prepare('tts');
    const done = await s.cloudTest.confirm(t.prepared!.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error_message ?? '', /no usable NVIDIA GPU \(nvidia-smi not found\)/);
    assert.equal(rp.livePods().length, 0, 'the pod was terminated');
    worker.noGpu = false;
    worker.torchNoCuda = true;
    const again = await s.cloudTest.confirm((await s.cloudTest.prepare('tts')).prepared!.id);
    assert.equal(again.status, 'failed');
    assert.match(again.error_message ?? '', /PyTorch cannot use it/);
    assert.equal(rp.livePods().length, 0);
  });

  it('never rents a GPU when RunPod could not pull the worker image', async () => {
    registry.repos.set(WORKER_REPO, {
      visibility: 'private',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    s = cloudStudio();
    const t = await s.cloudTest.prepare('tts');
    assert.equal(t.prepared, null);
    assert.equal(t.record.status, 'failed');
    assert.match(t.record.error_message ?? '', /No GPU was rented\. IMAGE REQUIRES AUTHENTICATION/);
    queueNarration(s);
    await s.generation.processQueue().catch(() => undefined);
    assert.equal(rp.pods.size, 0, 'no pod was ever created');
    assert.equal(rp.requests.filter((r) => r.method === 'POST' && r.path === '/pods').length, 0);
  });

  it('dry-run never counts a priced GPU as available when stock is not reported, and never rents it', async () => {
    rp.catalog.rejectAvailability = true;
    s = cloudStudio();
    const step = (await s.cloud.diagnostics()).find((x) => x.step === 'Compatible GPUs and price')!;
    assert.equal(step.ok, false);
    assert.match(
      step.detail,
      /did not report stock, so none is treated as available \(a price is not availability\)/,
    );
    const t = await s.cloudTest.prepare('tts');
    assert.equal(t.prepared, null, 'no GPU plan without reported stock');
    assert.equal(rp.pods.size, 0);
    rp.catalog.rejectAvailability = false;
  });

  it('dry-run skips GPUs whose hosts lack the CUDA version the worker image needs', async () => {
    s = cloudStudio();
    const step = (await s.cloud.diagnostics()).find((x) => x.step === 'Compatible GPUs and price')!;
    // The RTX 3090 (₹19.36/h) is cheaper, but its hosts only offer CUDA 12.4.
    assert.match(step.detail, /cheapest: RTX A5000 \(24 GB\) at ₹23\.76\/h/);
    assert.ok(!/cheapest: RTX 3090/.test(step.detail));
  });

  it('dry-run reports a private, missing or unreachable worker image distinctly', async () => {
    s = cloudStudio();
    const image = async () => (await s!.cloud.diagnostics()).find((x) => x.step === 'Worker image')!;
    registry.repos.set(WORKER_REPO, {
      visibility: 'private',
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
    let step = await image();
    assert.equal(step.ok, false);
    assert.match(step.detail, /^IMAGE REQUIRES AUTHENTICATION/);
    registry.repos.set(WORKER_REPO, { visibility: 'public', tags: {} });
    step = await image();
    assert.equal(step.ok, false);
    assert.match(step.detail, /^IMAGE DOES NOT EXIST/);
    registry.failWith = 503;
    step = await image();
    assert.equal(step.ok, null, 'unknown, not failed');
    assert.match(step.detail, /^REGISTRY UNREACHABLE/);
    registry.failWith = null;
  });
});
