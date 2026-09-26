import { VIDEO_LENGTHS, VIDEO_STYLES } from '../../domain/video-styles.ts';
import { AppError, toAppError } from '../../lib/errors.ts';
import type { Video } from '../../repositories/videos.ts';
import type { EngineStatus } from '../../services/engine.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { raw } from '../html.ts';
import {
  button,
  card,
  checkbox,
  field,
  html,
  inr,
  kv,
  mediaUrl,
  postForm,
  select,
  when,
  type SafeHtml,
} from '../ui.ts';

/**
 * Simple Mode: Home, the AI Engine page and Simple Settings. Plain words only: no model names,
 * CUDA versions, VRAM or pod ids (those stay in Advanced Mode).
 */
export function registerSimplePages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.post('/ui-mode', (req) => {
    const mode = req.form['mode'] === 'advanced' ? 'advanced' : 'simple';
    s.settings.set('app', { ...s.settings.get('app'), uiMode: mode });
    return web.redirect(mode === 'advanced' ? '/dashboard' : '/');
  });

  r.get('/', (req) => {
    const engine = s.engine.status();
    const recent = s.videos.list({ limit: 6 });
    const body = html`<p class="subtitle">Turn your idea into a complete animated video.</p>
      <p><a class="btn primary huge" href="/create">+ CREATE NEW VIDEO</a></p>
      ${engineCard(engine)}
      ${card(
        'Recent Videos',
        recent.length
          ? html`<div class="video-grid">${recent.map((v) => videoCard(web, v))}</div>
              <p><a href="/videos">All videos →</a></p>`
          : html`<p class="muted">
              No videos yet. Press <strong>+ CREATE NEW VIDEO</strong> to make the first one.
            </p>`,
      )}`;
    return web.render(req, 'AI Story Studio', '/', body);
  });

  // --- AI Engine ---------------------------------------------------------------------------

  r.get('/settings/ai-engine', (req) => {
    const st = s.engine.status();
    const last = st.runpod.lastTest;
    const image = s.cloud.workerImage();
    const body = html`${engineCard(st, false)}
      ${st.state === 'DEVELOPER_TEST_MODE' || !s.env.enableCloudGpu
        ? card(
            'Switch to real AI',
            html`<p>
                The <code>.env</code> file puts AI Story Studio in developer test mode, where videos are made
                of labelled placeholders. Press the button to use real AI on RunPod. A copy of your current
                <code>.env</code> is kept next to it.
              </p>
              ${button('/settings/ai-engine/switch-to-real', 'SWITCH TO REAL AI', {}, { kind: 'primary' })}`,
          )
        : ''}
      ${card(
        'RunPod',
        html`${st.runpod.connected
          ? html`<p class="big good">RUNPOD CONNECTED ✓</p>`
          : st.runpod.source !== 'none'
            ? html`<p class="big warn">Key saved — connection not confirmed</p>`
            : html`<p class="big">Not connected</p>`}
        ${kv([
          ['Provider', 'RunPod (cloud GPU)'],
          [
            'API key',
            st.runpod.source === 'none'
              ? 'not saved'
              : `${st.runpod.masked} (${st.runpod.source === 'env' ? 'from the .env file' : 'saved on this computer, encrypted'})`,
          ],
          ['Last test', last ? `${last.ok ? 'OK' : 'FAILED'} · ${when(last.at)} · ${last.detail}` : 'never'],
          [
            'AI worker download',
            last
              ? last.imageOk
                ? 'OK — RunPod can download it'
                : last.imageDetail
              : 'checked by TEST CONNECTION',
          ],
          [
            'Key protection',
            st.keyProtection === 'dpapi'
              ? 'Encrypted with your Windows account (DPAPI)'
              : 'Encrypted; the key file is readable by your user only',
          ],
        ])}
        ${postForm(
          '/settings/ai-engine/key',
          html`<label class="field"
              ><span>${st.runpod.source === 'none' ? 'RunPod API key' : 'Replace the API key'}</span
              ><input
                type="password"
                name="api_key"
                autocomplete="off"
                spellcheck="false"
                placeholder="Paste the key from runpod.io → Settings → API Keys"
              /><small
                >The key is checked with RunPod, then stored encrypted on this computer. It is never shown
                again in full, never written to logs and never included in backups or exports.</small
              ></label
            >
            <div class="actions">
              <button name="action" value="test">TEST CONNECTION</button>
              <button name="action" value="save" class="primary">SAVE</button>
            </div>`,
        )}
        ${st.runpod.source === 'store'
          ? html`<div class="actions">
              ${button('/settings/ai-engine/retest', 'TEST SAVED KEY')}
              ${button(
                '/settings/ai-engine/delete',
                'DELETE KEY',
                {},
                {
                  kind: 'danger',
                  confirm: 'Delete the saved RunPod key? Videos cannot be generated until you connect again.',
                },
              )}
            </div>`
          : ''}`,
      )}
      ${card(
        'How it works',
        html`<ol>
            <li>You press <strong>GENERATE</strong> on the Create page.</li>
            <li>
              AI Story Studio rents a suitable NVIDIA GPU on RunPod, starts the AI worker and makes the video.
            </li>
            <li>The GPU is shut down automatically when the work is done, fails or is cancelled.</li>
          </ol>
          <p class="muted">
            Spending limits: ${inr(s.settings.get('cloud').sessionBudgetInr)} per video,
            ${inr(s.settings.get('budget').dailyInr)} per day. Change them in
            <a href="/settings">Settings</a>.
          </p>`,
      )}
      ${realTestCard(web)}
      <section class="card" id="worker">
        <header><h2>The AI worker</h2></header>
        <p>
          RunPod downloads the AI worker (<code>${image}</code>) the first time a GPU starts. It must be
          published once from GitHub. See <a href="/docs/runpod-setup">RunPod setup</a> for the one-time
          steps.
        </p>
      </section>
      <p class="muted">
        Advanced: <a href="/cloud">Cloud GPU details</a> · <a href="/gpu">GPU & Costs</a> ·
        <a href="/settings/advanced">Advanced Settings</a>
      </p>`;
    return web.render(req, 'AI Engine', '/settings', body);
  });

  r.post('/settings/ai-engine/key', async (req) => {
    const key = (req.form['api_key'] ?? '').trim();
    if (req.form['action'] === 'test') {
      const t = await s.engine.test(key || undefined);
      return t.ok
        ? web.redirect(
            '/settings/ai-engine',
            `Connection OK — RunPod accepted the key.${t.imageOk ? '' : ` Note: ${t.imageDetail}`}${key ? ' Press SAVE to keep it.' : ''}`,
          )
        : web.redirect('/settings/ai-engine', undefined, `Connection failed: ${t.detail}`);
    }
    if (!key) throw new AppError('VALIDATION_FAILED', 'Paste your RunPod API key first.');
    const t = await s.engine.connect(key);
    return web.redirect(
      '/settings/ai-engine',
      `RUNPOD CONNECTED ✓ — the key is saved (encrypted).${t.imageOk ? '' : ` Still needed: ${t.imageDetail}`}`,
    );
  });
  r.post('/settings/ai-engine/retest', async () => {
    const t = await s.engine.retest();
    return t.ok
      ? web.redirect('/settings/ai-engine', 'Connection OK — RunPod accepted the saved key.')
      : web.redirect('/settings/ai-engine', undefined, `Connection failed: ${t.detail}`);
  });
  r.post('/settings/ai-engine/delete', async () => {
    await s.engine.disconnect();
    return web.redirect('/settings/ai-engine', 'The RunPod key was deleted from this computer.');
  });
  r.post('/settings/ai-engine/forget', () => {
    s.engine.forgetSavedKeys();
    return web.redirect('/settings/ai-engine', 'Saved keys removed. Enter your RunPod key again.');
  });
  r.post('/settings/ai-engine/switch-to-real', async () => {
    const { backup } = await s.engine.switchToRealAi();
    return web.redirect(
      '/settings/ai-engine',
      `Real AI is on.${backup ? ' Your previous .env was copied to ' + backup.split(/[\\/]/).pop() + '.' : ''}`,
    );
  });
  r.post('/settings/ai-engine/turn-on', async () => {
    await s.engine.turnOn();
    return web.redirect('/settings/ai-engine', 'Real generation on RunPod is switched on.');
  });

  // --- Real Mode Test (milestone 1) -------------------------------------------------------------

  r.post('/settings/ai-engine/real-test', async () => {
    if (s.realTest.running) throw new AppError('CONFLICT', 'A Real Mode Test is already running.');
    const { record } = await s.realTest.prepare();
    return web.redirect(`/settings/ai-engine/real-test/${record.id}`);
  });
  r.get('/settings/ai-engine/real-test/:id', (req) => {
    const t = s.realTest.get(req.params['id']!);
    const waiting = t.status === 'running' && t.steps.find((x) => x.n === 4)?.status === 'RUNNING';
    const running = t.status === 'running' && !waiting;
    const body = html`${running ? raw('<meta http-equiv="refresh" content="5" />') : ''}
      ${card(
        'Milestone 1',
        html`<p>
            RUNPOD CONNECTED → REAL GPU → REAL IMAGE → REAL ANIMATION → REAL NARRATION → REAL PLAYABLE MP4.
            Every step below is executed for real; a step that was not reached says NOT TESTED.
          </p>
          <table class="steps">
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
            ${t.steps.map(
              (x) =>
                html`<tr>
                  <td>${x.n}</td>
                  <td>${x.name}</td>
                  <td><span class="badge ${resultKind(x.status)}">${x.status}</span></td>
                  <td>${x.detail}</td>
                </tr>`,
            )}
          </table>
          ${waiting
            ? html`<p class="flash">
                  Nothing has been rented yet. Pressing <strong>CONFIRM AND RUN</strong> rents the GPU shown
                  in step 3 until the test finishes (it is stopped automatically, even if something fails).
                </p>
                <div class="actions">
                  ${button(
                    `/settings/ai-engine/real-test/${t.id}/confirm`,
                    'CONFIRM AND RUN',
                    {},
                    { kind: 'primary' },
                  )}
                  ${button(`/settings/ai-engine/real-test/${t.id}/cancel`, 'Cancel')}
                </div>`
            : ''}
          ${running
            ? html`<p class="muted">
                  Running… this page refreshes every 5 seconds. The first run downloads the AI models on the
                  GPU.
                </p>
                ${button(
                  `/settings/ai-engine/real-test/${t.id}/cancel`,
                  'Cancel test',
                  {},
                  { kind: 'danger' },
                )}`
            : ''}
          ${t.output_key
            ? html`<h3>The real short MP4</h3>
                <video class="player" controls src="${mediaUrl(t.output_key)}"></video>
                <p><a href="${mediaUrl(t.output_key)}" download>Download the MP4</a></p>`
            : ''}
          ${t.finished_at
            ? kv([
                ['Overall', t.status === 'success' ? 'PASS — milestone 1 reached' : t.status.toUpperCase()],
                ['GPU', t.gpu_model ?? '—'],
                ['GPU time', t.runtime_sec !== null ? `${t.runtime_sec} s` : '—'],
                ['Estimated cost', t.cost_inr !== null ? inr(t.cost_inr) : '—'],
              ])
            : ''}`,
      )}
      <p><a href="/settings/ai-engine">← AI Engine</a></p>`;
    return web.render(req, 'Real Mode Test', '/settings', body);
  });
  r.post('/settings/ai-engine/real-test/:id/confirm', (req) => {
    const id = req.params['id']!;
    void s.realTest
      .confirm(id)
      .catch((err: unknown) =>
        s.logger.error('real mode test failed', { test: id, error: toAppError(err).message }),
      );
    return web.redirect(
      `/settings/ai-engine/real-test/${id}`,
      'Started. The GPU is stopped automatically at the end.',
    );
  });
  r.post('/settings/ai-engine/real-test/:id/cancel', (req) => {
    s.realTest.cancel(req.params['id']!);
    return web.redirect(`/settings/ai-engine/real-test/${req.params['id']}`, 'Cancelled.');
  });

  // --- Simple Settings -------------------------------------------------------------------------

  r.get('/settings', (req) => {
    const a = s.settings.get('app');
    const cloud = s.settings.get('cloud');
    const budget = s.settings.get('budget');
    const engine = s.engine.status();
    const body = html`${card(
      'AI Engine',
      html`<p>
          ${engine.state === 'READY'
            ? html`<span class="badge good">READY ✓</span>`
            : html`<span class="badge warn">Needs attention</span>`}
          ${engine.headline}
        </p>
        <p><a class="btn" href="/settings/ai-engine">RunPod connection →</a></p>`,
    )}
    ${card(
      'New videos start with',
      postForm(
        '/settings/simple/defaults',
        html`<div class="row">
            ${select(
              'Default style',
              'defaultStyle',
              VIDEO_STYLES.map((v) => [v.id, v.label] as [string, string]),
              a.defaultStyle,
            )}
            ${select(
              'Default length',
              'defaultLength',
              Object.entries(VIDEO_LENGTHS).map(
                ([k, v]) => [k, `${v.label} (${v.hint})`] as [string, string],
              ),
              a.defaultLength,
            )}
            ${field('Custom length (minutes)', 'customMinutes', a.customMinutes, {
              type: 'number',
              step: '0.5',
            })}
          </div>
          <div class="row">
            ${checkbox('Full episode (16:9)', 'makeEpisode', a.makeEpisode)}
            ${checkbox('Shorts (9:16)', 'makeShorts', a.makeShorts)}
            ${field('Shorts per video', 'shortsCount', a.shortsCount, { type: 'number' })}
          </div>
          <div class="row">
            ${select(
              'Narrator',
              'narrator',
              [
                ['female', 'Female voice'],
                ['male', 'Male voice'],
              ],
              a.narrator,
            )}
            ${select(
              'Language',
              'language',
              [
                ['en', 'English'],
                ['hi', 'Hindi'],
                ['hinglish', 'Hinglish'],
              ],
              a.language,
            )}
            ${select(
              'Background music',
              'backgroundMusic',
              [
                ['auto', 'Automatic (matches the story)'],
                ['calm', 'Calm'],
                ['playful', 'Playful'],
                ['adventure', 'Adventure'],
                ['emotional', 'Emotional'],
                ['off', 'No music'],
              ],
              a.backgroundMusic,
            )}
          </div>
          ${checkbox(
            'Burn captions into Shorts',
            'burnShortsCaptions',
            a.burnShortsCaptions,
            '(caption files are always made too)',
          )}
          <button class="primary">Save</button>`,
      ),
    )}
    ${card(
      'Spending limits',
      postForm(
        '/settings/simple/limits',
        html`<div class="row">
            ${field('Per video (₹)', 'sessionBudgetInr', cloud.sessionBudgetInr, {
              type: 'number',
              help: 'The GPU is stopped when one video reaches this amount.',
            })}
            ${field('Per day (₹)', 'dailyInr', budget.dailyInr, { type: 'number' })}
            ${field('Per month (₹)', 'monthlyInr', budget.monthlyInr, { type: 'number' })}
          </div>
          <button class="primary">Save limits</button>`,
      ),
    )}
    ${card(
      'More',
      html`<ul>
        ${(
          [
            ['/publish/youtube', 'YouTube connection and publishing schedule →'],
            ['/settings/storage', 'AI storage location →'],
            ['/settings/advanced', 'Advanced settings →'],
          ] as const
        )
          .filter(([href]) => r.match('GET', href))
          .map(([href, label]) => html`<li><a href="${href}">${label}</a></li>`)}
      </ul>`,
    )}`;
    return web.render(req, 'Settings', '/settings', body);
  });

  r.post('/settings/simple/defaults', (req) => {
    const f = req.form;
    const a = s.settings.get('app');
    s.settings.set('app', {
      ...a,
      defaultStyle: f['defaultStyle'],
      defaultLength: f['defaultLength'],
      customMinutes: f['customMinutes'],
      makeEpisode: yes(f['makeEpisode']),
      makeShorts: yes(f['makeShorts']),
      shortsCount: f['shortsCount'],
      narrator: f['narrator'],
      language: f['language'],
      backgroundMusic: f['backgroundMusic'],
      burnShortsCaptions: yes(f['burnShortsCaptions']),
    });
    return web.redirect('/settings', 'Saved.');
  });
  r.post('/settings/simple/limits', (req) => {
    const f = req.form;
    s.settings.set('cloud', { ...s.settings.get('cloud'), sessionBudgetInr: f['sessionBudgetInr'] });
    s.settings.set('budget', {
      ...s.settings.get('budget'),
      dailyInr: f['dailyInr'],
      monthlyInr: f['monthlyInr'],
    });
    s.logger.info('spending limits changed', {});
    return web.redirect('/settings', 'Spending limits saved.');
  });
}

