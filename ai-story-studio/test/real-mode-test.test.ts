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
      tags: { '1.1.0': { platforms: ['linux/amd64'] } },
    });
  });
  after(async () => {
    await worker.stop();
    await rp.stop();
    await registry.stop();
    rmSync(media, { recursive: true, force: true });
  });
  afterEach(() => s?.cleanup());

  function studio(key = rp.apiKey): TestStudio {
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

  it('nothing is rented before confirmation; then every step runs and the MP4 is checked', async () => {
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
    assert.ok(done.steps.every((x) => x.status === 'PASS'));
    assert.ok(done.output_key);
    assert.equal(rp.livePods().length, 0, 'GPU terminated');
    // The final file is a real 1080p30 H.264/AAC MP4.
    const out = s.storage.localPath(done.output_key!);
    const probe = JSON.parse(
      execFileSync(ff!.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', out]).toString(),
    ) as { streams: Array<Record<string, unknown>> };
    const v = probe.streams.find((x) => x['codec_type'] === 'video')!;
    assert.equal(v['codec_name'], 'h264');
    assert.equal(v['width'], 1920);
    assert.ok(probe.streams.some((x) => x['codec_name'] === 'aac'));
    const sent = worker.submitted.map((x) => x.path);
    assert.ok(
      ['/generate/image', '/generate/image-to-video', '/generate/audio'].every((p) => sent.includes(p)),
    );
    const i2v = worker.submitted.find((x) => x.path === '/generate/image-to-video')!;
    assert.ok(typeof i2v.body['image'] === 'string', 'the real image is what gets animated');
  });

  it('a still-image camera move is not AI animation: FAIL, GPU still terminated, later steps NOT TESTED', async () => {
    studio();
    worker.stillMotion = true;
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const byName = Object.fromEntries(done.steps.map((x) => [x.name, x]));
    assert.equal(byName['Real image animated (AI image-to-video)']!.status, 'FAIL');
    assert.match(byName['Real image animated (AI image-to-video)']!.detail, /not AI animation/);
    assert.equal(byName['GPU terminated (billing stopped)']!.status, 'PASS');
    assert.equal(byName['Audio + video combined']!.status, 'NOT TESTED');
    assert.equal(done.status, 'failed');
    assert.equal(rp.livePods().length, 0);
  });

  it('a frozen "animation" fails the playback check', async () => {
    studio();
    worker.media.video = readFileSync(join(media, 'frozen.mp4'));
    const { record } = await s.realTest.prepare();
    const done = await s.realTest.confirm(record.id);
    const play = done.steps.find((x) => x.name.startsWith('MP4 plays'))!;
    assert.equal(play.status, 'FAIL');
    assert.match(play.detail, /does not move/);
    assert.equal(done.status, 'failed');
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
      assert.match(done.text, /PASS — milestone 1 reached/);
      assert.match(done.html, /<video class="player" controls src="\/media\/real-tests\//);
      assert.equal(rp.livePods().length, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
