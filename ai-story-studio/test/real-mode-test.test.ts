import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';
import { FakeCloudWorker } from './fixtures/fake-worker.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';

/**
 * Milestone 1 (Real Mode Test) through its real code path against a mock RunPod and a fake worker
 * that returns real media made by FFmpeg, so combining, validating and decoding are executed for
 * real. This proves the TEST HARNESS; it is not a claim that real AI ran (that needs RunPod).
 */
const ff = findFfmpeg();
const rp = new MockRunPod();
const worker = new FakeCloudWorker(rp);
const registry = new MockRegistry();
const media = mkdtempSync(join(tmpdir(), 'ais-rmt-'));

function makeMedia(): void {
  const clip = join(media, 'clip.mp4');
  const frozen = join(media, 'frozen.mp4');
  const img = join(media, 'img.png');
  const wav = join(media, 'voice.wav');
  const run = (args: string[]) => execFileSync(ff!.ffmpeg, ['-y', '-v', 'error', ...args]);
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24:duration=3',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    clip,
  ]);
  run([
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:size=640x360:rate=24:duration=3',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    frozen,
  ]);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', img]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2.5', '-ar', '24000', wav]);
}

describe('Real Mode Test (milestone 1) harness', { skip: !ff && 'FFmpeg not installed' }, () => {
  let s: TestStudio;
  before(async () => {
    makeMedia();
    await rp.start();
    await worker.start();
    await registry.start();
    registry.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.2.0': { platforms: ['linux/amd64'] } },
    });
  });
  after(async () => {
    await worker.stop();
    await rp.stop();
    await registry.stop();
    rmSync(media, { recursive: true, force: true });
  });
  afterEach(() => s?.cleanup());

  function studio(key = rp.apiKey, now?: () => number): TestStudio {
    s = testStudio({
      env: { mockGeneration: false, enableCloudGpu: true, assemblyMode: 'auto' },
      secretEnv: key ? { RUNPOD_API_KEY: key } : {},
      ffmpeg: ff,
      cloud: {
        runpodBaseUrl: rp.baseUrl,
        proxyUrlTemplate: worker.template,
        sleep: async () => undefined,
        pollMs: 1,
        workerPollMs: 1,
        registryBaseUrlFor: () => registry.base,
        ...(now ? { now } : {}),
      },
    });
    s.settings.set('gpu', { ...s.settings.get('gpu'), maxHourlyRateInr: 100 });
    s.settings.set('cloud', { ...s.settings.get('cloud'), workerStartTimeoutMinutes: 2 });
    s.cloud.refresh();
    worker.media = {
      image: readFileSync(join(media, 'img.png')),
      video: readFileSync(join(media, 'clip.mp4')),
      audio: readFileSync(join(media, 'voice.wav')),
    };
    worker.stillMotion = false;
    worker.neverHealthy = false;
    worker.torchNoCuda = false;
    worker.jobPolls = 0;
    worker.submitted = [];
    worker.cancels = [];
    return s;
  }

  it('no key: RunPod step is BLOCKED and nothing else is claimed', async () => {
    studio('');
    const { record, ready } = await s.realTest.prepare();
    assert.equal(ready, false);
    assert.equal(record.steps[0]!.status, 'BLOCKED');
    assert.ok(record.steps.slice(1).every((x) => x.status === 'NOT TESTED'));
    assert.equal(rp.livePods().length, 0);
  });

  const REVIEW = [
    'Your review: the picture',
    'Your review: the motion',
    'Your review: English voice',
    'Your review: Hinglish voice',
  ];
  const byName = (steps: Array<{ n: number; name: string; status: string; detail: string }>) =>
    Object.fromEntries(steps.map((x) => [x.name, x]));

  it('nothing is rented before confirmation; then every automated step runs; two MP4s from the same clip', async () => {
    studio();
    const { record, ready } = await s.realTest.prepare();
    assert.equal(ready, true, JSON.stringify(record.steps));
    assert.deepEqual(
      record.steps.slice(0, 4).map((x) => x.status),
      ['PASS', 'PASS', 'PASS', 'RUNNING'],
    );
    assert.match(record.steps[2]!.detail, /RTX 4090/);
    assert.equal(rp.pods.size, 0, 'nothing rented before confirmation');
    const done = await s.realTest.confirm(record.id);
    assert.equal(done.status, 'success', JSON.stringify(done.steps, null, 1));
    const automated = done.steps.filter((x) => !REVIEW.includes(x.name));
    assert.equal(automated.length, 18);
    assert.ok(
      automated.every((x) => x.status === 'PASS'),
      JSON.stringify(automated, null, 1),
    );
    assert.ok(
      done.steps.filter((x) => REVIEW.includes(x.name)).every((x) => x.status === 'NOT TESTED'),
      'a person has not reviewed anything yet',
    );
    assert.equal(s.realTest.verified(done), false, 'not REAL-AI VERIFIED without the review');
    assert.equal(rp.livePods().length, 0, 'GPU terminated');
    const st = byName(done.steps);
    assert.match(st['CUDA verified by the worker']!.detail, /GB VRAM · CUDA 12\.6 · PyTorch/);
    assert.match(
      st['CUDA verified by the worker']!.detail,
      /diffusers 0\.35\.1, transformers 4\.56\.1, kokoro 0\.9\.4, misaki 0\.9\.4/,
    );
    assert.match(st['CUDA verified by the worker']!.detail, /4 libraries recorded .*model commits recorded/);
    assert.match(
      readFileSync(s.storage.localPath(`real-tests/${record.id}/model-revisions.txt`), 'utf8'),
      /black-forest-labs\/FLUX\.1-schnell@main 0123456789abcdef/,
    );
    assert.match(
      st['Image validated (decodes, size, not blank, not black)']!.detail,
      /png 640×360 .* brightness/,
    );
    assert.match(st['Motion validated (duration, frames, moves, not black)']!.detail, /72 frames · 3\.00 s/);
    // Both final files are real 1080p30 H.264/AAC MP4s built from the SAME clip.
    for (const name of ['test_english', 'test_hinglish']) {
      const out = s.storage.localPath(`real-tests/${record.id}/${name}.mp4`);
      const probe = JSON.parse(
        execFileSync(ff!.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', out]).toString(),
      ) as { streams: Array<Record<string, unknown>> };
      const v = probe.streams.find((x) => x['codec_type'] === 'video')!;
      assert.equal(v['codec_name'], 'h264', name);
      assert.equal(v['width'], 1920);
      assert.ok(
        probe.streams.some((x) => x['codec_name'] === 'aac'),
        name,
      );
    }
    assert.equal(done.output_key, `real-tests/${record.id}/test_english.mp4`);
    const sent = worker.submitted.map((x) => x.path);
    assert.equal(
      sent.filter((p) => p === '/generate/image-to-video').length,
      1,
      'ONE animation for both languages',
    );
    const i2v = worker.submitted.find((x) => x.path === '/generate/image-to-video')!;
    assert.ok(typeof i2v.body['image'] === 'string', 'the real image is what gets animated');
    const img = worker.submitted.find((x) => x.path === '/generate/image')!;
    assert.match(String(img.body['prompt']), /12-year-old futuristic explorer .* robot companion/);
    // English and Hinglish lines: Roman captions, mixed-script speech, a Hindi voice.
    const audio = worker.submitted.filter((x) => x.path === '/generate/audio');
    assert.equal(audio.length, 2, 'English + Hinglish narration');
    assert.equal(audio[0]!.body['text'], 'The signal is coming from somewhere beyond the portal.');
    const hi = audio[1]!.body;
    assert.equal(hi['language'], 'hi-Latn');
    assert.match(String(hi['voice_identity']), /hf_alpha/);
    assert.equal(String(hi['text']), 'Signal portal के दूसरी side से आ रहा है. Scanner activate करो!');
    assert.match(
      st['Real Hinglish narration (Hindi voice)']!.detail,
      /captions "Signal portal ke doosri side/,
    );

    // The person's review: only review steps, only PASS/FAIL, and VERIFIED needs all four.
    assert.throws(() => s.realTest.review(record.id, 1, 'PASS', ''), /Only the review steps/);
    for (const name of REVIEW.slice(0, 3)) s.realTest.review(record.id, st[name]!.n, 'PASS', 'looks right');
    assert.equal(s.realTest.verified(s.realTest.get(record.id)), false);
    s.realTest.review(record.id, st['Your review: Hinglish voice']!.n, 'PASS', 'natural');
    assert.equal(s.realTest.verified(s.realTest.get(record.id)), true, 'REAL-AI VERIFIED');
    s.realTest.review(record.id, st['Your review: Hinglish voice']!.n, 'FAIL', 'robotic');
    assert.equal(s.realTest.verified(s.realTest.get(record.id)), false, 'a FAIL review withdraws it');
  });

  it('a still-image camera move is not AI animation: FAIL, GPU still terminated, later steps NOT TESTED', async () => {
    studio();
    worker.stillMotion = true;
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const st = byName(done.steps);
    assert.equal(st['Real image animated (AI image-to-video)']!.status, 'FAIL');
    assert.match(st['Real image animated (AI image-to-video)']!.detail, /not AI animation/);
    assert.equal(st['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.equal(st['English MP4 built (test_english.mp4)']!.status, 'NOT TESTED');
    assert.equal(done.status, 'failed');
    assert.equal(rp.livePods().length, 0);
  });

  it('a frozen "animation" fails the motion check; the voices are still tested; GPU terminated', async () => {
    studio();
    worker.media.video = readFileSync(join(media, 'frozen.mp4'));
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const st = byName(done.steps);
    const motion = st['Motion validated (duration, frames, moves, not black)']!;
    assert.equal(motion.status, 'FAIL');
    assert.match(motion.detail, /does not move/);
    assert.equal(st['Real English narration']!.status, 'PASS');
    assert.equal(st['Real Hinglish narration (Hindi voice)']!.status, 'PASS');
    assert.equal(st['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.equal(done.status, 'failed');
    assert.equal(rp.livePods().length, 0);
  });

  it('a blank picture fails the image check before anything is animated', async () => {
    studio();
    const blank = join(media, 'blank.png');
    execFileSync(ff!.ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:size=640x360',
      '-frames:v',
      '1',
      blank,
    ]);
    worker.media.image = readFileSync(blank);
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const st = byName(done.steps);
    assert.equal(st['Image validated (decodes, size, not blank, not black)']!.status, 'FAIL');
    assert.match(st['Image validated (decodes, size, not blank, not black)']!.detail, /black/);
    assert.equal(st['Real image animated (AI image-to-video)']!.status, 'NOT TESTED');
    assert.ok(!worker.submitted.some((x) => x.path === '/generate/image-to-video'), 'nothing animated');
    assert.equal(rp.livePods().length, 0, 'GPU terminated');
  });

  it('cleanup on FAILURE: a GPU PyTorch cannot use → refused at start-up, pod terminated', async () => {
    studio();
    worker.torchNoCuda = true;
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const st = byName(done.steps);
    // The start-up readiness check already asks the worker whether PyTorch can use CUDA.
    assert.equal(st['Real GPU provisioned']!.status, 'FAIL');
    assert.match(st['Real GPU provisioned']!.detail, /PyTorch cannot use it.*GPU has been terminated/);
    assert.equal(st['CUDA verified by the worker']!.status, 'NOT TESTED');
    assert.equal(st['Real image generated (image model)']!.status, 'NOT TESTED');
    assert.equal(st['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.equal(rp.livePods().length, 0);
    assert.equal(s.gpuRepo.list()[0]!.status, 'terminated');
  });

  it('cleanup on CANCEL: a running job is cancelled on the worker and the pod terminated', async () => {
    studio();
    worker.jobPolls = 1_000_000; // the image job never finishes by itself
    const { record } = await s.realTest.prepare();
    const run = s.realTest.confirm(record.id);
    for (let i = 0; i < 400 && !worker.submitted.some((x) => x.path === '/generate/image'); i++)
      await new Promise((r) => setTimeout(r, 10));
    s.realTest.cancel(record.id);
    const done = await run;
    assert.equal(done.status, 'cancelled');
    const st = byName(done.steps);
    assert.equal(st['Real image generated (image model)']!.status, 'NOT TESTED');
    assert.equal(st['Real image generated (image model)']!.detail, 'cancelled by you');
    assert.equal(st['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.ok(worker.cancels.length >= 1, 'the remote job was cancelled');
    assert.equal(rp.livePods().length, 0, 'GPU terminated on cancellation');
  });

  it('cleanup on TIMEOUT: a worker that never starts → GPU terminated, nothing claimed', async () => {
    let t = Date.now();
    studio(rp.apiKey, () => (t += 20_000));
    worker.neverHealthy = true;
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const st = byName(done.steps);
    assert.equal(st['Real GPU provisioned']!.status, 'FAIL');
    assert.match(st['Real GPU provisioned']!.detail, /did not become healthy/);
    assert.equal(st['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.match(
      st['GPU terminated (billing stopped)']!.detail,
      /GPU\(s\) rented during start-up, all terminated \(worker_start_timeout/,
    );
    assert.ok(
      done.steps
        .slice(5)
        .filter((x) => x.name !== 'GPU terminated (billing stopped)')
        .every((x) => x.status === 'NOT TESTED'),
      JSON.stringify(done.steps, null, 1),
    );
    assert.equal(rp.livePods().length, 0, 'GPU terminated after the start-up timeout');
    assert.equal(s.gpuRepo.list()[0]!.termination_reason, 'worker_start_timeout');
  });

  it('CHARACTER CONSISTENCY: canonical reference → 12 reference-conditioned shots → contact sheet → your verdict', async () => {
    studio();
    const podsBefore = rp.pods.size;
    const { record, ready } = await s.realTest.prepare('consistency');
    assert.equal(ready, true, JSON.stringify(record.steps));
    assert.equal(record.kind, 'consistency');
    assert.match(record.steps[2]!.detail, /Models: FLUX\.1 \[schnell\]\./, 'only the image model is needed');
    assert.equal(rp.pods.size, podsBefore, 'nothing rented before confirmation');
    const done = await s.realTest.confirm(record.id);
    assert.equal(done.status, 'success', JSON.stringify(done.steps, null, 1));
    const images = worker.submitted.filter((x) => x.path === '/generate/image');
    assert.equal(images.length, 13, 'reference + 12 shots');
    assert.equal(images[0]!.body['init_image'], undefined, 'the reference is drawn from text');
    const refB64 = readFileSync(join(media, 'img.png')).toString('base64');
    for (const shot of images.slice(1)) {
      assert.equal(shot.body['init_image'], refB64, 'every shot starts from the canonical reference');
      assert.equal(shot.body['strength'], 0.8, 'the configured reference strength');
      assert.deepEqual(shot.body['reference_images'], [refB64]);
    }
    assert.match(
      String(images[12]!.body['prompt']),
      /12-year-old futuristic explorer.*cool blue night lighting/,
    );
    assert.ok(!worker.submitted.some((x) => x.path !== '/generate/image'), 'no video or voice for this test');
    assert.equal(s.realTest.consistencyImages(record.id).length, 13);
    const sheet = s.storage.localPath(done.output_key!);
    const probe = JSON.parse(
      execFileSync(ff!.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', sheet]).toString(),
    ) as { streams: Array<Record<string, unknown>> };
    assert.equal(probe.streams[0]!['width'], 5 * 384 + 4 * 8 + 2 * 8, 'a 5 × 3 contact sheet');
    assert.equal(rp.livePods().length, 0, 'GPU terminated');
    const verdict = done.steps.at(-1)!;
    assert.equal(verdict.name, 'Your review: consistency');
    assert.equal(verdict.status, 'NOT TESTED', 'the person decides');
    const r = s.realTest.review(record.id, verdict.n, 'NEEDS IMPROVEMENT', 'hair colour drifts');
    assert.equal(r.steps.at(-1)!.status, 'NEEDS IMPROVEMENT');
    assert.throws(
      () => s.realTest.review(record.id, verdict.n - 1, 'PASS', ''),
      /Only the review steps/,
      'automated steps cannot be overridden',
    );
  });

  it('the AI Engine page runs it: confirmation page first, result page with the video', async () => {
    studio();
    await s.engine.connect(rp.apiKey);
    const { handle } = createWebApp(s);
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const web = WebDriver.fromServer(server);
      const engine = await web.get('/settings/ai-engine');
      assert.match(engine.text, /Not run yet: every real-AI step is NOT TESTED/);
      const podsBefore = rp.pods.size;
      const page = await web.submit('/settings/ai-engine/real-test');
      assert.match(page.text, /Nothing has been rented yet/);
      assert.equal(rp.pods.size, podsBefore, 'nothing rented before confirmation');
      const id = /real-test\/(ctest_[a-z0-9]+)/.exec(page.url)![1]!;
      await web.submit(`/settings/ai-engine/real-test/${id}/confirm`);
      await s.realTest.running;
      const done = await web.get(`/settings/ai-engine/real-test/${id}`);
      assert.match(done.text, /AUTOMATED STEPS PASS — your review is still open/);
      assert.match(done.html, /download="test_english\.mp4"/);
      assert.match(done.html, /download="test_hinglish\.mp4"/);
      assert.match(done.html, /<audio controls src="\/media\/real-tests\//);
      // The person reviews the four outputs; REAL-AI VERIFIED appears only then.
      for (const n of [19, 20, 21, 22]) {
        const form = web
          .forms()
          .find(
            (f) =>
              f.action.endsWith('/review') &&
              f.fields.some((x) => x.name === 'step' && x.value === String(n)),
          )!;
        assert.ok(form, `review form ${n}`);
        await web.post(form.action, { step: String(n), verdict: 'PASS', note: 'checked' });
        await web.get(`/settings/ai-engine/real-test/${id}`);
      }
      assert.match(web.page!.text, /REAL-AI VERIFIED/);
      const adv = await web.get('/real-mode-test');
      assert.match(adv.text, /Earlier runs.*AUTOMATED PASS/s);
      // The consistency test from the Advanced Mode page, reviewed with the criteria checklist.
      assert.match(adv.text, /Character consistency test.*CHARACTER CONSISTENCY is NOT TESTED/s);
      const cpage = await web.submit('/real-mode-test/consistency');
      const cid = /real-test\/(ctest_[a-z0-9]+)/.exec(cpage.url)![1]!;
      await web.submit(`/settings/ai-engine/real-test/${cid}/confirm`);
      await s.realTest.running;
      const result = await web.get(`/settings/ai-engine/real-test/${cid}`);
      assert.equal((result.html.match(/<figure>/g) ?? []).length, 13, 'reference + 12 shots shown');
      assert.match(result.text, /canonical reference.*front view.*cool lighting/s);
      await web.submit(`/settings/ai-engine/real-test/${cid}/review`, {
        ok_face: 'true',
        ok_hair: 'true',
        note: 'eyes change colour',
        verdict: 'NEEDS IMPROVEMENT',
      });
      const rec = s.realTest.get(cid);
      assert.equal(rec.steps.at(-1)!.status, 'NEEDS IMPROVEMENT');
      assert.match(
        rec.steps.at(-1)!.detail,
        /eyes change colour · not consistent: eyes, clothing, colours, proportions, age, accessories/,
      );
      assert.equal(rp.livePods().length, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
