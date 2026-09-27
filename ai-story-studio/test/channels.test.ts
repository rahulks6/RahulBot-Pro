import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { nextSlotIn, publicState, type ChannelDefaults } from '../src/services/publisher.ts';
import { SeriesService } from '../src/services/series.ts';
import { createWebApp } from '../src/web/app.ts';
import { MockYoutube } from './fixtures/mock-youtube.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * Two YouTube channel profiles (English and Hinglish), each with its own Google sign-in, defaults
 * and schedule, against a local stand-in for Google. Proves the app's side: the right file, captions
 * and metadata go to the right channel, APPROVE BOTH is all-or-nothing, uploads stay private in
 * testing, and nothing is uploaded twice. It is NOT a test against the real YouTube.
 */
const ff = findFfmpeg();

describe('channel schedule slots', () => {
  const india: ChannelDefaults = {
    defaultPrivacy: 'private',
    schedule: 'daily',
    time: '18:00',
    weekday: 6,
    audience: 'ask',
    shortsGapHours: 24,
    utcOffsetMinutes: 330,
  };

  it("uses the audience's wall clock (18:00 in India = 12:30 UTC), at least 20 minutes away", () => {
    const at = (iso: string) => nextSlotIn(india, new Date(iso))!.toISOString();
    assert.equal(at('2026-03-15T09:00:00.000Z'), '2026-03-15T12:30:00.000Z');
    assert.equal(at('2026-03-15T12:15:00.000Z'), '2026-03-16T12:30:00.000Z', 'too soon → tomorrow');
    // 20:00 UTC is already 01:30 the next day in India.
    assert.equal(at('2026-03-15T20:00:00.000Z'), '2026-03-16T12:30:00.000Z');
    const weekly = nextSlotIn(
      { ...india, schedule: 'weekly', weekday: 1 },
      new Date('2026-03-15T09:00:00Z'),
    )!;
    assert.equal(weekly.toISOString(), '2026-03-16T12:30:00.000Z', 'Monday 18:00 IST');
    const short = nextSlotIn(india, new Date('2026-03-15T09:00:00Z'), 24)!;
    assert.equal(short.toISOString(), '2026-03-16T12:30:00.000Z');
    assert.equal(nextSlotIn({ ...india, schedule: 'none' }, new Date()), null);
  });
});

