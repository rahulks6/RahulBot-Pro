import { classify, GPU_STATE_LABEL, PROFILE_LABEL, type HardwareStatus } from '../../services/hardware.ts';
import { cleanup, diskUsage, type CleanupTarget } from '../../services/disk.ts';
import { planRuntime, type RuntimeKind } from '../../services/runtime-installer.ts';
import { join } from 'node:path';
import { appRoot } from '../../lib/paths.ts';
import { runHealthCheck, type HealthLevel } from '../../services/system-health.ts';
import type { Web } from '../app.ts';
import type { SafeHtml } from '../html.ts';
import { AppError } from '../../lib/errors.ts';
import { badge, button, card, html, kv, postForm, table } from '../ui.ts';

const LEVEL_BADGE: Record<HealthLevel, [string, string]> = {
  ok: ['OK', 'good'],
  warn: ['WARNING', 'warn'],
  fail: ['PROBLEM', 'bad'],
  unknown: ['NOT CHECKED', 'neutral'],
  info: ['INFO', 'neutral'],
};

const gbText = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/** "This computer" GPU card, shared by System Health and GPU & Costs. */
export function hardwareCard(hw: HardwareStatus, refreshHref: string): SafeHtml {
  const d = hw.device;
  const stateKind = hw.primary === 'GPU_READY' ? 'good' : hw.primary === 'NO_NVIDIA_GPU' ? 'neutral' : 'warn';
  return card(
    'This computer — GPU',
    html`<p>
        ${badge(GPU_STATE_LABEL[hw.primary], stateKind)}
        ${hw.states
          .filter((x) => x !== hw.primary)
          .map((x) => html` ${badge(GPU_STATE_LABEL[x], x === 'CLOUD_GPU_AVAILABLE' ? 'neutral' : 'warn')}`)}
      </p>
      ${d
        ? kv([
            ['GPU', d.name],
            ['Driver', hw.nvidia.driverVersion ?? '—'],
            ['CUDA (driver supports up to)', hw.nvidia.cudaDriverVersion ?? '—'],
            [
              'PyTorch',
              hw.torch
                ? hw.torch.installed
                  ? `${hw.torch.version ?? '?'} — ${hw.torch.cudaAvailable ? `CUDA ${hw.torch.cudaRuntime} OK` : 'CUDA NOT available'}`
                  : 'not installed'
                : 'not checked',
            ],
            ['VRAM total', gbText(d.vramTotalMb)],
            ['VRAM used', gbText(d.vramUsedMb)],
            ['VRAM free', gbText(d.vramFreeMb)],
            ['Usable by the studio', `${hw.usableVramGb} GB`],
            ['Profile', PROFILE_LABEL[hw.profile]],
            ['Utilization', d.utilizationPct === null ? 'not reported' : `${d.utilizationPct}%`],
            ['Temperature', d.temperatureC === null ? 'not reported' : `${d.temperatureC} °C`],
            ['Compute capability', d.computeCapability ?? '—'],
          ])
        : kv([
            ['GPU', 'none found'],
            ['Detail', hw.nvidia.error ?? '—'],
          ])}
      ${hw.notes.length
        ? html`<ul>
            ${hw.notes.map((n) => html`<li>${n}</li>`)}
          </ul>`
        : ''}
      <p class="muted">
        Checked ${hw.nvidia.checkedAt.replace('T', ' ').slice(0, 19)} UTC ·
        <a href="${refreshHref}">Refresh</a>
      </p>`,
  );
}

