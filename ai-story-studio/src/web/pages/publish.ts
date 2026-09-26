import { AppError, toAppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import type { Publication } from '../../repositories/videos.ts';
import { nextSlot, publicState } from '../../services/publisher.ts';
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

  r.get('/publish/youtube', (req) => {
    const pub = s.settings.get('publishing');
    const channel = parseJson<{ id: string; title: string } | null>(
      s.db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = 'youtube.channel'")?.value,
      null,
    );
    const test = s.publisher.lastPrivateTest();
    const slot = nextSlot(pub, s.clock.now());
    const body = html`${card(
      'YouTube connection',
      html`${yt.connected()
          ? html`<p class="big good">YOUTUBE CONNECTED ✓${channel ? html` — ${channel.title}` : ''}</p>`
          : html`<p class="big">Not connected</p>`}
        <p class="muted">
          AI Story Studio uses your own Google OAuth client (see
          <a href="/docs/youtube-setup">YouTube setup</a>). Your Google password is never entered here. The
          sign-in happens on Google's page; the permission can be removed at any time in your Google Account.
        </p>
        ${yt.connected()
          ? html`<div class="actions">
              ${button(
                '/publish/youtube/disconnect',
                'DISCONNECT YOUTUBE',
                {},
                {
                  kind: 'danger',
                  confirm: 'Disconnect YouTube? Scheduled videos stay scheduled on YouTube.',
                },
              )}
            </div>`
          : yt.hasClient()
            ? html`<p><a class="btn primary" href="/publish/youtube/connect">CONNECT YOUTUBE</a></p>
                ${button(
                  '/publish/youtube/forget-client',
                  'Replace the OAuth client',
                  {},
                  { confirm: 'Forget the saved OAuth client ID and secret?' },
                )}`
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
    ${card(
      'Safe private test upload',
      html`<p>
          Uploads a 3-second test picture as <strong>PRIVATE</strong> (never public) and reads back its
          status, to prove the connection works. Delete it afterwards.
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
          ${yt.connected()
            ? button('/publish/youtube/test', 'RUN PRIVATE TEST UPLOAD', {}, { kind: 'primary' })
            : ''}
          ${test && !test.deleted
            ? button(
                '/publish/youtube/test/delete',
                'Delete the test video',
                {},
                { confirm: 'Delete the private test video from YouTube?' },
              )
            : ''}
        </div>`,
    )}
    ${card(
      'Publishing schedule',
      postForm(
        '/publish/youtube/schedule',
        html`<div class="row">
            ${select(
              'Default visibility',
              'defaultPrivacy',
              [
                ['private', 'Private'],
                ['unlisted', 'Unlisted'],
                ['public', 'Public'],
              ],
              pub.defaultPrivacy,
            )}
            ${select(
              'Schedule',
              'schedule',
              [
                ['none', 'No schedule (I choose each time)'],
                ['daily', 'Every day'],
                ['weekly', 'Once a week'],
              ],
              pub.schedule,
            )}
            ${field('Time', 'time', pub.time, { type: 'time' })}
            ${select(
              'Day (weekly)',
              'weekday',
              ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (d, i) => [String(i), d] as [string, string],
              ),
              String(pub.weekday),
            )}
            ${field('Hours between episode and Shorts', 'shortsGapHours', pub.shortsGapHours, {
              type: 'number',
            })}
          </div>
          ${select(
            'Audience',
            'audience',
            [
              ['ask', 'Ask me for every video (recommended)'],
              ['kids', 'My videos are made for kids'],
              ['not_kids', 'My videos are not made for kids'],
            ],
            pub.audience,
            { help: 'Pre-fills the review form only. You still see and confirm it before every upload.' },
          )}
          <p class="muted">Next slot: ${slot ? slot.toString().slice(0, 21) : 'none (no schedule)'}</p>
          <button class="primary">Save schedule</button>`,
      ),
    )}`;
    return web.render(req, 'YouTube', '/publish', body);
  });

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
    return { type: 'redirect', location: yt.authUrl(`http://${host}/publish/youtube/callback`) };
  });
  r.get('/publish/youtube/callback', async (req) => {
    const err = req.query.get('error');
    if (err) return web.redirect('/publish/youtube', undefined, `Google did not connect YouTube (${err}).`);
    try {
      await yt.finishSignIn(req.query.get('state') ?? '', req.query.get('code') ?? '');
      const channel = await yt.channel();
      s.db.run(
        "INSERT INTO app_meta (key, value) VALUES ('youtube.channel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(channel),
      );
      s.logger.info('youtube connected', { channel: channel.title });
      return web.redirect('/publish/youtube', `YOUTUBE CONNECTED ✓ — ${channel.title}`);
    } catch (e) {
      return web.redirect('/publish/youtube', undefined, toAppError(e).message);
    }
  });
  r.post('/publish/youtube/disconnect', async () => {
    await yt.disconnect();
    s.db.run("DELETE FROM app_meta WHERE key = 'youtube.channel'");
    return web.redirect('/publish/youtube', 'YouTube disconnected and the permission revoked.');
  });
  r.post('/publish/youtube/test', async () => {
    const t = await s.publisher.privateTest();
    return web.redirect('/publish/youtube', `Private test uploaded (${t.privacy}, ${t.state}).`);
  });
  r.post('/publish/youtube/test/delete', async () => {
    await s.publisher.deletePrivateTest();
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
          >${p.kind === 'short' ? 'Short' : 'Episode'}${p.publish_at ? ` · ${when(p.publish_at)}` : ''}</span
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
      const videoKey = short
        ? short.video_key
        : exp?.master_asset_id
          ? s.assets.get(exp.master_asset_id).storage_key
          : null;
      const thumb = short ? short.thumbnail_key : v.thumbnail_key;
      const suggested = nextSlot(
        pubSettings,
        s.clock.now(),
        short ? pubSettings.shortsGapHours * (short.idx + 1) : 0,
      );
      const editable = ['ready_for_review', 'failed', 'blocked'].includes(p.status);
      const local = (iso: string | null) =>
        iso
          ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16)
          : '';
      return html`<section class="card" id="pub-${p.id}">
        <header>
          <h2>${short ? `Short ${short.idx + 1}` : 'Full episode'}</h2>
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
    const body = html`<p>
        ${!yt.connected()
          ? html`<span class="badge warn">Connect YouTube first</span>
              <a href="/publish/youtube">YouTube connection →</a>`
          : ''}
      </p>
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
