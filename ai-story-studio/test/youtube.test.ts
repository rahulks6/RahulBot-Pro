import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import type { Publication } from '../src/repositories/videos.ts';
import { mapStatus, nextSlot, publicState } from '../src/services/publisher.ts';
import { youtubeError } from '../src/services/youtube.ts';
import { createWebApp } from '../src/web/app.ts';
import { MockYoutube } from './fixtures/mock-youtube.ts';
import { WebDriver } from './fixtures/web-driver.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * YouTube publishing against a local stand-in for Google (OAuth + Data API v3): sign-in with PKCE,
 * encrypted tokens, the approval gate, resumable upload with an interruption, captions,
 * thumbnails, scheduling, the API-restriction mapping, the private test, restart, disconnect.
 * This proves the app's side of the protocol; it is NOT a test against the real YouTube.
 */
const ff = findFfmpeg();

describe('status mapping and schedule slots', () => {
  const pub = (over: Partial<Publication>): Publication =>
    ({ privacy: 'private', publish_at: null, status: 'uploading', ...over }) as Publication;
  const st = (privacyStatus: string, extra: Record<string, string | null> = {}) => ({
    id: 'v',
    uploadStatus: 'uploaded',
    privacyStatus,
    publishAt: null,
    failureReason: null,
    rejectionReason: null,
    ...extra,
  });

  it('recognises every outcome, including the API restriction', () => {
    assert.equal(mapStatus(pub({}), st('private')).status, 'uploaded');
    assert.equal(mapStatus(pub({ privacy: 'public' }), st('public')).status, 'published');
    assert.equal(mapStatus(pub({ privacy: 'public' }), st('private')).status, 'blocked');
    assert.equal(mapStatus(pub({ privacy: 'unlisted' }), st('private')).status, 'blocked');
    const later = '2026-04-01T17:00:00.000Z';
    assert.equal(
      mapStatus(pub({ publish_at: later }), st('private', { publishAt: later })).status,
      'scheduled',
    );
    assert.equal(
      mapStatus(pub({ publish_at: later }), st('private')).status,
      'blocked',
      'publish time dropped',
    );
    assert.equal(mapStatus(pub({ publish_at: later }), st('public')).status, 'published');
    const rej = mapStatus(pub({}), st('private', { uploadStatus: 'rejected', rejectionReason: 'duplicate' }));
    assert.equal(rej.status, 'failed');
    assert.match(rej.error_message!, /duplicate/);
    assert.equal(publicState({ status: 'uploaded', remote_status: 'private' } as Publication), 'PRIVATE');
    assert.equal(publicState({ status: 'blocked' } as Publication), 'BLOCKED BY API RESTRICTION');
  });

  it('explains YouTube errors in plain words', () => {
    const q = JSON.stringify({ error: { message: 'x', errors: [{ reason: 'quotaExceeded' }] } });
    assert.equal(youtubeError(403, q).code, 'YOUTUBE_QUOTA_EXCEEDED');
    assert.equal(youtubeError(400, JSON.stringify({ error: 'invalid_grant' })).code, 'YOUTUBE_AUTH_FAILED');
    const lim = JSON.stringify({ error: { errors: [{ reason: 'uploadLimitExceeded' }] } });
    assert.equal(youtubeError(400, lim).code, 'YOUTUBE_BLOCKED');
    assert.equal(youtubeError(500, 'oops').code, 'YOUTUBE_UPLOAD_FAILED');
  });

  it('next slot follows the daily/weekly template, never less than 20 minutes away', () => {
    const now = new Date(2026, 2, 15, 16, 50); // local time, a Sunday
    assert.equal(nextSlot({ schedule: 'none', time: '17:00', weekday: 6 }, now), null);
    const daily = nextSlot({ schedule: 'daily', time: '17:00', weekday: 6 }, now)!;
    assert.equal(daily.getDate(), 16, 'too soon today → tomorrow');
    assert.equal(daily.getHours(), 17);
    const weekly = nextSlot({ schedule: 'weekly', time: '09:30', weekday: 3 }, now)!;
    assert.equal(weekly.getDay(), 3);
    assert.equal(weekly.getMinutes(), 30);
    const short = nextSlot({ schedule: 'daily', time: '17:00', weekday: 6 }, now, 24)!;
    assert.equal(short.getTime() - daily.getTime(), 24 * 3_600_000);
  });
});