/** Local worker (LOCAL GPU): state, start / stop, and its recent output when something went wrong. */
export function localWorkerCard(web: Web): SafeHtml {
  const s = web.studio;
  const st = s.router.status();
  const w = st.local;
  const external = st.localSource === 'external';
  const stateBadge =
    s.worker && st.active === 'local_gpu'
      ? badge('running', 'good')
      : w.state === 'failed'
        ? badge('failed', 'bad')
        : badge(w.state, 'neutral');
  return card(
    'Local AI worker (LOCAL GPU)',
    html`${kv([
        ['State', stateBadge],
        ['Started by', external ? `you (WORKER_URL=${s.env.workerUrl})` : 'AI Story Studio (automatic)'],
        ['Address', s.worker?.url ?? w.url ?? '—'],
        ['Python', w.python ? `${w.python.version} (${w.python.path})` : '—'],
        [
          'Models',
          s.worker
            ? s.worker.models.map((m) => `${m.kind}: ${m.id}${m.loaded ? ' (loaded)' : ''}`).join(' · ') ||
              'none enabled'
            : '—',
        ],
        ['Log file', w.logPath],
      ])}
      ${st.problems.length && st.requested === 'local_gpu'
        ? html`<p class="flash error">${st.problems.join(' ')}</p>`
        : ''}
      ${w.state === 'failed' && w.tail.length ? html`<pre class="doc">${w.tail.join('\n')}</pre>` : ''}
      <div class="row">
        ${st.requested === 'local_gpu'
          ? html`${button('/local-worker/start', s.worker ? 'Restart local worker' : 'Start local worker')}
            ${s.worker || w.state === 'running' ? button('/local-worker/stop', 'Stop local worker') : ''}`
          : html`<p class="muted">Used only in LOCAL GPU mode (Settings → Execution & GPU).</p>`}
      </div>`,
  );
}