describe(
  'two channels: English + Hinglish (mock Google server)',
  { skip: !ff && 'FFmpeg not installed' },
  () => {
    let s: TestStudio;
    let g: MockYoutube;
    let server: Server;
    let web: WebDriver;
    const logs: string[] = [];
    let videoId = '';
    const EN = { id: 'UCenglishkids', title: 'Cosmic Kids' };
    const HI = { id: 'UChinglishkids', title: 'Cosmic Kids Hindi' };

    before(async () => {
      g = await new MockYoutube().start();
      let clockNow = (): number => Date.parse('2026-03-15T09:00:00.000Z');
      s = testStudio({
        env: { assemblyMode: 'auto', logLevel: 'debug' },
        ffmpeg: ff,
        logSinks: [{ write: (l) => logs.push(l) }],
        youtube: { endpoints: g.endpoints(), now: () => clockNow() },
      });
      clockNow = () => s.clock.now().getTime();
      g.now = clockNow;
      const { handle } = createWebApp(s);
      server = createServer((req, res) => void handle(req, res));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      web = WebDriver.fromServer(server);
    });
    after(async () => {
      await s.publisher.idle();
      await new Promise<void>((r) => server.close(() => r()));
      await g.stop();
      s.cleanup();
    });

    const hinglish = () => s.series.channelFor('hi-Latn')!;

    async function signIn(path: string): Promise<ReturnType<WebDriver['get']>> {
      const toGoogle = await fetch(`${web.base}${path}`, { redirect: 'manual' });
      assert.equal(toGoogle.status, 303);
      const back = await fetch(toGoogle.headers.get('location')!, { redirect: 'manual' });
      assert.equal(back.status, 302, await back.clone().text());
      const cb = new URL(back.headers.get('location')!);
      return web.get(cb.pathname + cb.search);
    }

    it('a bilingual episode gets four review rows, each language for its own channel', async () => {
      const svc = new SeriesService(s);
      const series = svc.create({ name: 'Cosmic Kids', starter: 'scifi', episodeMinutes: 0.4 });
      const { video } = svc.startEpisode({
        seriesId: series.id,
        idea: 'The station garden grows one glowing leaf a night and the kids learn why.',
        shortsCount: 1,
      });
      await s.orchestrator.start(video.id);
      videoId = video.id;
      assert.equal(s.videos.get(videoId).status, 'ready', s.videos.get(videoId).attention_json);
      const pubs = s.publisher.ensurePublications(videoId);
      assert.equal(pubs.length, 4, JSON.stringify(pubs.map((p) => [p.kind, p.language])));
      const english = s.series.channelFor('en')!;
      for (const p of pubs.filter((x) => x.language === 'en')) assert.equal(p.channel_profile_id, english.id);
      const hi = pubs.filter((p) => p.language === 'hi-Latn');
      assert.equal(hi.length, 2);
      for (const p of hi) {
        assert.equal(p.channel_profile_id, hinglish().id);
        assert.ok(p.localization_id);
        assert.equal(p.made_for_kids, null, 'the audience is never pre-decided');
        assert.equal(p.privacy, 'private');
      }
      assert.equal(g.uploads.size, 0, 'nothing uploaded straight after generation');
      // Idempotent: asking again adds nothing.
      assert.equal(s.publisher.ensurePublications(videoId).length, 4);
      const page = await web.get(`/publish/${videoId}`);
      assert.match(page.text, /Full episode — Hinglish/);
      assert.match(page.text, /Approve both languages/);
    });

    it('each channel signs in separately; the same channel on both profiles is flagged', async () => {
      await web.get('/publish/youtube');
      await web.submit('/publish/youtube/client', { client_id: g.clientId, client_secret: g.clientSecret });
      const page = await web.get('/publish/youtube');
      const hiConnect = web.links(/CONNECT HINGLISH/);
      assert.deepEqual(web.links(/CONNECT YOUTUBE/), ['/publish/youtube/connect']);
      assert.equal(hiConnect.length, 1, page.text);

      g.signInChannel = EN;
      const en = await signIn('/publish/youtube/connect');
      assert.match(en.notice ?? '', /YOUTUBE CONNECTED ✓ — Cosmic Kids/);
      assert.equal(s.publisher.yt.connected(), true);
      assert.equal(s.publisher.ytFor(hinglish().id).connected(), false, 'separate sign-ins');

      // Wrong account picked for the Hinglish profile: the same channel as English.
      const same = await signIn(hiConnect[0]!);
      assert.match(same.text, /SAME YouTube channel/);
      await web.post('/publish/youtube/disconnect', { channel: hinglish().id });
      assert.equal(s.publisher.ytFor(hinglish().id).connected(), false);
      assert.equal(s.publisher.yt.connected(), true, 'the English sign-in is untouched');

      g.signInChannel = HI;
      const ok = await signIn(hiConnect[0]!);
      assert.match(ok.notice ?? '', /CONNECTED ✓ — Cosmic Kids Hindi/);
      assert.doesNotMatch(ok.text, /SAME YouTube channel/);
      assert.equal(hinglish().youtube_channel_id, HI.id);
      const file = readFileSync(join(s.env.dataDir, 'secrets.json'), 'utf8');
      for (const t of [...g.issued, g.clientSecret])
        assert.ok(!file.includes(t), 'no plain-text token on disk');
    });

    it('independent schedules: English in local time, Hinglish at 18:00 India time', async () => {
      await web.get('/publish/youtube');
      await web.submit('/publish/youtube/schedule', { schedule: 'daily', time: '17:00' });
      await web.get('/publish/youtube');
      await web.submit(`/publish/youtube/channel/${hinglish().id}`, {
        schedule: 'daily',
        publish_time: '18:00',
        utc_offset_minutes: '330',
      });
      assert.equal(hinglish().utc_offset_minutes, 330);
      const bad = await web.submit(`/publish/youtube/channel/${hinglish().id}`, { publish_time: '25:00' });
      assert.match(bad.error ?? '', /HH:MM/);
    });

    it('APPROVE BOTH is all-or-nothing and needs the audience', async () => {
      await web.get(`/publish/${videoId}`);
      const noAudience = await web.submit(`/publish/${videoId}/approve-many`, { then: 'schedule' });
      assert.match(noAudience.error ?? '', /Choose the audience first/);
      assert.ok(
        s.videos.publications(videoId).every((p) => p.status === 'ready_for_review'),
        'nothing approved when one item is not ready',
      );
      assert.equal(g.uploads.size, 0);
    });

    it('APPROVE BOTH & SCHEDULE: each version goes to its own channel with its own files and time', async () => {
      await web.get(`/publish/${videoId}`);
      const res = await web.submit(`/publish/${videoId}/approve-many`, {
        audience: 'kids',
        scope: 'episodes',
        then: 'schedule',
      });
      assert.match(res.notice ?? '', /Approved 2 item/);
      await s.publisher.idle();
      const pubs = s.videos.publications(videoId);
      const en = pubs.find((p) => p.kind === 'episode' && p.language === 'en')!;
      const hi = pubs.find((p) => p.kind === 'episode' && p.language === 'hi-Latn')!;
      assert.equal(publicState(en), 'SCHEDULED', JSON.stringify(en));
      assert.equal(publicState(hi), 'SCHEDULED', JSON.stringify(hi));
      assert.ok(
        pubs.filter((p) => p.kind === 'short').every((p) => p.status === 'ready_for_review'),
        'Shorts wait for their own approval',
      );

      const ytEn = g.videos.get(en.youtube_video_id!)!;
      const ytHi = g.videos.get(hi.youtube_video_id!)!;
      assert.equal(ytEn.channel, EN.id, 'English to the English channel');
      assert.equal(ytHi.channel, HI.id, 'Hinglish to the Hinglish channel');
      for (const v of [ytEn, ytHi]) {
        assert.equal(v.meta.status.privacyStatus, 'private', 'scheduled = private until the time');
        assert.equal(v.meta.status.selfDeclaredMadeForKids, true);
        assert.equal(v.meta.status.containsSyntheticMedia, true);
      }
      // Independent times: 17:00 on this computer vs 18:00 in India.
      const enSlot = new Date(ytEn.meta.status.publishAt!);
      assert.equal(enSlot.getHours(), 17);
      assert.equal(ytHi.meta.status.publishAt, '2026-03-15T12:30:00.000Z');

      // The Hinglish upload is the Hinglish file, with Roman-script Hinglish captions and its own title.
      const loc = s.series.localization(hi.localization_id!);
      assert.equal(ytHi.bytes, readFileSync(s.storage.localPath(loc.video_key!)).length);
      const enExp = s.reports.getExport(s.videos.get(videoId).episode_export_id!);
      assert.equal(
        ytEn.bytes,
        readFileSync(s.storage.localPath(s.assets.get(enExp.master_asset_id!).storage_key)).length,
      );
      assert.notEqual(ytEn.bytes, ytHi.bytes);
      assert.equal(ytHi.captions[0]!.language, 'hi-Latn');
      assert.equal(ytEn.captions[0]!.language, 'en');
      assert.doesNotMatch(ytHi.captions[0]!.text, /[ऀ-ॿ]/, 'Hinglish captions are Roman script');
      const hiMeta = JSON.parse(loc.metadata_json) as { title: string };
      assert.equal(ytHi.meta.snippet['title'], hiMeta.title);
      assert.notEqual(ytHi.meta.snippet['title'], ytEn.meta.snippet['title']);
      assert.equal(ytHi.meta.snippet['defaultLanguage'], 'hi');
      assert.ok(ytHi.thumbnail, 'Hinglish thumbnail set');
    });

    it('never uploads twice: approving again is refused and no new upload starts', async () => {
      const uploads = g.uploads.size;
      const en = s.videos.publications(videoId).find((p) => p.kind === 'episode' && p.language === 'en')!;
      assert.throws(() => s.publisher.approve(en.id, 'upload'), /already approved/);
      assert.throws(() => s.publisher.approveMany([en.id], 'schedule'), /already approved/);
      await s.publisher.idle();
      assert.equal(g.uploads.size, uploads);
    });

    it('SAFE PRIVATE TEST per channel: private, on that channel, kept apart from the other', async () => {
      await web.get('/publish/youtube');
      // Two channels are connected, so there are two test buttons; press the Hinglish one.
      const res = await web.post('/publish/youtube/test', { channel: hinglish().id });
      assert.match(res.notice ?? '', /Private test uploaded \(private/);
      const t = s.publisher.lastPrivateTest(hinglish().id);
      assert.ok(t, 'the Hinglish test ran');
      assert.equal(t.privacy, 'private');
      assert.equal(g.videos.get(t.videoId)!.channel, HI.id);
      assert.equal(s.publisher.lastPrivateTest(), null, 'the English channel has no test yet');
      await s.publisher.deletePrivateTest(hinglish().id);
      assert.equal(g.videos.has(t.videoId), false);
    });

    it('no token or client secret reaches the log', () => {
      const all = logs.join('\n');
      assert.match(all, /publication approved/);
      for (const t of [...g.issued, g.clientSecret]) assert.ok(!all.includes(t));
    });
  },
);
