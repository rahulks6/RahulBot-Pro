import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * The Series screens through HTTP like a browser (developer test mode: placeholder AI, real
 * FFmpeg): new series, bible, characters with Hinglish style, PLAN SEASON, making a planned
 * episode, the episode review screen with both language versions, canon approval, Home.
 */
const ff = findFfmpeg();

describe('Series screens (Simple Mode)', { skip: !ff && 'FFmpeg not installed' }, () => {
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;
  let seriesId = '';
  let episodeId = '';

  before(async () => {
    s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
    const { handle } = createWebApp(s);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  });
  after(async () => {
    await s.publisher.idle();
    await new Promise<void>((r) => server.close(() => r()));
    s.cleanup();
  });

  async function waitForVideo(videoId: string): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if (!['generating', 'queued'].includes(s.videos.get(videoId).status)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('the video did not finish');
  }

  it('SERIES is in the Simple Mode menu; a new series starts with Season 1 and the starter bible', async () => {
    const home = await web.get('/');
    assert.deepEqual(web.links(/^Series$/), ['/series']);
    assert.doesNotMatch(home.text, /Continue Series/, 'no series yet');
    await web.get('/series');
    const bad = await web.submit('/series', { name: 'X' });
    assert.match(bad.error ?? '', /name/);
    await web.get('/series');
    const page = await web.submit('/series', { name: 'Cosmic Kids', minutes: '0.4' });
    assert.match(page.notice ?? '', /Series "Cosmic Kids" created with Season 1/);
    seriesId = new URL(page.url, web.base).pathname.split('/').pop()!;
    assert.match(page.text, /Generate next episode/);
    assert.match(page.text, /Season 1/);
    assert.match(page.text, /Series Bible/);
    assert.match(page.text, /AGE-SAFETY RULES/);
    assert.equal(s.series.localizations(s.series.get(seriesId)).join(), 'hi-Latn');
  });

  it('the bible and the season plan are edited and kept', async () => {
    await web.get(`/series/${seriesId}`);
    const page = await web.submit(`/series/${seriesId}/bible`, {
      bible_PREMISE: 'Two kids and a helper robot solve science mysteries on a space station.',
    });
    assert.match(page.notice ?? '', /Series Bible saved/);
    const bible = s.series.bible(s.series.get(seriesId));
    assert.equal(bible.PREMISE, 'Two kids and a helper robot solve science mysteries on a space station.');
    assert.ok(bible['AGE-SAFETY RULES'], 'untouched sections kept');
    const season = s.series.seasons(seriesId)[0]!;
    await web.submit(`/series/${seriesId}/seasons/${season.id}`, {
      main_mystery: 'Who sends the signals near the old portal?',
    });
    assert.equal(s.series.season(season.id).main_mystery, 'Who sends the signals near the old portal?');
  });

  it('recurring characters: original only, Hinglish style and a Devanagari pronunciation', async () => {
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/${seriesId}/characters`, {
      name: 'Aira',
      role: 'curious inventor',
      appearance: 'girl, short black hair, teal jacket, orange goggles',
    });
    const aira = s.characters.list(s.series.get(seriesId).project_id).find((c) => c.name === 'Aira')!;
    assert.ok(aira);
    await web.get(`/series/${seriesId}`);
    const bad = await web.submit(`/series/${seriesId}/characters/${aira.id}`, { pronunciation: 'Aira' });
    assert.match(bad.error ?? '', /Devanagari/);
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/${seriesId}/characters/${aira.id}`, {
      pronunciation: 'आइरा',
      english_share: '0.55',
      speech_style: 'fast, excited, science words',
    });
    const prof = s.series.characterProfile(aira.id)!;
    assert.equal(JSON.parse(prof.pronunciation_json).Aira, 'आइरा');
    assert.equal(s.series.hinglishStyle(prof).english_share, 0.55);
    assert.equal(JSON.parse(prof.profile_json).speech_style, 'fast, excited, science words');
  });

  it('PLAN SEASON saves new ideas as PLANNED (nothing is made); a repeat is skipped', async () => {
    const season = s.series.seasons(seriesId)[0]!;
    await web.get(`/series/${seriesId}`);
    const page = await web.submit(`/series/${seriesId}/seasons/${season.id}/plan`, { count: '3' });
    assert.match(page.notice ?? '', /3 episode idea\(s\) planned/);
    const planned = s.series.episodes({ seasonId: season.id });
    assert.equal(planned.length, 3);
    assert.ok(planned.every((e) => e.production_status === 'planned' && !e.video_id));
    assert.equal(s.videos.list({}).length, 0, 'planning makes no video');
    assert.match(page.text, /MAKE THIS EPISODE/);
    // Planning the same ideas again: the mock repeats themes after 8 → the first 5 new ones are new.
    await web.get(`/series/${seriesId}`);
    const again = await web.submit(`/series/${seriesId}/seasons/${season.id}/plan`, { count: '8' });
    assert.match(again.notice ?? '', /skipped as repeats/);
    // Remove one planned idea.
    const last = s.series.episodes({ seasonId: season.id }).at(-1)!;
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/episodes/${last.id}/remove`);
    assert.throws(() => s.series.episode(last.id));
  });

  it('GENERATE EPISODE with no idea makes the next planned episode, English + Hinglish', async () => {
    await web.get(`/series/${seriesId}`);
    const first = s.series.episodes({ seriesId })[0]!;
    const page = await web.submit(`/series/${seriesId}/episodes`, { shorts: '1', minutes: '0.4' });
    assert.match(page.notice ?? '', /Episode 1 started/);
    episodeId = first.id;
    const e = s.series.episode(episodeId);
    assert.ok(e.video_id);
    assert.equal(s.videos.get(e.video_id).localizations_json, '["hi-Latn"]');
    await waitForVideo(e.video_id);
    const v = s.videos.get(e.video_id);
    assert.equal(v.status, 'ready', v.attention_json);
    assert.equal(s.series.episode(episodeId).production_status, 'ready_for_review');
  });

  it('the episode review screen shows both versions, the checks, and the proposed canon', async () => {
    const page = await web.get(`/series/episodes/${episodeId}`);
    assert.match(page.text, /Watch both versions/);
    assert.match(page.text, /English/);
    assert.match(page.text, /Hinglish/);
    assert.ok((page.html.match(/<video/g) ?? []).length >= 4, 'EN + HI episode and Shorts');
    assert.match(page.text, /Continuity/);
    assert.match(page.text, /line\(s\) · \d+ rewritten shorter/);
    assert.ok(page.html.includes('download="S01E01_EPISODE_EN.mp4"'), 'English download');
    assert.ok(page.html.includes('download="S01E01_EPISODE_HINGLISH.mp4"'), 'Hinglish download');
    assert.ok(page.html.includes('download="S01E01_EPISODE_HINGLISH.srt"'), 'Hinglish captions');
    assert.match(page.text, /APPROVE EPISODE/);
    assert.match(page.text, /Review and publish/);
    const proposed = s.series.facts(seriesId, { status: ['proposed'], episodeId });
    assert.ok(proposed.length > 0);
    const res = await web.submit(`/series/episodes/${episodeId}/approve`);
    assert.match(res.notice ?? '', /facts are now canon/);
    assert.equal(s.series.facts(seriesId, { status: ['proposed'], episodeId }).length, 0);
    assert.equal(s.series.episode(episodeId).production_status, 'approved');
    assert.equal(
      s.videos
        .publications(s.series.episode(episodeId).video_id!)
        .filter((p) => p.status !== 'ready_for_review').length,
      0,
      'approving the story uploads nothing',
    );
  });

  it('canon by hand, retire, add a season; Home shows Continue Series', async () => {
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/${seriesId}/facts`, {
      kind: 'object_state',
      subject: 'Old portal',
      fact: 'The old portal is sealed.',
    });
    const fact = s.series.facts(seriesId).find((f) => f.fact === 'The old portal is sealed.')!;
    assert.equal(fact.status, 'canon');
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/${seriesId}/facts/${fact.id}/retire`);
    assert.ok(!s.series.facts(seriesId).some((f) => f.id === fact.id));
    await web.get(`/series/${seriesId}`);
    await web.submit(`/series/${seriesId}/seasons`);
    const seasons = s.series.seasons(seriesId);
    assert.equal(seasons.length, 2);
    assert.equal(seasons[0]!.status, 'complete');
    assert.equal(seasons[1]!.status, 'in_production');
    const home = await web.get('/');
    assert.match(home.text, /Continue Series.*Cosmic Kids.*Season 2, next episode 1/s);
  });
});
