import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { createWebApp } from '../src/web/app.ts';
import { testStudio, type TestStudio } from './helpers.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/** CREATE → video page → Video Ready → scene editor → rebuild, through the web forms. */
const ff = findFfmpeg();

describe('Create flow (Simple Mode, developer test mode)', { skip: !ff && 'FFmpeg not installed' }, () => {
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;
  let videoId = '';
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

  it('the Create page: one prompt, lengths, style cards (no model names), outputs', async () => {
    const p = await web.get('/create');
    assert.equal(p.status, 200);
    assert.match(p.text, /What story would you like to create\?/);
    for (const t of [
      'SHORT',
      'STANDARD',
      'FULL EPISODE',
      'CUSTOM',
      '3D Kids Animation',
      'Full Episode',
      'Shorts',
    ])
      assert.ok(p.text.includes(t), t);
    assert.ok(!/FLUX|Wan 2|Kokoro|Qwen|SDXL/i.test(p.text), 'no model names in Simple Mode');
    assert.match(p.html, /value="3d_kids"\s+checked/);
  });

  it('GENERATE makes the whole video in the background; the page shows the stages, then Video Ready', async () => {
    await web.get('/create');
    const started = await web.submit('/create', {
      idea: 'Milo the fox cub finds a shiny star that fell into the forest and helps it back to the sky.',
      length: 'custom',
      customMinutes: '0.3',
    });
    assert.match(started.notice ?? '', /Started/);
    videoId = /\/videos\/(vid_[a-z0-9]+)/.exec(started.url)![1]!;
    await s.orchestrator.start(videoId).catch(() => undefined);
    const page = await web.get(`/videos/${videoId}`);
    assert.match(page.text, /Video Ready/, page.text.slice(0, 600));
    assert.match(page.text, /PLACEHOLDERS \(developer test mode\) — not real AI/);
    assert.match(page.html, /<video\s+class="player"\s+controls/);
    for (const stage of [
      'Writing the story',
      'Designing the characters',
      'Drawing the scenes',
      'Animating',
      'Voices, music and the final video',
      'Quality check',
    ])
      assert.ok(page.text.includes(stage), stage);
    const home = await web.get('/');
    assert.match(home.text, /Recent Videos/);
    assert.ok(home.html.includes(`/videos/${videoId}`));
    const mine = await web.get('/videos?show=ready');
    assert.ok(mine.html.includes(`/videos/${videoId}`));
  });

  it('the scene editor: change words, redraw a picture, then REBUILD makes only that again', async () => {
    const v = s.videos.get(videoId);
    const edit = await web.get(`/videos/${videoId}/edit`);
    assert.match(edit.text, /REBUILD VIDEO/);
    assert.match(edit.text, /OPEN ADVANCED EDITOR/);
    const shots = s.stories.listStoryShots(v.story_id!);
    const withWords = s.stories
      .tree(v.story_id!)
      .scenes.flatMap((sc) => sc.shots)
      .find((x) => x.dialogue.length)!;
    const line = withWords.dialogue[0]!;
    const saved = await web.submit(`/videos/${videoId}/shots/${withWords.shot.id}/text`, {
      [`d_${line.id}`]: 'A brand new line!',
    });
    assert.match(saved.notice ?? '', /Saved/);
    assert.equal(s.stories.getDialogue(line.id).text, 'A brand new line!');
    await web.get(`/videos/${videoId}/edit`);
    const redraw = await web.submit(`/videos/${videoId}/shots/${shots[0]!.id}/redraw`);
    assert.match(redraw.notice ?? '', /drawn again/);
    assert.equal(s.videos.get(videoId).status, 'draft');
    const imagesBefore = s.jobs.attemptsForShot(shots[1]!.id, 'image').length;
    await web.get(`/videos/${videoId}/edit`);
    await web.submit(`/videos/${videoId}/rebuild`);
    await s.orchestrator.start(videoId).catch(() => undefined);
    const now = s.videos.get(videoId);
    assert.equal(now.status, 'ready', JSON.stringify(s.videos.stages(now)));
    assert.ok(s.stories.getShot(shots[0]!.id).approved_image_asset_id, 'the redrawn picture was made');
    assert.equal(
      s.jobs.attemptsForShot(shots[1]!.id, 'image').length,
      imagesBefore,
      'other pictures untouched',
    );
  });

  it('refuses an empty idea and no outputs', async () => {
    await web.get('/create');
    const empty = await web.submit('/create', { idea: 'hi' });
    assert.match(empty.error ?? '', /Describe the story idea/);
    await web.get('/create');
    const none = await web.submit('/create', {
      idea: 'A long enough idea about a kite.',
      episode: 'false',
      shorts: 'false',
    });
    assert.match(none.error ?? '', /at least one output/);
  });
});
