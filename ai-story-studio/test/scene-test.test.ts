import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * The 20–30 s bilingual scene test (Advanced → Real Mode Test) in DEVELOPER TEST MODE (placeholder
 * AI, real FFmpeg): one visual production, English + Hinglish finals that share the SAME pictures and
 * clips, kept in a technical-test project (never series canon). Proves the pipeline, not real AI.
 */
const ff = findFfmpeg();

describe('bilingual scene test (developer test mode)', { skip: !ff && 'FFmpeg not installed' }, () => {
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;

  before(async () => {
    s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
    const { handle } = createWebApp(s);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    s.cleanup();
  });

  it('one visual production → English and Hinglish MP4s from the same clips, outside any series', async () => {
    const page = await web.get('/real-mode-test');
    assert.match(page.text, /Bilingual scene test \(20–30 s\)/);
    assert.match(page.text, /20–30 SECOND BILINGUAL SCENE is NOT TESTED/);
    const started = await web.post('/real-mode-test/scene', {});
    assert.match(started.notice ?? '', /Bilingual scene test started/);
    const videoId = new URL(started.url, web.base).pathname.split('/').pop()!;
    for (let i = 0; i < 600 && s.videos.get(videoId).status === 'generating'; i++)
      await new Promise((r) => setTimeout(r, 200));
    const v = s.videos.get(videoId);
    assert.equal(v.status, 'ready', v.attention_json);
    assert.equal(s.projects.get(v.project_id).name, 'Technical tests (not series canon)');
    assert.equal(s.series.list().length, 0, 'no series, no canon touched');
    assert.ok(Math.abs(v.target_seconds - 27) <= 3, `about 20–30 s (${v.target_seconds} s)`);

    const loc = s.series.videoLocalizations(videoId).find((l) => !l.short_id)!;
    assert.ok(loc && ['ready', 'needs_attention'].includes(loc.status), JSON.stringify(loc));
    const en = s.stories.listStoryShots(v.story_id!);
    const hi = s.stories.listStoryShots(loc.story_id!);
    assert.ok(en.length >= 3, 'multiple shots');
    assert.deepEqual(
      hi.map((x) => [x.approved_image_asset_id, x.approved_video_asset_id]),
      en.map((x) => [x.approved_image_asset_id, x.approved_video_asset_id]),
      'the Hinglish version uses the SAME pictures and clips (no second visual generation)',
    );
    const probe = (key: string) =>
      JSON.parse(
        execFileSync(ff!.ffprobe, [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          s.storage.localPath(key),
        ]).toString(),
      ) as { streams: Array<Record<string, unknown>>; format: { duration: string } };
    const enKey = s.assets.get(s.reports.getExport(v.episode_export_id!).master_asset_id!).storage_key;
    for (const key of [enKey, loc.video_key!]) {
      const p = probe(key);
      const vs = p.streams.find((x) => x['codec_type'] === 'video')!;
      assert.equal(vs['codec_name'], 'h264');
      assert.equal(vs['width'], 1920);
      assert.equal(vs['height'], 1080);
      assert.ok(p.streams.some((x) => x['codec_name'] === 'aac'));
      const d = Number(p.format.duration);
      assert.ok(d >= 15 && d <= 40, `${key}: ${d} s`);
    }
    assert.notEqual(enKey, loc.video_key, 'two separate files');
    const again = await web.get('/real-mode-test');
    assert.match(again.text, /Last run .*READY/);
  });
});