export function registerSystemPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.post('/local-worker/start', async (req) => {
    const st = await s.router.startLocal();
    const back = new URL(req.raw.headers.referer ?? '/gpu', 'http://x').pathname;
    return st.active === 'local_gpu'
      ? web.redirect(back, `Local worker running (${s.worker?.models.length ?? 0} model(s)).`)
      : web.redirect(back, undefined, `Local worker did not start: ${st.problems.join(' ')}`);
  });

  r.post('/local-worker/stop', async (req) => {
    await s.router.stopLocal();
    const back = new URL(req.raw.headers.referer ?? '/gpu', 'http://x').pathname;
    return web.redirect(back, 'Local worker stopped.');
  });

  r.get('/health', async (req) => {
    const report = await runHealthCheck(s, { refreshGpu: req.query.get('refresh') === '1' });
    const [label, kind] = LEVEL_BADGE[report.overall];
    return web.render(
      req,
      'System Health',
      '/health',
      html`<p>
          Overall: ${badge(label, kind)} · Execution mode setting:
          <strong>${s.settings.get('execution').mode.replace('_', ' ').toUpperCase()}</strong>
          ${s.env.mockGeneration ? html` (locked to MOCK by MOCK_GENERATION=true in .env)` : ''}
        </p>
        ${card(
          'Checks',
          table(
            ['Check', 'Status', 'Detail', 'How to fix'],
            report.checks.map((c) => {
              const [l, k] = LEVEL_BADGE[c.level];
              return [c.label, badge(l, k), c.detail, c.fix ?? ''];
            }),
          ),
          html`<a class="button" href="/health?refresh=1">Refresh</a> ${button(
              '/health/check-torch',
              'Check PyTorch',
            )}`,
        )}
        ${hardwareCard(report.hardware, '/health?refresh=1')} ${runtimeCard(report.hardware.device !== null)}`,
    );
  });

  function runtimeCard(hasGpu: boolean): SafeHtml {
    const st = s.runtime.status();
    return card(
      'Worker runtime (Python packages for LOCAL GPU)',
      html`${kv([
        ['State', st.state === 'idle' ? 'no installation run yet' : st.state],
        ['Current step', st.step || '—'],
        ['Log', st.logPath],
        ...(st.error ? ([['Problem', st.error]] as Array<[string, string]>) : []),
      ])}
      ${st.state === 'running'
        ? html`<p>
            <a class="button" href="/health">Refresh</a> ${button('/health/runtime/cancel', 'Cancel')}
          </p>`
        : html`<div class="row">
            ${hasGpu
              ? html`<a class="button primary" href="/health/runtime/gpu">Install GPU runtime (~3.5 GB)</a>`
              : ''}
            <a class="button" href="/health/runtime/cpu">Install CPU runtime (Kokoro TTS only, ~1 GB)</a>
          </div>`}
      ${st.tail.length ? html`<pre class="doc">${st.tail.join('\n')}</pre>` : ''}`,
    );
  }

  r.get('/health/runtime/:kind', async (req) => {
    const kind = req.params['kind'] as RuntimeKind;
    if (kind !== 'gpu' && kind !== 'cpu') throw new AppError('NOT_FOUND', 'Unknown runtime');
    const plan = planRuntime(kind, await s.hardware.nvidia(), join(appRoot(), 'worker'));
    return web.render(
      req,
      kind === 'gpu' ? 'Install the GPU runtime?' : 'Install the CPU runtime?',
      '/health',
      card(
        'Confirm',
        html`${kv([
            ['Downloads', `about ${plan.sizeGb} GB from pypi.org and download.pytorch.org`],
            [
              'PyTorch build',
              plan.wheel === 'cpu' ? 'CPU only' : `CUDA (${plan.wheel}), matching your NVIDIA driver`,
            ],
            ['Installed into', plan.venv],
          ])}
          <ol>
            ${plan.steps.map((st) => html`<li>${st.title}</li>`)}
          </ol>
          <p class="muted">
            Nothing else on the computer changes. AI model weights are NOT part of this; install them in the
            Model Manager. This takes several minutes.
          </p>
          ${postForm(
            `/health/runtime/${kind}`,
            html`<input type="hidden" name="confirm" value="yes" /><button class="primary">
                Install now
              </button>
              <a class="button" href="/health">Cancel</a>`,
          )}`,
      ),
    );
  });

  r.post('/health/runtime/cancel', () => {
    s.runtime.cancel();
    return web.redirect('/health', 'Installation cancelled.');
  });

  r.post('/health/runtime/:kind', async (req) => {
    const kind = req.params['kind'] as RuntimeKind;
    if (kind !== 'gpu' && kind !== 'cpu') throw new AppError('NOT_FOUND', 'Unknown runtime');
    if (req.form['confirm'] !== 'yes')
      throw new AppError('PRECONDITION_FAILED', 'Confirm the installation first.');
    await s.runtime.start(planRuntime(kind, await s.hardware.nvidia(), join(appRoot(), 'worker')));
    return web.redirect('/health', 'Installation started. This page shows its progress (refresh it).');
  });

  r.get('/disk', (req) => {
    const areas = diskUsage(s);
    const size = (b: number) =>
      b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
    return web.render(
      req,
      'Disk & Storage',
      '/health',
      html`${card(
          'Disk usage',
          table(
            ['Area', 'Size', 'Folder', 'Free on that drive', 'Notes', ''],
            areas.map((a) => [
              a.label,
              size(a.bytes),
              a.path,
              a.freeGb === null ? '—' : `${a.freeGb} GB`,
              a.note,
              a.clearable && a.bytes > 0
                ? button(`/disk/clean/${a.key}`, 'Clear', {}, { confirm: `Clear ${a.label}?` })
                : '',
            ]),
          ),
        )}
        <p class="muted">
          Projects, approved references and final exports are never deleted here. AI models are removed one at
          a time in the <a href="/models">Model Manager</a>.
        </p>`,
    );
  });

  r.post('/disk/clean/:target', (req) => {
    const target = req.params['target'] as CleanupTarget;
    if (!['render_temp', 'download_cache', 'worker_jobs'].includes(target))
      throw new AppError('NOT_FOUND', 'Only temporary areas can be cleared here.');
    const freed = cleanup(s, target);
    s.logger.info('disk cleanup', { target, freedBytes: freed });
    return web.redirect('/disk', `Freed ${(freed / 1024 ** 2).toFixed(1)} MB.`);
  });

  r.post('/health/check-torch', async () => {
    const report = await runHealthCheck(s, { probeTorch: true });
    const t = s.hardware.torch;
    s.logger.info('pytorch checked', {
      installed: t?.installed ?? false,
      version: t?.version ?? null,
      cuda: t?.cudaAvailable ?? false,
      cudaRuntime: t?.cudaRuntime ?? null,
    });
    const torch = report.checks.find((c) => c.key === 'torch');
    return web.redirect('/health', `PyTorch: ${torch?.detail ?? 'checked'}`);
  });
}

/** Current hardware status for pages that do not run the full health check. */
export async function hardwareStatus(web: Web, refresh = false): Promise<HardwareStatus> {
  const s = web.studio;
  return classify(await s.hardware.nvidia(refresh), s.hardware.torch, {
    maxVramPercent: s.settings.get('execution').maxVramPercent,
    localWorkerRunning: s.worker !== null,
    cloudAvailable: s.cloud.canProvision(),
    recentOom: s.hardware.recentOom(),
  });
}
