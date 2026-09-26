import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, toAppError } from '../../lib/errors.ts';
import type { DiagnosticStep } from '../../services/cloud.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { html, raw, type SafeHtml } from '../html.ts';
import { badge, button, card, checkbox, field, kv, postForm, select, table, when } from '../ui.ts';

function gateTable(web: Web): SafeHtml {
  return html`<table class="gates">
    <tbody>
      ${web.studio.cloud.gates().map(
        (g) =>
          html`<tr>
            <td>${g.ok ? badge('ok', 'good') : badge('off', 'warn')}</td>
            <td>${g.name}</td>
            <td class="muted">${g.detail}</td>
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function minutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m} min ${sec % 60} s`;
}

function stepList(steps: Array<{ n: number; name: string; status: string; detail: string }>): SafeHtml {
  return html`<ol class="steps">
    ${steps.map(
      (s) =>
        html`<li class="${s.status}">
          <strong>${s.name}</strong> ${badge(s.status)}
          ${s.detail ? html`<span class="muted">${s.detail}</span>` : ''}
        </li>`,
    )}
  </ol>`;
}

let lastDiagnostics: { at: string; steps: DiagnosticStep[] } | null = null;

/** Settings → AI / Generation → Cloud GPU, the guided first GPU test, and Logs. */
export function registerCloudPages(web: Web): void {
  const { router: r, studio: s } = web;

  r.get('/cloud', (req) => {
    const st = s.cloud.status();
    const cloud = s.settings.get('cloud');
    const gpu = s.settings.get('gpu');
    const models = s.models.states();
    const inst = st.instance;
    const l = st.limits;
    const cap = (name: string) => (l.cappedBy.includes(name) ? ' (capped by .env)' : '');
    return web.render(
      req,
      'Cloud GPU',
      '/cloud',
      html`<p class="muted">
          Settings → AI / Generation → Cloud GPU. You never need an NVIDIA GPU on this PC: heavy generation
          rents a temporary GPU, the studio sends the work, downloads and checks the results, and terminates
          the GPU. See <code>docs/RUNPOD_SETUP.md</code>.
        </p>
        ${card(
          'Mode and safety gates',
          html`<p>
              Current mode: <strong>${st.modeLabel}</strong>. Real cloud generation needs <em>every</em> gate
              below. The two .env gates are edited in the <code>.env</code> file (then restart the app).
            </p>
            ${gateTable(web)}`,
        )}
        ${card(
          'Status',
          html`${kv([
              [
                'Provider',
                st.provider === 'runpod' ? 'RunPod (REST API v2)' : `${st.provider} (not supported yet)`,
              ],
              [
                'Connection',
                st.connection
                  ? html`${st.connection.ok ? badge('ok', 'good') : badge('failed', 'bad')}
                      <span class="muted">${st.connection.detail} (${when(st.connection.at)})</span>`
                  : 'not tested yet',
              ],
              [
                'GPU status',
                inst
                  ? badge(inst.state, inst.state === 'FAILED' ? 'bad' : 'warn')
                  : badge('no GPU running', 'good'),
              ],
              ['GPU model', inst ? inst.gpu : '—'],
              ['VRAM', inst ? `${inst.vramGb} GB` : '—'],
              ['Instance ID', inst ? inst.podId : '—'],
              ['Runtime', inst ? minutes(inst.runtimeSec) : '—'],
              [
                'Estimated cost',
                inst
                  ? `₹${inst.spentInr.toFixed(2)} at ₹${inst.hourlyRateInr}/h${inst.sessionBudgetInr ? ` (session budget ₹${inst.sessionBudgetInr})` : ''}`
                  : '—',
              ],
              [
                'Worker health',
                inst ? (inst.workerHealthy ? badge('healthy', 'good') : badge('not connected', 'warn')) : '—',
              ],
            ])}
            <div class="row">
              ${button('/cloud/test-connection', 'Test Connection')}
              <a class="button" href="/cloud/test">Start Test GPU…</a>
              ${button('/cloud/stop', 'Stop GPU', {}, { confirm: 'Terminate the running cloud GPU now?' })}
              ${button(
                '/cloud/emergency-stop',
                'EMERGENCY STOP',
                { confirm: 'STOP' },
                {
                  kind: 'danger',
                  confirm: 'EMERGENCY STOP: terminate every cloud GPU this AI Story Studio created?',
                },
              )}
              ${button('/cloud/diagnostics', 'Run dry-run diagnostics (free)')}
            </div>
            ${st.recovery &&
            (st.recovery.terminated.length || st.recovery.reattachable.length || st.recovery.warnings.length)
              ? html`<p class="muted">
                  Start-up recovery (${when(st.recovery.at)}): ${st.recovery.jobsRecovered} job(s) requeued ·
                  ${st.recovery.terminated.length} leftover GPU(s) terminated ·
                  ${st.recovery.reattachable.length} kept
                  ${st.recovery.warnings.map((w) => html`<br />⚠ ${w}`)}
                </p>`
              : ''}`,
        )}
        ${lastDiagnostics
          ? card(
              `Dry-run diagnostics (${when(lastDiagnostics.at)}) — nothing was rented`,
              table(
                ['', 'Check', 'Result'],
                lastDiagnostics.steps.map((d) => [
                  d.ok === true
                    ? badge('ok', 'good')
                    : d.ok === false
                      ? badge('fail', 'bad')
                      : badge('note', 'warn'),
                  d.step,
                  d.detail,
                ]),
              ),
            )
          : ''}
        ${card(
          'Provider and API key',
          html`${postForm(
            '/cloud/key',
            html`<div class="row">
                ${select(
                  'Provider',
                  'provider',
                  [
                    ['runpod', 'RunPod'],
                    ['vast', 'Vast.ai (not supported yet)'],
                    ['tensordock', 'TensorDock (not supported yet)'],
                  ],
                  cloud.provider,
                )}
                <label class="field"
                  ><span>API key (stored on this PC only; never shown again)</span
                  ><input type="password" name="api_key" autocomplete="off" placeholder="${st.apiKey}"
                /></label>
              </div>
              <p class="muted">
                Current key: ${st.apiKey}${st.apiKeySource === 'env' ? ' (from .env — change it there)' : ''}.
              </p>
              <button class="primary">Save</button>`,
          )}
          ${st.apiKeySource === 'store'
            ? button('/cloud/key/delete', 'Remove saved key', {}, { confirm: 'Remove the saved API key?' })
            : ''}`,
        )}
        ${card(
          'Switches',
          postForm(
            '/cloud/switches',
            html`${checkbox(
                'Cloud GPU enabled',
                'cloudEnabled',
                cloud.cloudEnabled,
                'Allows renting a GPU (test GPU, generation). Also needs MOCK_GENERATION=false and ENABLE_CLOUD_GPU=true in .env.',
              )}
              ${checkbox(
                'Real generation enabled',
                'realGeneration',
                cloud.realGeneration,
                'Project generation uses real AI models on the cloud GPU and costs money. Off = mock placeholders.',
              )} <button class="primary">Save switches</button>`,
            { confirm: 'Save the Cloud GPU / Real generation switches?' },
          ),
        )}
        ${card(
          'Cost protection',
          postForm(
            '/cloud/limits',
            html`<p class="muted">
                In force now: max ₹${l.maxHourlyRateInr}/h${cap('MAX_GPU_HOURLY_RATE')} · session budget
                ₹${l.sessionBudgetInr}${cap('SESSION_BUDGET')} · idle shutdown ${l.idleMinutes}
                min${cap('IDLE_SHUTDOWN_MINUTES')} · max lifetime ${l.maxLifetimeMinutes}
                min${cap('MAX_GPU_LIFETIME_MINUTES')} · ${l.maxConcurrent} GPU at a
                time${cap('MAX_CONCURRENT_GPU_INSTANCES')}. Values in .env are hard caps these settings cannot
                exceed.
              </p>
              <div class="row">
                ${field('Maximum hourly GPU price (₹/h)', 'maxHourlyRateInr', gpu.maxHourlyRateInr, {
                  type: 'number',
                  step: '1',
                })}
                ${field('Maximum session budget (₹)', 'sessionBudgetInr', cloud.sessionBudgetInr, {
                  type: 'number',
                  step: '1',
                })}
                ${field('Idle shutdown (minutes)', 'idleTimeoutMinutes', gpu.idleTimeoutMinutes, {
                  type: 'number',
                  step: '1',
                })}
                ${field('Maximum GPU lifetime (minutes)', 'maxLifetimeMinutes', gpu.maxLifetimeMinutes, {
                  type: 'number',
                  step: '1',
                })}
                ${field('Maximum concurrent GPUs', 'maxConcurrentInstances', cloud.maxConcurrentInstances, {
                  type: 'number',
                  step: '1',
                })}
              </div>
              <div class="row">
                ${select(
                  'When generation finishes',
                  'autoTerminate',
                  [
                    ['after_batch', 'Terminate the GPU immediately (recommended)'],
                    ['idle_timeout', 'Keep it warm until the idle shutdown'],
                  ],
                  cloud.autoTerminate,
                )}
                ${field(
                  'Worker start-up timeout (minutes)',
                  'workerStartTimeoutMinutes',
                  cloud.workerStartTimeoutMinutes,
                  {
                    type: 'number',
                    step: '1',
                  },
                )}
                ${field('USD → ₹ rate (RunPod prices are in USD)', 'usdToInr', cloud.usdToInr, {
                  type: 'number',
                  step: '0.5',
                })}
              </div>
              <button class="primary">Save cost protection</button>`,
          ),
        )}
        ${card(
          'Models (cloud)',
          html`<p class="muted">
              Models are chosen for commercial use. A conditional licence must be read and acknowledged before
              the model can run. "Cached" is only known while a GPU is running.
            </p>
            ${table(
              ['Type', 'Model', 'Licence', 'VRAM min / rec.', 'Precision', 'Storage', 'Cached', 'State', ''],
              models.map((m) => [
                m.type,
                html`${m.name}${m.isDefault ? html` <small>(default)</small>` : ''}`,
                html`${m.licenseUrl.startsWith('https://')
                  ? html`<a href="${m.licenseUrl}" rel="noreferrer noopener">${m.license}</a>`
                  : m.license}
                ${badge(m.commercialUse, m.commercialUse === 'allowed' ? 'good' : 'warn')}`,
                `${m.minVramGb} / ${m.recommendedVramGb} GB`,
                m.precision,
                `${m.storageGb} GB`,
                m.cached === null ? '—' : m.cached ? 'yes' : 'no',
                m.usable ? badge('usable', 'good') : badge(m.blockedReason ?? 'blocked', 'warn'),
                html`${button(`/cloud/models/${m.id}/enable`, m.enabled ? 'Disable' : 'Enable', {
                  enabled: m.enabled ? 'false' : 'true',
                })}
                ${m.commercialUse === 'conditional'
                  ? button(
                      `/cloud/models/${m.id}/license`,
                      m.licenseAcknowledged
                        ? 'Withdraw licence acknowledgement'
                        : 'I have read and accept the licence',
                      { acknowledged: m.licenseAcknowledged ? 'false' : 'true' },
                      m.licenseAcknowledged
                        ? {}
                        : {
                            confirm: `${m.name}: ${m.licenseNotes || m.license}. Do you accept these conditions?`,
                          },
                    )
                  : ''}`,
              ]),
            )}`,
        )}
        ${card(
          'Advanced',
          postForm(
            '/cloud/advanced',
            html`<div class="row">
                ${field('Worker image', 'workerImage', cloud.workerImage, {
                  help: s.env.cloudWorkerImage
                    ? `Overridden by CLOUD_WORKER_IMAGE in .env: ${s.env.cloudWorkerImage}`
                    : '',
                })}
                ${field(
                  'Registry credential id (only for a private image)',
                  'registryAuthId',
                  cloud.registryAuthId,
                )}
              </div>
              <div class="row">
                ${select(
                  'RunPod cloud',
                  'cloudType',
                  [
                    ['SECURE', 'Secure Cloud (recommended)'],
                    ['COMMUNITY', 'Community Cloud (cheaper)'],
                  ],
                  cloud.cloudType,
                )}
                ${field(
                  'Allowed GPU type ids (comma-separated, empty = any)',
                  'allowedGpuTypes',
                  cloud.allowedGpuTypes,
                )}
              </div>
              <div class="row">
                ${field(
                  'Network volume id (keeps model downloads between sessions)',
                  'networkVolumeId',
                  cloud.networkVolumeId,
                )}
                ${field('Pod volume (GB, deleted with the GPU)', 'volumeGb', cloud.volumeGb, {
                  type: 'number',
                })}
                ${field('Container disk (GB)', 'containerDiskGb', cloud.containerDiskGb, { type: 'number' })}
              </div>
              <button class="primary">Save advanced settings</button>`,
          ),
        )}
        <p><a href="/gpu">GPU history, costs and watchdog →</a> · <a href="/logs">Logs →</a></p>`,
    );
  });

  const refreshAfter = (msg: string): ReturnType<Web['redirect']> => {
    try {
      s.cloud.refresh();
      return web.redirect('/cloud', `${msg} Mode: ${s.cloud.modeLabel()}.`);
    } catch (err) {
      return web.redirect('/cloud', undefined, `${msg} ${toAppError(err).message}`);
    }
  };

  r.post('/cloud/key', (req) => {
    const provider = req.form['provider'] ?? 'runpod';
    s.settings.set('cloud', { ...s.settings.get('cloud'), provider });
    const key = (req.form['api_key'] ?? '').trim();
    if (key) {
      s.secrets.set('runpodApiKey', key);
      s.engine.forgetTest();
    }
    s.logger.info('cloud provider settings saved', { provider, keyChanged: Boolean(key) });
    return refreshAfter(key ? 'API key saved (stored on this PC only).' : 'Provider saved.');
  });
  r.post('/cloud/key/delete', () => {
    if (s.cloud.activeInstance())
      throw new AppError('CONFLICT', 'Stop the running GPU before removing the key.');
    s.secrets.delete('runpodApiKey');
    s.engine.forgetTest();
    return refreshAfter('Saved API key removed.');
  });
  r.post('/cloud/test-connection', async () => {
    const t = await s.cloud.testConnection();
    return t.ok ? web.redirect('/cloud', t.detail) : web.redirect('/cloud', undefined, t.detail);
  });
  r.post('/cloud/switches', async (req) => {
    const cloudEnabled = yes(req.form['cloudEnabled']);
    const realGeneration = yes(req.form['realGeneration']);
    s.settings.set('cloud', { ...s.settings.get('cloud'), cloudEnabled, realGeneration });
    // Switching the Cloud GPU on chooses CLOUD GPU as the execution mode; switching it off returns to MOCK.
    const ex = s.settings.get('execution');
    if (cloudEnabled && ex.mode !== 'cloud_gpu') s.settings.set('execution', { ...ex, mode: 'cloud_gpu' });
    if (!cloudEnabled && ex.mode === 'cloud_gpu') s.settings.set('execution', { ...ex, mode: 'mock' });
    s.logger.warn('cloud switches changed', {
      cloudEnabled,
      realGeneration,
      executionMode: s.settings.get('execution').mode,
    });
    try {
      await s.router.apply();
      return web.redirect('/cloud', `Switches saved. Mode: ${s.cloud.modeLabel()}.`);
    } catch (err) {
      return web.redirect('/cloud', undefined, `Switches saved. ${toAppError(err).message}`);
    }
  });
  r.post('/cloud/limits', (req) => {
    const f = req.form;
    s.settings.set('gpu', {
      ...s.settings.get('gpu'),
      maxHourlyRateInr: f['maxHourlyRateInr'],
      idleTimeoutMinutes: f['idleTimeoutMinutes'],
      maxLifetimeMinutes: f['maxLifetimeMinutes'],
    });
    s.settings.set('cloud', {
      ...s.settings.get('cloud'),
      sessionBudgetInr: f['sessionBudgetInr'],
      maxConcurrentInstances: f['maxConcurrentInstances'],
      autoTerminate: f['autoTerminate'],
      workerStartTimeoutMinutes: f['workerStartTimeoutMinutes'],
      usdToInr: f['usdToInr'],
    });
    return web.redirect('/cloud', 'Cost protection saved.');
  });
  r.post('/cloud/advanced', (req) => {
    const f = req.form;
    s.settings.set('cloud', {
      ...s.settings.get('cloud'),
      workerImage: f['workerImage'],
      registryAuthId: f['registryAuthId'] ?? '',
      cloudType: f['cloudType'],
      allowedGpuTypes: f['allowedGpuTypes'] ?? '',
      networkVolumeId: f['networkVolumeId'] ?? '',
      volumeGb: f['volumeGb'],
      containerDiskGb: f['containerDiskGb'],
    });
    return web.redirect('/cloud', 'Advanced settings saved.');
  });
  r.post('/cloud/models/:id/enable', (req) => {
    s.models.setEnabled(req.params['id']!, yes(req.form['enabled']));
    return web.redirect('/cloud', 'Model selection saved (applies to the next GPU session).');
  });
  r.post('/cloud/models/:id/license', (req) => {
    s.models.acknowledgeLicense(req.params['id']!, yes(req.form['acknowledged']));
    s.logger.info('model licence acknowledgement changed', {
      model: req.params['id'],
      acknowledged: yes(req.form['acknowledged']),
    });
    return web.redirect('/cloud', 'Licence acknowledgement saved.');
  });
  r.post('/cloud/stop', async () => {
    const n = await s.cloud.stopGpu();
    return web.redirect('/cloud', n ? `${n} GPU(s) terminated.` : 'No cloud GPU was running.');
  });
  r.post('/cloud/emergency-stop', async (req) => {
    const res = await s.cloud.emergencyStop(req.form['confirm'] ?? '');
    const msg = `EMERGENCY STOP: ${res.terminated.length} GPU(s) terminated${res.failed.length ? `; FAILED: ${res.failed.join('; ')} — check the RunPod console` : ''}.`;
    return res.failed.length ? web.redirect('/cloud', undefined, msg) : web.redirect('/cloud', msg);
  });
  r.post('/cloud/diagnostics', async () => {
    lastDiagnostics = { at: new Date().toISOString(), steps: await s.cloud.diagnostics() };
    return web.redirect('/cloud', 'Dry-run diagnostics finished (nothing was rented).');
  });

  // --- guided first GPU test -------------------------------------------------------------
  r.get('/cloud/test', (req) => {
    const tests = s.cloudTest.list(10);
    return web.render(
      req,
      'First real GPU test',
      '/cloud',
      html`<p>
          A guided, low-cost test: validate the key, find a GPU and show its price, and only after you
          confirm, rent it, start the worker, generate <strong>one</strong> small asset, download and check
          it, and terminate the GPU. Do this before generating a full episode.
        </p>
        ${postForm(
          '/cloud/test/prepare',
          html`${select(
              'Test asset',
              'kind',
              [
                ['tts', 'One spoken sentence (Kokoro — smallest, fastest)'],
                ['image', 'One 512×512 image (FLUX.1 [schnell] — larger download)'],
              ],
              s.settings.get('cloud').testAsset,
            )}<button class="primary">Steps 1–3: check key, find GPU, show price (free)</button>`,
        )}
        ${card(
          'Previous tests',
          table(
            ['Started', 'Kind', 'Status', 'GPU', 'Runtime', 'Cost', ''],
            tests.map((t) => [
              when(t.started_at),
              t.test_kind,
              badge(t.status === 'success' ? 'ok' : t.status),
              t.gpu_model ?? '—',
              t.runtime_sec !== null ? `${t.runtime_sec} s` : '—',
              t.cost_inr !== null ? `₹${t.cost_inr.toFixed(2)}` : '—',
              html`<a href="/cloud/test/${t.id}">details</a>`,
            ]),
          ),
        )}`,
    );
  });
  r.post('/cloud/test/prepare', async (req) => {
    const kind = req.form['kind'] === 'image' ? 'image' : 'tts';
    const res = await s.cloudTest.prepare(kind);
    return web.redirect(`/cloud/test/${res.record.id}`);
  });
  r.get('/cloud/test/:id', (req) => {
    const t = s.cloudTest.get(req.params['id']!);
    const steps = s.cloudTest.steps(t);
    const waiting =
      t.status === 'running' && steps[3]?.status === 'running' && steps[4]?.status === 'pending';
    const live = t.status === 'running' && !waiting;
    return web.render(
      req,
      `GPU test ${t.status === 'success' ? 'SUCCESS' : t.status === 'failed' ? 'FAILURE' : t.status.toUpperCase()}`,
      '/cloud',
      html`${live ? raw('<meta http-equiv="refresh" content="3" />') : ''} ${stepList(steps)}
        ${waiting
          ? card(
              'Step 4 — confirm provisioning',
              html`<p>
                  ${t.gpu_model} at ₹${t.hourly_rate_inr}/h. The GPU is terminated automatically when the test
                  ends, fails or times out.
                </p>
                <div class="row">
                  ${button(
                    `/cloud/test/${t.id}/confirm`,
                    'Rent the GPU and run the test',
                    {},
                    {
                      kind: 'primary',
                      confirm: `Rent ${t.gpu_model} at ₹${t.hourly_rate_inr}/h for this test?`,
                    },
                  )}
                  ${button(`/cloud/test/${t.id}/cancel`, 'Cancel')}
                </div>`,
            )
          : ''}
        ${live ? html`<p class="muted">Running… this page refreshes every 3 seconds.</p>` : ''}
        ${t.status !== 'running'
          ? kv([
              [
                'Result',
                t.status === 'success' ? badge('SUCCESS', 'good') : badge(t.status.toUpperCase(), 'bad'),
              ],
              ['GPU used', t.gpu_model ?? '—'],
              ['Runtime', t.runtime_sec !== null ? `${t.runtime_sec} s` : '—'],
              ['Estimated cost', t.cost_inr !== null ? `₹${t.cost_inr.toFixed(2)}` : '—'],
              ['Output location', t.output_key ? s.storage.localPath(t.output_key) : '—'],
              ['Error', t.error_message ?? '—'],
            ])
          : ''}
        <p><a href="/cloud/test">← GPU tests</a> · <a href="/cloud">Cloud GPU settings</a></p>`,
    );
  });
  r.post('/cloud/test/:id/confirm', (req) => {
    const id = req.params['id']!;
    // Runs in the background; the page shows progress. The GPU is terminated in `finally`.
    s.cloudTest
      .confirm(id)
      .catch((err: unknown) => s.logger.error('cloud test failed', { error: toAppError(err).message }));
    return web.redirect(`/cloud/test/${id}`, 'Provisioning started.');
  });
  r.post('/cloud/test/:id/cancel', (req) => {
    s.cloudTest.cancel(req.params['id']!);
    return web.redirect(`/cloud/test/${req.params['id']}`, 'Cancelled.');
  });

  // --- logs ------------------------------------------------------------------------------------
  const logFile = () => join(s.env.dataDir, 'logs', 'studio.log');
  r.get('/logs', (req) => {
    const path = logFile();
    let lines: string[] = [];
    if (existsSync(path)) {
      const size = statSync(path).size;
      const text = readFileSync(path, 'utf8');
      lines = text
        .slice(Math.max(0, size - 400_000))
        .split('\n')
        .filter(Boolean)
        .slice(-300);
    }
    const level = req.query.get('level') ?? '';
    const rows = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { msg: l };
        }
      })
      .filter((x) => !level || x['level'] === level)
      .reverse();
    return web.render(
      req,
      'Logs',
      '/logs',
      html`<p class="muted">
          Structured log (newest first). API keys and worker tokens are redacted before anything is written.
          File:
          <code>${path}</code>
        </p>
        <div class="row">
          ${button('/logs/open', 'Open Logs folder')}
          <a class="button" href="/logs">All</a><a class="button" href="/logs?level=warn">Warnings</a
          ><a class="button" href="/logs?level=error">Errors</a>
        </div>
        ${table(
          ['Time', 'Level', 'Message', 'Details'],
          rows.slice(0, 300).map((x) => {
            const { ts, level: lv, msg, ...rest } = x;
            return [
              String(ts ?? ''),
              String(lv ?? ''),
              String(msg ?? ''),
              html`<code>${JSON.stringify(rest).slice(0, 400)}</code>`,
            ];
          }),
          'No log entries yet.',
        )}`,
    );
  });
  r.post('/logs/open', () => {
    const dir = join(s.env.dataDir, 'logs');
    // Local desktop app: open the folder in the file manager. Fixed program + argument, no shell.
    const [cmd, args] =
      process.platform === 'win32'
        ? ['explorer.exe', [dir]]
        : process.platform === 'darwin'
          ? ['open', [dir]]
          : ['xdg-open', [dir]];
    try {
      spawn(cmd, args as string[], { detached: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
    } catch {
      // Headless: the path is shown on the page.
    }
    return web.redirect('/logs', `Logs folder: ${dir}`);
  });
}
