import { classify, GPU_STATE_LABEL, PROFILE_LABEL, type HardwareStatus } from '../../services/hardware.ts';
import { runHealthCheck, type HealthLevel } from '../../services/system-health.ts';
import type { Web } from '../app.ts';
import type { SafeHtml } from '../html.ts';
import { badge, button, card, html, kv, table } from '../ui.ts';

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

export function registerSystemPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

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
        ${hardwareCard(report.hardware, '/health?refresh=1')}`,
    );
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
