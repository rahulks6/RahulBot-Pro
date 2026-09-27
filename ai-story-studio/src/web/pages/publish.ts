import { AppError, toAppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import type { ChannelProfile } from '../../repositories/series.ts';
import type { Publication } from '../../repositories/videos.ts';
import { languageName } from '../../services/localization.ts';
import { nextSlotIn, publicState } from '../../services/publisher.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { raw } from '../html.ts';
import { button, card, field, html, kv, mediaUrl, postForm, select, when, type SafeHtml } from '../ui.ts';

/**
 * Simple Mode: PUBLISH. Nothing goes to YouTube without a person pressing APPROVE on a filled-in
 * review form (audience chosen, AI disclosure shown). YouTube connection, schedule template and the
 * safe private test live on /publish/youtube.
 */
export function registerPublishPages(web: Web): void {
  const s = web.studio;
  const r = web.router;
  const yt = s.publisher.yt;

  const stateBadge = (p: Publication): SafeHtml => {
    const st = publicState(p);
    const kind = ['PUBLISHED', 'SCHEDULED', 'UPLOAD SUCCESSFUL', 'PRIVATE'].includes(st)
      ? 'good'
      : ['BLOCKED BY API RESTRICTION', 'UPLOAD FAILED'].includes(st)
        ? 'bad'
        : 'warn';
    return html`<span class="badge ${kind}">${st}</span>`;
  };

  // --- YouTube connection (registered before /publish/:id) ------------------------------------

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
    (d, i) => [String(i), d] as [string, string],
  );
  const ZONES: Array<[string, string]> = [
    ['', "This computer's time"],
    ['330', 'India (IST, UTC+5:30)'],
    ['0', 'UTC / London (winter)'],
    ['60', 'Central Europe (winter)'],
    ['240', 'Gulf (UTC+4)'],
    ['345', 'Nepal (UTC+5:45)'],
    ['360', 'Bangladesh (UTC+6)'],
    ['-300', 'US Eastern (winter)'],
    ['-480', 'US Pacific (winter)'],
  ];
  const AUDIENCE: Array<[string, string]> = [
    ['ask', 'Ask me for every video (recommended)'],
    ['kids', 'My videos are made for kids'],
    ['not_kids', 'My videos are not made for kids'],
  ];
  const PRIVACY: Array<[string, string]> = [
    ['private', 'Private'],
    ['unlisted', 'Unlisted'],
    ['public', 'Public'],
  ];
  const SCHEDULES: Array<[string, string]> = [
    ['none', 'No schedule (I choose each time)'],
    ['daily', 'Every day'],
    ['weekly', 'Once a week'],
  ];
  const englishIdentity = (): { id: string; title: string } | null =>
    parseJson<{ id: string; title: string } | null>(
      s.db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = 'youtube.channel'")?.value,
      null,
    );
  /** The YouTube channel a profile is signed in to (English: the original connection). */
  const identity = (c: ChannelProfile): { id: string; title: string } | null =>
    c.language === 'en'
      ? englishIdentity()
      : c.youtube_channel_id
        ? { id: c.youtube_channel_id, title: c.youtube_channel_title ?? c.youtube_channel_id }
        : null;
  const channelParam = (c: ChannelProfile): Record<string, string> =>
    c.language === 'en' ? {} : { channel: c.id };

  const channelCard = (c: ChannelProfile): SafeHtml => {
    const cyt = s.publisher.ytFor(c.id);
    const who = identity(c);
    const english = c.language === 'en';
    const d = s.publisher.defaults(c);
    const test = s.publisher.lastPrivateTest(c.id);
    const slot = nextSlotIn(d, s.clock.now());
    const twin = who
      ? s.series.channels().find((o) => o.id !== c.id && identity(o)?.id === who.id)
      : undefined;
    const connectLabel = english ? 'CONNECT YOUTUBE' : `CONNECT ${c.name.toUpperCase()}`;
    const connectHref = english ? '/publish/youtube/connect' : `/publish/youtube/connect?channel=${c.id}`;
    return card(
      `${c.name} — ${languageName(c.language)}`,
      html`${cyt.connected()
          ? html`<p class="big good">
              ${english ? 'YOUTUBE CONNECTED ✓' : `${c.name.toUpperCase()} CONNECTED ✓`}${who
                ? html` — ${who.title}`
                : ''}
            </p>`
          : html`<p class="big">Not connected</p>`}
        ${twin
          ? html`<p class="flash error">
              This profile and "${twin.name}" are signed in to the SAME YouTube channel (${who!.title}). Sign
              one of them out and connect the right channel, or both languages go to one channel.
            </p>`
          : ''}
        <div class="actions">
          ${cyt.connected()
            ? button(
                '/publish/youtube/disconnect',
                english ? 'DISCONNECT YOUTUBE' : `DISCONNECT ${c.name.toUpperCase()}`,
                channelParam(c),
                {
                  kind: 'danger',
                  confirm: 'Disconnect this channel? Scheduled videos stay scheduled on YouTube.',
                },
              )
            : yt.hasClient()
              ? html`<a class="btn primary" href="${connectHref}">${connectLabel}</a>`
              : html`<span class="muted">Save the OAuth client above first.</span>`}
        </div>
        <h3>Safe private test upload</h3>
        <p>
          Uploads a 3-second test picture as <strong>PRIVATE</strong> (never public) to this channel and reads
          back its status, to prove the connection works. Delete it afterwards.
        </p>
        ${test
          ? kv([
              ['Last test', when(test.at)],
              ['YouTube video', test.deleted ? 'deleted' : test.videoId],
              ['Upload status', test.state],
              ['Visibility', test.privacy],
            ])
          : html`<p class="muted">NOT TESTED yet.</p>`}
        <div class="actions">
          ${cyt.connected()
            ? button('/publish/youtube/test', 'RUN PRIVATE TEST UPLOAD', channelParam(c), { kind: 'primary' })
            : ''}
          ${test && !test.deleted
            ? button('/publish/youtube/test/delete', 'Delete the test video', channelParam(c), {
                confirm: 'Delete the private test video from YouTube?',
              })
            : ''}
        </div>
        <h3>Publishing schedule</h3>
        ${english
          ? postForm(
              '/publish/youtube/schedule',
              html`<div class="row">
                  ${select('Default visibility', 'defaultPrivacy', PRIVACY, d.defaultPrivacy)}
                  ${select('Schedule', 'schedule', SCHEDULES, d.schedule)}
                  ${field('Time', 'time', d.time, { type: 'time' })}
                  ${select('Day (weekly)', 'weekday', WEEKDAYS, String(d.weekday))}
                  ${field('Hours between episode and Shorts', 'shortsGapHours', d.shortsGapHours, {
                    type: 'number',
                  })}
                </div>
                ${select('Audience', 'audience', AUDIENCE, d.audience, {
                  help: 'Pre-fills the review form only. You still see and confirm it before every upload.',
                })}
                <p class="muted">Next slot: ${slot ? slot.toString().slice(0, 21) : 'none (no schedule)'}</p>
                <button class="primary">Save schedule</button>`,
            )
          : postForm(
              `/publish/youtube/channel/${c.id}`,
              html`${field('Profile name', 'name', c.name, { required: true })}
                <div class="row">
                  ${select('Default visibility', 'default_privacy', PRIVACY, d.defaultPrivacy)}
                  ${select('Schedule', 'schedule', SCHEDULES, d.schedule)}
                  ${field('Time', 'publish_time', d.time, { type: 'time' })}
                  ${select('Day (weekly)', 'weekday', WEEKDAYS, String(d.weekday))}
                  ${select(
                    'Time zone of this audience',
                    'utc_offset_minutes',
                    ZONES,
                    d.utcOffsetMinutes ?? '',
                  )}
                </div>
                ${select('Audience', 'audience', AUDIENCE, d.audience, {
                  help: 'Pre-fills the review form only. You still see and confirm it before every upload.',
                })}
                <p class="muted">
                  Next slot:
                  ${slot
                    ? `${slot.toString().slice(0, 21)} on this computer${d.utcOffsetMinutes !== null ? ` (${d.time} for the audience)` : ''}`
                    : 'none (no schedule)'}
                </p>
                <button class="primary">Save channel</button>`,
            )}`,
    );
  };

  r.get('/publish/youtube', (req) => {
    const channels = s.series.ensureDefaultChannels();
    const body = html`${card(
      'Google OAuth client (shared by all channels)',
      html`<p class="muted">
          AI Story Studio uses your own Google OAuth client (see
          <a href="/docs/youtube-setup">YouTube setup</a>). Your Google password is never entered here. The
          sign-in happens on Google's page; the permission can be removed at any time in your Google Account.
          Each channel below signs in separately, so the English and Hinglish versions go to their own
          channels.
        </p>
        ${yt.hasClient()
          ? button(
              '/publish/youtube/forget-client',
              'Replace the OAuth client',
              {},
              { confirm: 'Forget the saved OAuth client ID and secret?' },
            )
          : postForm(
              '/publish/youtube/client',
              html`${field('OAuth client ID', 'client_id', '', {
                  required: true,
                  placeholder: '1234567890-abc….apps.googleusercontent.com',
                })}
                <label class="field"
                  ><span>OAuth client secret</span
                  ><input type="password" name="client_secret" autocomplete="off" required /><small
                    >Stored encrypted on this computer, never shown again or logged.</small
                  ></label
                >
                <button class="primary">Save client</button>`,
            )}`,
    )}
    ${channels.map(channelCard)}`;
    return web.render(req, 'YouTube', '/publish', body);
  });

  const channelOf = (id: string | undefined): ChannelProfile | null => (id ? s.series.channel(id) : null);

  r.post('/publish/youtube/client', (req) => {
    yt.saveClient(req.form['client_id'] ?? '', req.form['client_secret'] ?? '');
    s.logger.info('youtube oauth client saved', {});
    return web.redirect('/publish/youtube', 'OAuth client saved. Now press CONNECT YOUTUBE.');
  });
  r.post('/publish/youtube/forget-client', () => {
    yt.forgetClient();
    return web.redirect('/publish/youtube', 'OAuth client removed.');
  });
  r.get('/publish/youtube/connect', (req) => {
    const host = req.raw.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host))
      throw new AppError('FORBIDDEN', 'Open AI Story Studio at http://127.0.0.1:<port> to connect YouTube.');
    const channel = channelOf(req.query.get('channel') ?? undefined);
    return {
      type: 'redirect',
      location: s.publisher.ytFor(channel?.id).authUrl(`http://${host}/publish/youtube/callback`),
    };
  });
  r.get('/publish/youtube/callback', async (req) => {
    const err = req.query.get('error');
    if (err) return web.redirect('/publish/youtube', undefined, `Google did not connect YouTube (${err}).`);
    try {
      const state = req.query.get('state') ?? '';
      // Each channel profile starts its own sign-in; the state says which one Google is returning to.
      const found = s.publisher.channelForSignIn(state) ?? { yt, channel: null };
      await found.yt.finishSignIn(state, req.query.get('code') ?? '');
      const who = await found.yt.channel();
      const english = !found.channel || found.channel.language === 'en';
      if (english)
        s.db.run(
          "INSERT INTO app_meta (key, value) VALUES ('youtube.channel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          JSON.stringify(who),
        );
      if (found.channel)
        s.series.updateChannel(found.channel.id, {
          youtube_channel_id: who.id,
          youtube_channel_title: who.title,
        });
      s.logger.info('youtube connected', { channel: who.title, profile: found.channel?.name ?? 'English' });
      return web.redirect(
        '/publish/youtube',
        english
          ? `YOUTUBE CONNECTED ✓ — ${who.title}`
          : `${found.channel!.name.toUpperCase()} CONNECTED ✓ — ${who.title}`,
      );
    } catch (e) {
      return web.redirect('/publish/youtube', undefined, toAppError(e).message);
    }
  });
  r.post('/publish/youtube/disconnect', async (req) => {
    const channel = channelOf(req.form['channel']);
    await s.publisher.ytFor(channel?.id).disconnect();
    if (!channel || channel.language === 'en') s.db.run("DELETE FROM app_meta WHERE key = 'youtube.channel'");
    if (channel)
      s.series.updateChannel(channel.id, { youtube_channel_id: null, youtube_channel_title: null });
    return web.redirect('/publish/youtube', 'YouTube disconnected and the permission revoked.');
  });
  r.post('/publish/youtube/test', async (req) => {
    const t = await s.publisher.privateTest(channelOf(req.form['channel'])?.id);
    return web.redirect('/publish/youtube', `Private test uploaded (${t.privacy}, ${t.state}).`);
  });
  r.post('/publish/youtube/test/delete', async (req) => {
    await s.publisher.deletePrivateTest(channelOf(req.form['channel'])?.id);
    return web.redirect('/publish/youtube', 'The test video was deleted from YouTube.');
  });
  r.post('/publish/youtube/schedule', (req) => {
    const f = req.form;
    s.settings.set('publishing', {
      defaultPrivacy: f['defaultPrivacy'],
      schedule: f['schedule'],
      time: f['time'],
      weekday: f['weekday'],
      shortsGapHours: f['shortsGapHours'],
      audience: f['audience'],
    });
    return web.redirect('/publish/youtube', 'Schedule saved.');
  });
  r.post('/publish/youtube/channel/:id', (req) => {
    const c = s.series.channel(req.params['id']!);
    const f = req.form;
    const pick = <T extends string>(v: string | undefined, allowed: readonly T[], dflt: T): T =>
      allowed.find((a) => a === v) ?? dflt;
    const name = (f['name'] ?? '').trim();
    if (!name) throw new AppError('VALIDATION_FAILED', 'The profile needs a name.');
    const time = f['publish_time'] ?? '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new AppError('VALIDATION_FAILED', 'Enter the time as HH:MM.');
    const zone = f['utc_offset_minutes'] ?? '';
    const offset = zone === '' ? null : Number(zone);
    if (offset !== null && (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60))
      throw new AppError('VALIDATION_FAILED', 'That time zone is not valid.');
    const weekday = Number(f['weekday']);
    s.series.updateChannel(c.id, {
      name: name.slice(0, 80),
      default_privacy: pick(f['default_privacy'], ['private', 'unlisted', 'public'] as const, 'private'),
      schedule: pick(f['schedule'], ['none', 'daily', 'weekly'] as const, 'none'),
      publish_time: time,
      weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 6,
      utc_offset_minutes: offset,
      audience: pick(f['audience'], ['ask', 'kids', 'not_kids'] as const, 'ask'),
    });
    return web.redirect('/publish/youtube', `${name} saved.`);
  });

  // --- the dashboard ------------------------------------------------------------------------------

  r.get('/publish', (req) => {
    for (const v of s.videos.list({ status: ['ready', 'approved', 'scheduled', 'published'] }))
      s.publisher.ensurePublications(v.id);
    const pubs = s.videos.publications();
    const group = (states: Publication['status'][]) => pubs.filter((p) => states.includes(p.status));
    const row = (p: Publication): SafeHtml => {
      const v = s.videos.get(p.video_id);
      const title = s.publisher.meta(p).title || v.title;
      return html`<li>
        ${stateBadge(p)} <a href="/publish/${v.id}#pub-${p.id}">${title}</a>
        <span class="muted"
          >${p.kind === 'short' ? 'Short' : 'Episode'} ·
          ${languageName(p.language)}${p.channel_profile_id
            ? ` → ${s.publisher.channelName(p)}`
            : ''}${p.publish_at ? ` · ${when(p.publish_at)}` : ''}</span
        >
        ${p.youtube_url ? html` · <a href="${p.youtube_url}" target="_blank" rel="noopener">YouTube</a>` : ''}
        ${p.error_message ? html`<br /><small class="bad">${p.error_message}</small>` : ''}
      </li>`;
    };
    const section = (title: string, list: Publication[], empty: string) =>
      card(
        title,
        list.length
          ? html`<ul class="pub-list">
              ${list.map(row)}
            </ul>`
          : html`<p class="muted">${empty}</p>`,
      );
    const attentionVideos = s.videos.list({ status: ['needs_attention', 'failed'] });
    const body = html`<p>
        ${yt.connected()
          ? html`<span class="badge good">YouTube connected</span>`
          : html`<span class="badge warn">YouTube not connected</span>`}
        <a href="/publish/youtube">YouTube connection and schedule →</a>
      </p>
      ${section('Ready for Review', group(['ready_for_review']), 'Nothing is waiting for review.')}
      ${section('Uploading', group(['approved', 'uploading']), 'Nothing is uploading.')}
      ${section('Scheduled', group(['scheduled']), 'Nothing is scheduled.')}
      ${section('Published and uploaded', group(['published', 'uploaded']), 'Nothing is on YouTube yet.')}
      ${card(
        'Needs Attention',
        group(['blocked', 'failed']).length || attentionVideos.length
          ? html`<ul class="pub-list">
              ${group(['blocked', 'failed']).map(row)}
              ${attentionVideos.map(
                (v) =>
                  html`<li>
                    <span class="badge bad">VIDEO</span> <a href="/videos/${v.id}">${v.title}</a> — needs
                    attention before it can be published
                  </li>`,
              )}
            </ul>`
          : html`<p class="muted">Nothing needs attention.</p>`,
      )}`;
    return web.render(req, 'Publish', '/publish', body);
  });

  // --- review & approve one video -----------------------------------------------------------------

  r.get('/publish/:id', (req) => {
    const v = s.videos.get(req.params['id']!);
    const pubs = s.publisher.ensurePublications(v.id);
    if (!pubs.length) throw new AppError('PRECONDITION_FAILED', 'This video is not finished yet.');
    const pubSettings = s.settings.get('publishing');
    const cards = pubs.map((p) => {
      const m = s.publisher.meta(p);
      const short = p.short_id ? s.videos.getShort(p.short_id) : null;
      const exp = v.episode_export_id ? s.reports.getExport(v.episode_export_id) : null;
      const loc = p.localization_id ? s.series.localization(p.localization_id) : null;
      const videoKey = loc
        ? loc.video_key
        : short
          ? short.video_key
          : exp?.master_asset_id
            ? s.assets.get(exp.master_asset_id).storage_key
            : null;
      const thumb = loc ? loc.thumbnail_key : short ? short.thumbnail_key : v.thumbnail_key;
      const suggested = s.publisher.suggestedSlot(p);
      const flagged = loc
        ? parseJson<Array<{ message: string }>>(loc.qa_json, []).length +
          (parseJson<{ flagged?: unknown[] }>(loc.timing_json, {}).flagged?.length ?? 0)
        : 0;
      const editable = ['ready_for_review', 'failed', 'blocked'].includes(p.status);
      const local = (iso: string | null) =>
        iso
          ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16)
          : '';
      return html`<section class="card" id="pub-${p.id}">
        <header>
          <h2>
            ${short ? `Short ${short.idx + 1}` : 'Full episode'} — ${languageName(p.language)}
            <small class="muted">→ ${s.publisher.channelName(p)}</small>
          </h2>
          <div>${stateBadge(p)}</div>
        </header>
        <div class="shot-edit">
          <div>
            ${videoKey
              ? html`<video
                  controls
                  preload="metadata"
                  src="${mediaUrl(videoKey)}"
                  ${thumb ? raw(`poster="${mediaUrl(thumb)}"`) : ''}
                  style="width:240px"
                ></video>`
              : ''}
          </div>
          <div>
            ${p.error_message ? html`<p class="flash error">${p.error_message}</p>` : ''}
            ${loc && (loc.status === 'needs_attention' || flagged)
              ? html`<p class="flash error">
                  This ${languageName(loc.language)} version has ${flagged || 'some'} flagged line(s) (wording
                  or timing). Watch it before approving; details in the video's quality check.
                </p>`
              : ''}
            ${p.youtube_url
              ? html`<p><a href="${p.youtube_url}" target="_blank" rel="noopener">${p.youtube_url}</a></p>`
              : ''}
            ${p.status === 'uploading'
              ? html`<p>
                  Uploading… ${p.uploaded_bytes ? `${Math.round(p.uploaded_bytes / 1048576)} MB sent` : ''}
                </p>`
              : ''}
            ${p.captions_status || p.thumbnail_status
              ? kv([
                  ['Captions', p.captions_status ?? '—'],
                  ['Thumbnail', p.thumbnail_status ?? '—'],
                ])
              : ''}
            ${p.status === 'failed'
              ? html`<div class="actions">
                  ${button(`/publish/item/${p.id}/retry`, 'RETRY', {}, { kind: 'primary' })}
                  <small class="muted">Continues the upload where it stopped, with the settings below.</small>
                </div>`
              : ''}
            ${editable
              ? postForm(
                  `/publish/item/${p.id}/save`,
                  html`${field('Title', 'title', m.title, { required: true })}
                    ${field('Description', 'description', m.description, { textarea: true, rows: 6 })}
                    ${field('Tags (comma separated)', 'tags', m.tags.join(', '))}
                    <fieldset class="audience">
                      <legend><strong>Audience (required by YouTube)</strong></legend>
                      <label class="check"
                        ><input
                          type="radio"
                          name="audience"
                          value="kids"
                          ${p.made_for_kids === 1 ? raw('checked') : ''}
                        />
                        Yes, it's made for kids</label
                      >
                      <label class="check"
                        ><input
                          type="radio"
                          name="audience"
                          value="not_kids"
                          ${p.made_for_kids === 0 ? raw('checked') : ''}
                        />
                        No, it's not made for kids</label
                      >
                      <small
                        >You decide this; AI Story Studio never chooses it for you. Made-for-kids videos have
                        comments and some features turned off by YouTube.</small
                      >
                    </fieldset>
                    <label class="check"
                      ><input type="hidden" name="synthetic" value="false" /><input
                        type="checkbox"
                        name="synthetic"
                        value="true"
                        ${p.synthetic_media ? raw('checked') : ''}
                      />
                      Tell YouTube this video contains AI-generated (synthetic) content</label
                    >
                    <div class="row">
                      ${select(
                        'Visibility',
                        'privacy',
                        [
                          ['private', 'Private'],
                          ['unlisted', 'Unlisted'],
                          ['public', 'Public'],
                        ],
                        p.privacy,
                      )}
                      <label class="field"
                        ><span>Publish at (for APPROVE & SCHEDULE)</span
                        ><input
                          type="datetime-local"
                          name="publishAt"
                          value="${local(p.publish_at) || (suggested ? local(suggested.toISOString()) : '')}"
                      /></label>
                    </div>
                    <button name="then" value="save">Save</button>
                    <button
                      name="then"
                      value="upload"
                      class="primary"
                      data-confirm="Upload to YouTube now with this visibility and audience?"
                    >
                      APPROVE & UPLOAD
                    </button>
                    <button
                      name="then"
                      value="schedule"
                      class="primary"
                      data-confirm="Upload privately now and publish at the chosen time?"
                    >
                      APPROVE & SCHEDULE
                    </button>`,
                )
              : html`${kv([
                    ['Title', m.title],
                    ['Visibility', p.privacy],
                    ['Made for kids', p.made_for_kids === 1 ? 'yes' : p.made_for_kids === 0 ? 'no' : '—'],
                    ['AI disclosure', p.synthetic_media ? 'yes' : 'no'],
                    ['Approved', when(p.approved_at)],
                  ])}
                  <div class="actions">
                    ${p.youtube_video_id
                      ? button(`/publish/item/${p.id}/refresh`, 'Check status on YouTube')
                      : ''}
                  </div>`}
          </div>
        </div>
      </section>`;
    });
    const open = pubs.filter((p) => ['ready_for_review', 'failed', 'blocked'].includes(p.status));
    const openEpisodes = open.filter((p) => p.kind === 'episode');
    const languages = new Set(pubs.map((p) => p.language));
    const disconnected = [...new Set(pubs.map((p) => p.channel_profile_id))].filter(
      (c) => !s.publisher.ytFor(c).connected(),
    );
    const approveBoth =
      languages.size > 1 && open.length > 1
        ? card(
            'Approve both languages',
            postForm(
              `/publish/${v.id}/approve-many`,
              html`<p>
                  Approves the ${[...languages].map(languageName).join(' and ')} versions together, each to
                  its own channel with its own settings below. If any one of them is not ready (audience not
                  chosen, channel not connected, no publish time), nothing is approved.
                </p>
                <fieldset class="audience">
                  <legend><strong>Audience for all of them (required by YouTube)</strong></legend>
                  <label class="check"
                    ><input type="radio" name="audience" value="kids" /> Yes, made for kids</label
                  >
                  <label class="check"
                    ><input type="radio" name="audience" value="not_kids" /> No, not made for kids</label
                  >
                  <label class="check"
                    ><input type="radio" name="audience" value="" checked /> Keep what each item below
                    says</label
                  >
                </fieldset>
                ${select(
                  'Which items',
                  'scope',
                  [
                    ['episodes', `Both full episodes (${openEpisodes.length})`],
                    ['all', `Everything waiting (${open.length}, with Shorts)`],
                  ],
                  'episodes',
                )}
                <div class="actions">
                  <button
                    name="then"
                    value="schedule"
                    class="primary"
                    data-confirm="Upload privately now and publish each at its channel's time?"
                  >
                    APPROVE BOTH & SCHEDULE
                  </button>
                  <button
                    name="then"
                    value="upload"
                    data-confirm="Upload now to both channels with the visibility shown on each item?"
                  >
                    APPROVE BOTH & UPLOAD
                  </button>
                </div>`,
            ),
          )
        : '';
    const body = html`<p>
        ${disconnected.length
          ? html`<span class="badge warn">Connect YouTube first</span>
              <a href="/publish/youtube">YouTube connection →</a>`
          : ''}
      </p>
      ${approveBoth}
      <p class="muted">
        Review each item. Nothing is uploaded until you press APPROVE. Visibility starts as
        ${pubSettings.defaultPrivacy.toUpperCase()}.
      </p>
      ${cards}`;
    return web.render(req, `Publish: ${v.title}`, '/publish', body);
  });

  r.post('/publish/item/:pub/save', async (req) => {
    const f = req.form;
    const p = s.videos.getPublication(req.params['pub']!);
    // The browser sends local time without a zone; it is this computer's local time.
    const publishAt = f['publishAt'] ? new Date(f['publishAt']).toISOString() : '';
    s.publisher.save(p.id, {
      title: f['title'] ?? '',
      description: f['description'] ?? '',
      tags: f['tags'] ?? '',
      privacy: f['privacy'] ?? 'private',
      publishAt: f['then'] === 'upload' ? '' : publishAt,
      audience: f['audience'] ?? '',
      synthetic: yes(f['synthetic']),
    });
    if (f['then'] === 'upload' || f['then'] === 'schedule') {
      s.publisher.approve(p.id, f['then']);
      return web.redirect(
        `/publish/${p.video_id}`,
        f['then'] === 'schedule'
          ? 'Approved: uploading privately with the publish time.'
          : 'Approved: uploading now.',
      );
    }
    return web.redirect(`/publish/${p.video_id}`, 'Saved.');
  });
  r.post('/publish/:id/approve-many', (req) => {
    const v = s.videos.get(req.params['id']!);
    const f = req.form;
    const mode = f['then'] === 'upload' ? 'upload' : 'schedule';
    const open = s.publisher
      .ensurePublications(v.id)
      .filter((p) => ['ready_for_review', 'failed', 'blocked'].includes(p.status))
      .filter((p) => f['scope'] === 'all' || p.kind === 'episode');
    const made = f['audience'] === 'kids' ? 1 : f['audience'] === 'not_kids' ? 0 : null;
    if (made !== null)
      for (const p of open)
        s.videos.updatePublication(p.id, {
          made_for_kids: made,
          metadata_json: JSON.stringify({ ...s.publisher.meta(p), madeForKids: made === 1 }),
        });
    const done = s.publisher.approveMany(
      open.map((p) => p.id),
      mode,
    );
    return web.redirect(
      `/publish/${v.id}`,
      `Approved ${done.length} item(s): ${mode === 'schedule' ? 'uploading privately with their publish times' : 'uploading now'}.`,
    );
  });
  r.post('/publish/item/:pub/retry', (req) => {
    const p = s.videos.getPublication(req.params['pub']!);
    s.publisher.retry(p.id);
    return web.redirect(`/publish/${p.video_id}`, 'Trying again (the upload continues where it stopped).');
  });
  r.post('/publish/item/:pub/refresh', async (req) => {
    const p = await s.publisher.refresh(req.params['pub']!);
    return web.redirect(`/publish/${p.video_id}`, `YouTube says: ${publicState(p)}.`);
  });
}
