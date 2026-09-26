import { AppError, toAppError } from '../../lib/errors.ts';
import { runHealthCheck } from '../../services/system-health.ts';
import { storageOverview } from '../../services/storage-location.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { raw } from '../html.ts';
import { button, card, field, html, postForm, select, type SafeHtml } from '../ui.ts';
import { engineCard } from './simple.ts';

/**
 * AI STORAGE LOCATION (Settings) and the FIRST-RUN SETUP WIZARD:
 *   1 Choose Storage · 2 Check Application Dependencies · 3 Connect RunPod · 4 Test AI Engine ·
 *   5 Configure Narrator · 6 Optional YouTube Connection · 7 READY
 * Everything happens in the browser; no Command Prompt.
 */
const STEPS = [
  'Choose Storage',
  'Check Application Dependencies',
  'Connect RunPod',
  'Test AI Engine',
  'Configure Narrator',
  'Optional YouTube Connection',
  'READY',
];

const gb = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Only a same-app path may be used as the place to come back to. */
const safeBack = (v: string | undefined, fallback: string): string =>
  v && /^\/[a-z0-9/_-]*(\?step=[1-7])?$/i.test(v) ? v : fallback;

export function registerSetupPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  // --- AI STORAGE LOCATION --------------------------------------------------------------------------

  const moveCard = (back: string): SafeHtml => {
    const st = s.storageMover.state;
    if (st?.state === 'copying')
      return card(
        'Changing the storage location',
        html`${raw('<meta http-equiv="refresh" content="3" />')}
          <p class="big">Copying to ${st.to} … (about ${gb(st.totalBytes)})</p>
          <p class="muted">Keep AI Story Studio open. This page refreshes by itself.</p>`,
      );
    if (st?.state === 'done')
      return card(
        'Storage location changed',
        html`<p class="big good">Copied to ${st.to} ✓</p>
          <p>
            <strong>Close AI Story Studio and start it again</strong> to use the new folder. The old folder
            (${st.from}) was not deleted: after checking that everything is there, you can delete it yourself.
          </p>`,
      );
    return card(
      'Use a different folder',
      html`${st?.state === 'failed' ? html`<p class="flash error">The copy failed: ${st.error}</p>` : ''}
      ${postForm(
        '/settings/storage/move',
        html`<input type="hidden" name="back" value="${back}" />
          ${field('New AI storage location', 'path', '', {
            required: true,
            placeholder: 'D:\\AI-Story-Studio-Data',
            help: 'A new or empty folder, e.g. on a drive with plenty of free space.',
          })}
          <label class="check"
            ><input type="checkbox" name="understood" value="true" required /> Copy everything there. I will
            restart AI Story Studio afterwards. The old folder is kept.</label
          >
          <button class="primary">Copy and use this folder</button>`,
      )}`,
    );
  };

  const overviewCard = (): SafeHtml => {
    const o = storageOverview(s);
    return card(
      'AI storage location',
      html`<p class="big">${o.location}</p>
        <p class="muted">
          ${o.freeGb !== null ? `${o.freeGb.toFixed(1)} GB free on this drive. ` : ''}Everything AI Story
          Studio makes is organised inside this folder. Projects, character pictures and finished videos are
          never deleted without you asking.
        </p>
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>Size</th>
              <th>Folder</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${o.areas.map(
              (a) =>
                html`<tr>
                  <td>${a.label}</td>
                  <td>${gb(a.bytes)}</td>
                  <td><code>${a.folder}</code></td>
                  <td class="muted">${a.note}</td>
                </tr>`,
            )}
          </tbody>
        </table>`,
    );
  };

  r.get('/settings/storage', (req) => {
    const body = html`${overviewCard()} ${moveCard('/settings/storage')}`;
    return web.render(req, 'AI Storage Location', '/settings', body);
  });

  r.post('/settings/storage/move', (req) => {
    const back = safeBack(req.form['back'], '/settings/storage');
    if (!yes(req.form['understood']))
      throw new AppError('VALIDATION_FAILED', 'Tick the box to confirm the copy and the restart.');
    s.storageMover.start(req.form['path'] ?? '');
    return web.redirect(back, 'Copying started.');
  });

  // --- FIRST-RUN SETUP WIZARD -----------------------------------------------------------------------

  const stepper = (n: number): SafeHtml =>
    html`<ol class="wizard-steps">
      ${STEPS.map(
        (label, i) =>
          html`<li class="${i + 1 === n ? 'current' : i + 1 < n ? 'done' : ''}">
            <a href="/welcome?step=${i + 1}">${label}</a>
          </li>`,
      )}
    </ol>`;

  const nav = (n: number, nextLabel = 'Next →'): SafeHtml =>
    html`<div class="actions wizard-nav">
      ${n > 1 ? html`<a class="btn" href="/welcome?step=${n - 1}">← Back</a>` : ''}
      ${n < STEPS.length ? html`<a class="btn primary" href="/welcome?step=${n + 1}">${nextLabel}</a>` : ''}
    </div>`;

  const channel = (): string | null => {
    const v = s.db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = 'youtube.channel'")?.value;
    try {
      return v ? (JSON.parse(v) as { title: string }).title : null;
    } catch {
      return null;
    }
  };

  r.get('/welcome', async (req) => {
    const n = Math.min(STEPS.length, Math.max(1, Number(req.query.get('step')) || 1));
    const engine = s.engine.status();
    const a = s.settings.get('app');
    let step: SafeHtml;
    if (n === 1) {
      step = html`${overviewCard()} ${moveCard('/welcome?step=1')}
      ${s.storageMover.state?.state === 'done' ? '' : nav(1, 'Keep this location →')}`;
    } else if (n === 2) {
      const report = await runHealthCheck(s);
      const wanted = ['node', 'ffmpeg', 'database', 'folders'];
      const checks = report.checks.filter((c) => wanted.includes(c.key));
      const secrets = s.secrets.protection;
      const rows = [
        ...checks.map((c) => ({ ok: c.level === 'ok', label: c.label, detail: c.detail, fix: c.fix })),
        {
          ok: true,
          label: 'Secret storage',
          detail:
            secrets === 'dpapi'
              ? 'Windows data protection (keys are encrypted for your Windows account)'
              : 'encrypted file key (readable only by your user account)',
          fix: undefined,
        },
      ];
      const bad = rows.filter((x) => !x.ok).length;
      step = card(
        'Application dependencies',
        html`<ul class="checks">
            ${rows.map(
              (x) =>
                html`<li>
                  <span class="badge ${x.ok ? 'good' : 'bad'}">${x.ok ? 'OK' : 'MISSING'}</span>
                  <strong>${x.label}</strong> — ${x.detail}
                  ${x.fix ? html`<br /><small>${x.fix}</small>` : ''}
                </li>`,
            )}
          </ul>
          <p class="muted">
            The AI models run on RunPod GPUs, so this computer needs no NVIDIA GPU, Python or CUDA.
            ${bad
              ? 'Fix the items marked MISSING (running the AI Story Studio setup program again installs them), then reload this page.'
              : 'Everything needed is installed.'}
          </p>
          ${nav(2)}`,
      );
    } else if (n === 3) {
      const connected = s.secrets.source('runpodApiKey') !== 'none';
      step = card(
        'Connect RunPod',
        html`<p>
            RunPod rents the GPU that runs the AI models, only while a video is being made. You pay RunPod
            directly; the spending limits in Settings stop the GPU at your limit.
            <a href="/docs/runpod-setup">How to get a RunPod API key →</a>
          </p>
          ${connected
            ? html`<p class="big good">RunPod key saved ✓</p>
                <p class="muted">Replace it on the AI Engine page if needed.</p>`
            : postForm(
                '/welcome/runpod',
                html`<label class="field"
                    ><span>RunPod API key</span
                    ><input type="password" name="api_key" autocomplete="off" required /><small
                      >Stored encrypted on this computer, never shown again, never logged.</small
                    ></label
                  >
                  <button class="primary">Save and test</button>`,
              )}
          ${nav(3, connected ? 'Next →' : 'Skip for now →')}`,
      );
    } else if (n === 4) {
      step = html`${engineCard(engine, false)}
      ${card(
        'Test the AI Engine',
        html`<p>
            Checks that RunPod accepts the key and that the AI worker image can be used (no GPU is rented).
          </p>
          ${button('/welcome/test', 'TEST AI ENGINE', {}, { kind: 'primary' })}
          <p class="muted">
            Optional, later: the <a href="/settings/ai-engine">Real Mode Test</a> makes one short real clip on
            a RunPod GPU (costs a few rupees) to prove the whole chain.
          </p>
          ${nav(4)}`,
      )}`;
    } else if (n === 5) {
      step = card(
        'Narrator',
        postForm(
          '/welcome/narrator',
          html`<div class="row">
              ${select(
                'Narrator voice',
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
            <p class="muted">Voices are AI voices; no real person's voice is copied.</p>
            <button class="primary">Save and continue →</button>`,
        ),
      );
    } else if (n === 6) {
      const yt = s.publisher.yt;
      step = card(
        'YouTube (optional)',
        html`${yt.connected()
          ? html`<p class="big good">YOUTUBE CONNECTED ✓${channel() ? ` — ${channel()}` : ''}</p>`
          : html`<p>
                Connect your YouTube channel to upload finished videos after you review them. Nothing is ever
                uploaded without your approval. You can do this later in PUBLISH.
              </p>
              <p><a class="btn" href="/publish/youtube">Set up YouTube →</a></p>`}
        ${nav(6, yt.connected() ? 'Next →' : 'Skip for now →')}`,
      );
    } else {
      const deps = await runHealthCheck(s);
      const depsOk = deps.checks
        .filter((c) => ['node', 'ffmpeg', 'database', 'folders'].includes(c.key))
        .every((c) => c.level === 'ok');
      const row = (ok: boolean, label: string, detail: string, stepNo: number): SafeHtml =>
        html`<li>
          <span class="badge ${ok ? 'good' : 'warn'}">${ok ? '✓' : '!'}</span> <strong>${label}</strong> —
          ${detail} ${ok ? '' : html`<a href="/welcome?step=${stepNo}">fix</a>`}
        </li>`;
      step = card(
        'READY',
        html`<ul class="checks">
            ${row(true, 'Storage', s.env.dataDir, 1)}
            ${row(depsOk, 'Dependencies', depsOk ? 'installed' : 'something is missing', 2)}
            ${row(
              engine.state === 'READY',
              'AI Engine',
              engine.state === 'READY'
                ? engine.engine === 'runpod'
                  ? 'RUNPOD READY ✓'
                  : 'READY ✓'
                : engine.headline,
              engine.state === 'READY' ? 4 : 3,
            )}
            ${row(true, 'Narrator', `${a.narrator} voice, ${a.language}`, 5)}
            ${row(
              true,
              'YouTube',
              s.publisher.yt.connected()
                ? `connected${channel() ? ` — ${channel()}` : ''}`
                : 'not connected (optional)',
              6,
            )}
          </ul>
          ${postForm(
            '/welcome/finish',
            html`<button class="primary huge">
              ${engine.state === 'READY' ? 'FINISH — CREATE MY FIRST VIDEO' : 'FINISH SETUP'}
            </button>`,
          )}
          ${nav(7)}`,
      );
    }
    const body = html`<p class="subtitle">WELCOME TO AI STORY STUDIO</p>
      ${stepper(n)}
      <h2>Step ${n} of ${STEPS.length}: ${STEPS[n - 1]}</h2>
      ${step}
      ${n < STEPS.length
        ? postForm('/welcome/skip', html`<button class="ghost">Skip setup for now</button>`)
        : ''}`;
    return web.render(req, 'Welcome', '/', body);
  });

  r.post('/welcome/runpod', async (req) => {
    const key = (req.form['api_key'] ?? '').trim();
    if (!key) throw new AppError('VALIDATION_FAILED', 'Paste your RunPod API key first.');
    try {
      const t = await s.engine.connect(key);
      return web.redirect(
        '/welcome?step=4',
        `RUNPOD CONNECTED ✓ — the key is saved (encrypted).${t.imageOk ? '' : ` Still needed: ${t.imageDetail}`}`,
      );
    } catch (err) {
      return web.redirect('/welcome?step=3', undefined, toAppError(err).message);
    }
  });
  r.post('/welcome/test', async () => {
    const t = await s.engine.retest();
    return t.ok
      ? web.redirect('/welcome?step=4', 'Connection OK — RunPod accepted the saved key.')
      : web.redirect('/welcome?step=4', undefined, `Test failed: ${t.detail}`);
  });
  r.post('/welcome/narrator', (req) => {
    const f = req.form;
    s.settings.set('app', {
      ...s.settings.get('app'),
      narrator: f['narrator'],
      language: f['language'],
      backgroundMusic: f['backgroundMusic'],
    });
    return web.redirect('/welcome?step=6', 'Narrator saved.');
  });
  const finish = (): void => {
    s.settings.set('app', { ...s.settings.get('app'), firstRunComplete: true });
  };
  r.post('/welcome/finish', () => {
    finish();
    return s.engine.status().state === 'READY'
      ? web.redirect('/create', 'Setup complete. Describe your first story.')
      : web.redirect('/', 'Setup saved. The AI Engine still needs attention before videos can be made.');
  });
  r.post('/welcome/skip', () => {
    finish();
    return web.redirect('/', 'Setup skipped. Settings has everything when you need it.');
  });
}