/** READY ✓ or Needs Attention, each problem with its one fix. */
export function engineCard(st: EngineStatus, withLink = true): SafeHtml {
  const fix = (i: EngineStatus['issues'][number]): SafeHtml =>
    i.action === 'switch-to-real'
      ? button('/settings/ai-engine/switch-to-real', i.fix, {}, { kind: 'primary' })
      : i.action === 'turn-on'
        ? button('/settings/ai-engine/turn-on', i.fix, {}, { kind: 'primary' })
        : html`<a class="btn" href="${i.href}">${i.fix}</a>`;
  return card(
    'AI Engine',
    st.state === 'READY'
      ? html`<p class="engine ready"><strong>READY ✓</strong> ${st.headline}</p>
          ${withLink ? html`<p class="muted"><a href="/settings/ai-engine">AI Engine settings</a></p>` : ''}`
      : html`<p class="engine attention">
            <strong>${st.state === 'DEVELOPER_TEST_MODE' ? 'Developer test mode' : 'Needs attention'}</strong>
            ${st.headline}
          </p>
          <ul class="issues">
            ${st.issues.map((i) => html`<li>${i.message} ${fix(i)}</li>`)}
          </ul>`,
  );
}

const STATUS_LABEL: Record<Video['status'], string> = {
  draft: 'Draft',
  plan_review: 'Review plan',
  generating: 'Generating',
  needs_attention: 'Needs Attention',
  ready: 'Ready',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function videoStatusBadge(v: Video): SafeHtml {
  const kind =
    v.status === 'ready' || v.status === 'approved' || v.status === 'published' || v.status === 'scheduled'
      ? 'good'
      : v.status === 'needs_attention' || v.status === 'failed'
        ? 'bad'
        : v.status === 'generating'
          ? 'warn'
          : 'neutral';
  return html`<span class="badge ${kind}">${STATUS_LABEL[v.status]}</span>`;
}

function duration(sec: number | null | undefined): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const ss = Math.round(sec % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** A video on Home / My Videos: thumbnail, title, duration, status, date and the main actions. */
export function videoCard(web: Web, v: Video): SafeHtml {
  const s = web.studio;
  const exp = v.episode_export_id ? s.reports.getExport(v.episode_export_id) : null;
  const master = exp?.master_asset_id ? s.assets.get(exp.master_asset_id) : null;
  const done = ['ready', 'approved', 'scheduled', 'published'].includes(v.status);
  return html`<article class="video-card">
    <a href="/videos/${v.id}" class="thumb"
      >${v.thumbnail_key
        ? html`<img src="${mediaUrl(v.thumbnail_key)}" alt="" loading="lazy" />`
        : html`<span class="nothumb">${VIDEO_STYLES.find((x) => x.id === v.style_id)?.label ?? ''}</span>`}</a
    >
    <div class="meta">
      <h3><a href="/videos/${v.id}">${v.title}</a></h3>
      <p>
        ${videoStatusBadge(v)} · ${duration(exp?.duration_sec ?? null)} · ${when(v.created_at).slice(0, 10)}
      </p>
      ${v.status === 'generating' ? html`<p class="muted">${v.stage_detail || v.stage}</p>` : ''}
      <p class="actions">
        ${done && master ? html`<a href="${mediaUrl(master.storage_key)}">Play</a>` : ''}
        <a href="/videos/${v.id}">${done ? 'Review' : 'Open'}</a>
        ${v.story_id ? html`<a href="/videos/${v.id}/edit">Edit</a>` : ''}
        ${done && master ? html`<a href="${mediaUrl(master.storage_key)}" download>Download</a>` : ''}
        ${done ? html`<a href="/publish/${v.id}">Publish</a>` : ''}
      </p>
    </div>
  </article>`;
}

export function errorText(err: unknown): string {
  return toAppError(err).message;
}

function resultKind(st: string): string {
  return st === 'PASS'
    ? 'good'
    : st === 'FAIL'
      ? 'bad'
      : st === 'BLOCKED' || st === 'RUNNING'
        ? 'warn'
        : 'neutral';
}

/** The latest Real Mode Test and the button to run one. */
function realTestCard(web: Web): SafeHtml {
  const s = web.studio;
  const last = s.realTest.latest();
  const ready = s.engine.status().state === 'READY';
  return card(
    'Real Mode Test (milestone 1)',
    html`<p>
        Proves the whole chain on a real RunPod GPU: one real picture, animated by AI, with real narration,
        combined into a short MP4 that is checked and played. It rents a GPU for a few minutes (the price is
        shown before anything is rented).
      </p>
      ${last
        ? html`<p>
            Last run ${when(last.started_at)}:
            <span
              class="badge ${last.status === 'success' ? 'good' : last.status === 'running' ? 'warn' : 'bad'}"
              >${last.status === 'success' ? 'PASS' : last.status.toUpperCase()}</span
            >
            ${last.steps.filter((x) => x.status === 'PASS').length}/${last.steps.length} steps passed ·
            <a href="/settings/ai-engine/real-test/${last.id}">details</a>
          </p>`
        : html`<p class="muted">Not run yet: every real-AI step is NOT TESTED until this runs.</p>`}
      ${ready
        ? button('/settings/ai-engine/real-test', 'RUN REAL MODE TEST', {}, { kind: 'primary' })
        : html`<p class="muted">Connect RunPod first (above).</p>`}`,
  );
}