describe('YouTube publishing (mock Google server)', { skip: !ff && 'FFmpeg not installed' }, () => {
  let s: TestStudio;
  let g: MockYoutube;
  let server: Server;
  let web: WebDriver;
  const logs: string[] = [];
  let videoId = '';
  let episode: Publication;
  let short: Publication;

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

  /** Walk the consent flow like a browser: app → Google → back to the app's loopback callback. */
  async function signIn(): Promise<ReturnType<WebDriver['get']>> {
    const toGoogle = await fetch(`${web.base}/publish/youtube/connect`, { redirect: 'manual' });
    assert.equal(toGoogle.status, 303);
    const back = await fetch(toGoogle.headers.get('location')!, { redirect: 'manual' });
    assert.equal(back.status, 302, await back.clone().text());
    const cb = new URL(back.headers.get('location')!);
    return web.get(cb.pathname + cb.search);
  }

  it('connect: own OAuth client, PKCE S256, offline access, loopback redirect', async () => {
    let page = await web.get('/publish/youtube');
    assert.match(page.text, /Not connected/);
    assert.match(page.text, /Your Google password is never entered here/);
    page = await web.submit('/publish/youtube/client', { client_id: 'not-a-client', client_secret: 'x' });
    assert.match(page.error ?? '', /apps\.googleusercontent\.com/);
    page = await web.submit('/publish/youtube/client', {
      client_id: g.clientId,
      client_secret: g.clientSecret,
    });
    assert.match(page.notice ?? '', /OAuth client saved/);
    assert.ok(!page.html.includes(g.clientSecret), 'the client secret is never shown again');
    assert.deepEqual(web.links(/CONNECT YOUTUBE/), ['/publish/youtube/connect']);

    const toGoogle = await fetch(`${web.base}/publish/youtube/connect`, { redirect: 'manual' });
    const auth = new URL(toGoogle.headers.get('location')!);
    assert.equal(auth.origin + auth.pathname, g.endpoints().auth);
    const q = auth.searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('access_type'), 'offline');
    assert.match(q.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/publish\/youtube\/callback$/);
    assert.deepEqual(q.get('scope')!.split(' ').sort(), [
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube.upload',
    ]);
    assert.ok(!auth.toString().includes(g.clientSecret), 'the secret never goes to the browser');

    // A callback with a state this app did not start is refused.
    const forged = await web.get('/publish/youtube/callback?state=forged&code=4/abc');
    assert.match(forged.error ?? '', /not started here/);
    assert.equal(s.publisher.yt.connected(), false);

    // Unticking a permission on the consent screen is reported, not half-connected.
    g.grantScopes = ['https://www.googleapis.com/auth/youtube.upload'];
    const partial = await signIn();
    assert.match(partial.error ?? '', /permissions were not granted/);
    assert.equal(s.publisher.yt.connected(), false);

    const ok = await signIn();
    assert.match(ok.notice ?? '', /YOUTUBE CONNECTED ✓ — Milo Stories/);
    assert.match(ok.text, /YOUTUBE CONNECTED ✓ — Milo Stories/);
    assert.equal(s.publisher.yt.connected(), true);
  });

  it('tokens and the client secret are stored encrypted and never shown', () => {
    const file = readFileSync(join(s.env.dataDir, 'secrets.json'), 'utf8');
    for (const t of [...g.issued, g.clientSecret])
      assert.ok(!file.includes(t), 'no plain-text secret on disk');
    assert.ok(!web.page!.html.includes(g.issued[0]!));
  });

  it('a finished video waits in READY FOR REVIEW; nothing is uploaded without approval', async () => {
    const v = s.orchestrator.create({
      idea: 'Milo the fox cub helps a lost baby turtle find its way home to the river.',
      length: 'custom',
      customMinutes: 0.8,
      styleId: '3d_kids',
      makeEpisode: true,
      makeShorts: true,
      shortsCount: 1,
      language: 'en',
      narrator: 'female',
      musicMood: 'auto',
      reviewPlan: false,
    });
    await s.orchestrator.start(v.id);
    videoId = v.id;
    assert.equal(s.videos.get(videoId).status, 'ready');
    const pubs = s.videos.publications(videoId);
    episode = pubs.find((p) => p.kind === 'episode')!;
    short = pubs.find((p) => p.kind === 'short')!;
    assert.ok(episode && short, JSON.stringify(pubs));
    assert.ok(pubs.every((p) => p.status === 'ready_for_review'));
    assert.ok(
      pubs.every((p) => p.made_for_kids === null),
      'the audience is never pre-decided',
    );
    assert.ok(
      pubs.every((p) => p.synthetic_media === 1),
      'AI content is disclosed by default',
    );
    assert.equal(g.uploads.size, 0, 'no upload straight after generation');
    const dash = await web.get('/publish');
    assert.match(dash.text, /Ready for Review.*READY FOR REVIEW/);
    assert.ok(dash.html.includes(`/publish/${videoId}`));
  });

  it('APPROVE without choosing the audience is refused', async () => {
    const page = await web.get(`/publish/${videoId}`);
    assert.match(page.text, /Audience \(required by YouTube\)/);
    assert.match(page.text, /AI-generated \(synthetic\) content/);
    const f = web.form(`/publish/item/${episode.id}/save`);
    assert.ok(
      f.fields.filter((x) => x.name === 'audience').every((x) => x.value === ''),
      'no audience radio pre-checked',
    );
    const res = await web.submit(`/publish/item/${episode.id}/save`, { then: 'upload' });
    assert.match(res.error ?? '', /Choose the audience first/);
    assert.equal(s.videos.getPublication(episode.id).status, 'ready_for_review');
    assert.equal(g.uploads.size, 0);
  });

  it('APPROVE & UPLOAD: resumable upload survives a dropped connection and continues on RETRY', async () => {
    await web.get(`/publish/${videoId}`);
    g.dropNextChunkAfter = 4096;
    const res = await web.submit(`/publish/item/${episode.id}/save`, {
      title: 'Milo and the Lost Turtle',
      audience: 'kids',
      privacy: 'private',
      then: 'upload',
    });
    assert.match(res.notice ?? '', /Approved: uploading now/);
    await s.publisher.idle();
    let p = s.videos.getPublication(episode.id);
    assert.equal(p.status, 'failed', JSON.stringify(p));
    assert.match(p.error_message!, /interrupted/);
    assert.equal(g.uploads.size, 1);
    const session = [...g.uploads.values()][0]!;
    assert.equal(session.data.length, 4096, 'YouTube kept the first part');

    await web.get(`/publish/${videoId}`);
    await web.submit(`/publish/item/${episode.id}/retry`);
    await s.publisher.idle();
    p = s.videos.getPublication(episode.id);
    assert.equal(publicState(p), 'PRIVATE', JSON.stringify(p));
    assert.equal(g.uploads.size, 1, 'continued the same session, not a new upload');
    const yt = g.videos.get(p.youtube_video_id!)!;
    const exp = s.reports.getExport(s.videos.get(videoId).episode_export_id!);
    const size = readFileSync(s.storage.localPath(s.assets.get(exp.master_asset_id!).storage_key)).length;
    assert.equal(yt.bytes, size, 'every byte arrived exactly once');
    assert.equal(yt.meta.snippet['title'], 'Milo and the Lost Turtle');
    assert.equal(yt.meta.status.privacyStatus, 'private');
    assert.equal(yt.meta.status.selfDeclaredMadeForKids, true);
    assert.equal(yt.meta.status.containsSyntheticMedia, true);
    assert.equal(yt.captions.length, 1);
    assert.match(yt.captions[0]!.text, /^1\n00:00:\d\d,\d{3} --> /);
    assert.equal(p.captions_status, 'uploaded');
    assert.equal(p.thumbnail_status, 'uploaded');
    assert.ok(yt.thumbnail && yt.thumbnail.bytes > 1000);
    assert.equal(p.youtube_url, `https://youtu.be/${p.youtube_video_id}`);
    const page = await web.get('/publish');
    assert.match(page.text, /Published and uploaded.*PRIVATE.*Milo and the Lost Turtle/);
  });

  it('APPROVE & SCHEDULE: uploaded private with the publish time → SCHEDULED → PUBLISHED', async () => {
    await web.get(`/publish/${videoId}`);
    const local = (d: Date) =>
      new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const soon = new Date(s.clock.now().getTime() + 5 * 60_000);
    const early = await web.submit(`/publish/item/${short.id}/save`, {
      audience: 'not_kids',
      publishAt: local(soon),
      then: 'schedule',
    });
    assert.match(early.error ?? '', /at least 15 minutes/);
    const when = new Date(s.clock.now().getTime() + 2 * 86_400_000);
    await web.get(`/publish/${videoId}`);
    const res = await web.submit(`/publish/item/${short.id}/save`, {
      audience: 'not_kids',
      privacy: 'public',
      publishAt: local(when),
      then: 'schedule',
    });
    assert.match(res.notice ?? '', /uploading privately with the publish time/);
    await s.publisher.idle();
    let p = s.videos.getPublication(short.id);
    assert.equal(publicState(p), 'SCHEDULED', JSON.stringify(p));
    const yt = g.videos.get(p.youtube_video_id!)!;
    assert.equal(yt.meta.status.privacyStatus, 'private', 'scheduled videos are private until the time');
    assert.equal(yt.meta.status.publishAt, new Date(local(when)).toISOString());
    assert.equal(yt.meta.status.selfDeclaredMadeForKids, false);
    assert.match(p.youtube_url!, /youtube\.com\/shorts\//);
    assert.equal(s.videos.get(videoId).status, 'scheduled');

    // Two hours later the access token has expired: the client refreshes it by itself.
    const before = g.issued.length;
    s.clockCtl.advanceSeconds(2 * 3600);
    g.publish(p.youtube_video_id!);
    await web.get(`/publish/${videoId}`);
    const checked = await web.submit(`/publish/item/${short.id}/refresh`);
    assert.match(checked.notice ?? '', /YouTube says: PUBLISHED/);
    assert.equal(g.issued.length, before + 1, 'one refreshed access token');
    p = s.videos.getPublication(short.id);
    assert.equal(p.status, 'published');
    assert.equal(s.videos.get(videoId).status, 'published');
  });

  it('an unaudited API project: a public upload is locked private → BLOCKED BY API RESTRICTION', async () => {
    g.unaudited = true;
    g.thumbnailsForbidden = true;
    const extra = s.videos.createPublication({
      video_id: videoId,
      short_id: null,
      kind: 'episode',
      metadata_json: episode.metadata_json,
      made_for_kids: 0,
      privacy: 'public',
    });
    s.publisher.approve(extra.id, 'upload');
    await s.publisher.idle();
    const p = s.videos.getPublication(extra.id);
    assert.equal(publicState(p), 'BLOCKED BY API RESTRICTION', JSON.stringify(p));
    assert.match(p.error_message!, /API audit/);
    assert.match(p.thumbnail_status!, /verified YouTube channel/);
    const dash = await web.get('/publish');
    assert.match(dash.text, /Needs Attention.*BLOCKED BY API RESTRICTION/);
    g.unaudited = false;
    g.thumbnailsForbidden = false;
  });

  it('after a restart, an interrupted upload is shown as failed and waits for RETRY', () => {
    const extra = s.videos.createPublication({
      video_id: videoId,
      short_id: null,
      kind: 'episode',
      metadata_json: episode.metadata_json,
      made_for_kids: 1,
    });
    s.videos.updatePublication(extra.id, { status: 'uploading' });
    assert.equal(s.publisher.recoverAfterRestart(), 1);
    const p = s.videos.getPublication(extra.id);
    assert.equal(p.status, 'failed');
    assert.match(p.error_message!, /Press RETRY/);
  });

  it('SAFE PRIVATE TEST UPLOAD: a 3-second clip, PRIVATE, then deleted', async () => {
    await web.get('/publish/youtube');
    const res = await web.submit('/publish/youtube/test');
    assert.match(res.notice ?? '', /Private test uploaded \(private, uploaded\)/);
    const t = s.publisher.lastPrivateTest()!;
    const yt = g.videos.get(t.videoId)!;
    assert.equal(yt.meta.status.privacyStatus, 'private', 'never public');
    assert.match(String(yt.meta.snippet['title']), /private test upload/);
    const del = await web.submit('/publish/youtube/test/delete');
    assert.match(del.notice ?? '', /deleted/);
    assert.equal(g.videos.has(t.videoId), false);
    assert.equal(s.publisher.lastPrivateTest()!.deleted, true);
  });

  it('no token, client secret or upload session URL ever reaches the log', () => {
    const all = logs.join('\n');
    assert.ok(all.includes('uploaded to youtube'), 'the log has the upload events');
    for (const t of [...g.issued, g.clientSecret]) assert.ok(!all.includes(t), 'secret in log');
    for (const id of g.uploads.keys()) assert.ok(!all.includes(id), 'upload session in log');
  });

  it('DISCONNECT revokes the permission at Google and forgets the tokens', async () => {
    await web.get('/publish/youtube');
    const res = await web.submit('/publish/youtube/disconnect');
    assert.match(res.notice ?? '', /disconnected and the permission revoked/);
    assert.equal(g.revoked.length, 1);
    assert.ok(g.revoked[0]!.startsWith('1//'), 'the refresh token was revoked');
    assert.equal(s.publisher.yt.connected(), false);
    assert.match(res.text, /Not connected/);
    await web.get(`/publish/${videoId}`);
    assert.match(web.page!.text, /Connect YouTube first/);
  });
});
