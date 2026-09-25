import { AppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import { BenchmarkService, type ModelAggregate } from '../../services/benchmarks.ts';
import type { Web } from '../app.ts';
import { num } from '../forms.ts';
import {
  badge,
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
  table,
  when,
  type SafeHtml,
} from '../ui.ts';

function licenceBadge(commercialUse: string, mock: boolean): SafeHtml {
  if (mock) return badge('mock', 'neutral');
  if (commercialUse === 'allowed') return badge('commercial ok', 'good');
  if (commercialUse === 'conditional') return badge('conditional', 'warn');
  return badge(commercialUse.replace('_', '-') || 'unknown', 'bad');
}

function outputPreview(key: string | null, mime: string | null): SafeHtml {
  if (!key || !mime) return html`<div class="noposter failed">no output</div>`;
  if (mime.startsWith('image/'))
    return html`<figure class="preview"><img src="${mediaUrl(key)}" alt="" loading="lazy" /></figure>`;
  if (mime === 'video/mp4')
    return html`<figure class="preview">
      <video controls muted preload="metadata" src="${mediaUrl(key)}"></video>
    </figure>`;
  if (mime.startsWith('audio/')) return html`<audio controls preload="none" src="${mediaUrl(key)}"></audio>`;
  return html`<a href="${mediaUrl(key)}">output</a>`;
}

interface GpuReport {
  available?: boolean;
  gpus?: Array<{ name: string; vram_total_mb: number }>;
  cuda_version?: string | null;
  reason?: string;
}

const fmt = (n: number | null, unit = '') => (n === null ? '—' : `${n}${unit}`);

export function registerBenchmarkPages(web: Web): void {
  const s = web.studio;
  const r = web.router;
  const svc = () => new BenchmarkService(s);

  r.get('/benchmarks', (req) => {
    const service = svc();
    const w = s.worker;
    const images = s.db.all<{ id: string; label: string }>(
      "SELECT id, label FROM generated_assets WHERE approval = 'approved' AND kind IN ('image', 'upscaled_image') ORDER BY created_at DESC LIMIT 50",
    );
    const start = w
      ? postForm(
          '/benchmarks/start',
          html`<p class="muted">
              Choose models to compare. Each runs the built-in suite: the same original character in several
              situations, an establishing shot, in-image text, gentle motion, expressive narration and
              dialogue, music beds, SFX, a loopable ambience and upscaling. Real models need
              <code>MOCK_GENERATION=false</code> and run only on this local worker; cloud GPUs stay off.
            </p>
            ${table(
              ['', 'Model', 'Kind', 'Licence', 'VRAM', ''],
              w.models
                .filter((m) => ['image', 'video', 'tts', 'music', 'sfx', 'upscale'].includes(m.kind))
                .map((m) => [
                  html`<input type="checkbox" name="model" value="${m.id}" />`,
                  m.display_name,
                  m.kind,
                  html`${licenceBadge(m.commercial_use ?? 'unknown', m.mock)} <small>${m.license}</small>`,
                  m.min_vram_gb ? `${m.min_vram_gb} GB` : '—',
                  m.mock ? 'mock' : m.loaded ? 'loaded' : '',
                ]),
              'The worker reports no benchmarkable models. Enable entries in the worker catalog (WORKER_MODELS_FILE).',
            )}
            <div class="row">
              ${checkbox('Include mock models (pipeline smoke test)', 'include_mock', false)}
              ${field(
                'GPU hourly rate for cost estimates (₹/h)',
                'hourly_rate',
                s.settings.get('gpu').maxHourlyRateInr,
                { type: 'number', step: '1' },
              )}
              ${select(
                'Image-to-video source still',
                'source_asset_id',
                [
                  ['', 'built-in test card'],
                  ...images.map((i) => [i.id, i.label || i.id] as [string, string]),
                ],
                '',
              )}
            </div>
            <button class="primary">Start benchmark</button>`,
        )
      : html`<p>
          Connect the local AI worker first (<a href="/settings">Settings → Local AI worker</a>). Benchmarks
          run on the worker so they measure the real GPU, VRAM and speed.
        </p>`;
    const selections = service.selections().filter((x) => x.active);
    return web.render(
      req,
      'Model Benchmarks',
      '/benchmarks',
      html`${card(
        'Current model selection (used by the worker providers)',
        table(
          ['Kind', 'Model', 'Licence', 'Why', 'Decided'],
          selections.map((x) => [
            x.kind,
            x.model_id,
            html`${licenceBadge(x.commercial_use, false)} ${x.license}`,
            x.rationale,
            when(x.decided_at),
          ]),
          'No selections yet: the worker default is used for each kind.',
        ),
      )}
      ${card('Start a benchmark', start)}
      ${card(
        'Benchmark runs',
        table(
          ['Started', 'Suite', 'Status', 'Models', 'GPU', ''],
          service.runs().map((run) => {
            const gpu = parseJson<{ gpus?: Array<{ name: string }> }>(run.gpu_json, {});
            return [
              when(run.started_at),
              run.suite,
              badge(run.status),
              service
                .models(run)
                .map((m) => m.id)
                .join(', ') || '…',
              gpu.gpus?.[0]?.name ?? (run.status === 'running' ? '…' : 'no GPU'),
              html`<a href="/benchmarks/${run.id}">open</a> ${run.status === 'running'
                  ? button(`/benchmarks/${run.id}/refresh`, 'Refresh')
                  : ''}`,
            ];
          }),
        ),
      )}`,
    );
  });

  r.post('/benchmarks/start', async (req) => {
    const sourceId = req.form['source_asset_id'];
    const source = sourceId ? await s.assets.read(sourceId) : undefined;
    const run = await svc().start({
      models: req.formAll['model'] ?? [],
      includeMock: req.form['include_mock'] === 'true',
      hourlyRateInr: num(req.form['hourly_rate'], 0),
      ...(source ? { sourceImage: source } : {}),
    });
    return web.redirect(
      `/benchmarks/${run.id}`,
      'Benchmark started on the worker. Refresh to import results when it finishes.',
    );
  });

  r.post('/benchmarks/:id/refresh', async (req) => {
    const run = await svc().refresh(req.params['id']!);
    return web.redirect(
      `/benchmarks/${run.id}`,
      run.status === 'running' ? 'Still running on the worker.' : `Benchmark ${run.status}.`,
    );
  });

  r.post('/benchmarks/:id/cancel', async (req) => {
    await svc().cancel(req.params['id']!);
    return web.redirect(`/benchmarks/${req.params['id']}`, 'Cancellation requested');
  });

  r.get('/benchmarks/:id', (req) => {
    const service = svc();
    const run = service.get(req.params['id']!);
    if (run.status === 'running') {
      return web.render(
        req,
        'Benchmark running',
        '/benchmarks',
        card(
          'Status',
          html`<p>${badge('running')} on ${run.worker_url} (worker job ${run.worker_job_id})</p>
            <div class="actions">
              ${button(
                `/benchmarks/${run.id}/refresh`,
                'Refresh / import results',
                {},
                { kind: 'primary' },
              )}${button(`/benchmarks/${run.id}/cancel`, 'Cancel', {}, { kind: 'danger' })}
            </div>`,
        ),
      );
    }
    const aggs = service.aggregate(run.id);
    const results = service.results(run.id);
    const gpu = parseJson<GpuReport>(run.gpu_json, {});
    const kinds = [...new Set(aggs.map((a) => a.model.kind))];
    const row = (a: ModelAggregate) => [
      html`${a.model.display_name}<br /><small>${a.model.id} · ${a.model.version}</small>`,
      html`${licenceBadge(a.model.commercial_use, a.model.mock)}<br /><small
          >${a.model.license_url
            ? html`<a href="${a.model.license_url}" rel="noreferrer">${a.model.license}</a>`
            : a.model.license}</small
        >`,
      `${a.succeeded}/${a.runs} (${Math.round(a.successRate * 100)}%)`,
      fmt(a.loadSeconds, 's'),
      `${fmt(a.meanRunSeconds, 's')} / ${fmt(a.p95RunSeconds, 's')}`,
      a.peakVramMb === null ? '—' : `${Math.round(a.peakVramMb / 102.4) / 10} GB`,
      a.reproducible === null ? '—' : a.reproducible ? 'yes' : 'no',
      a.estCostPerOutputInr === null ? '—' : inr(a.estCostPerOutputInr),
      a.avgQuality === null ? 'not rated' : `${a.avgQuality} / 5`,
      a.avgConsistency === null ? '—' : `${a.avgConsistency} / 5`,
      a.errors.join(', '),
    ];
    const selectionForms = kinds.map((kind) => {
      const options = aggs.filter((a) => a.model.kind === kind);
      return card(
        `Select the ${kind} model`,
        postForm(
          `/benchmarks/${run.id}/select`,
          html`${select(
              'Model',
              'model_id',
              options.map(
                (a) =>
                  [
                    a.model.id,
                    `${a.model.display_name} (${a.model.mock ? 'mock' : a.model.commercial_use.replace('_', '-')})`,
                  ] as [string, string],
              ),
              '',
            )}
            ${field(
              'Why this model? (quality, consistency, speed, VRAM, licence, integration effort)',
              'rationale',
              '',
              { textarea: true, rows: 2, required: true },
            )}
            ${checkbox(
              'I have read the licence terms and they fit how we publish (required for conditional licences)',
              'license_acknowledged',
              false,
            )} <button class="primary">Record selection</button>`,
        ),
      );
    });
    const grid: SafeHtml[] = [];
    for (const kind of kinds) {
      const models = aggs.filter((a) => a.model.kind === kind).map((a) => a.model.id);
      const cases = [
        ...new Set(results.filter((x) => x.kind === kind).map((x) => `${x.case_key}|${x.seed ?? ''}`)),
      ];
      grid.push(
        card(
          `${kind}: side-by-side outputs (rate quality and consistency; automated checks cannot)`,
          html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  ${models.map((m) => html`<th>${m}</th>`)}
                </tr>
              </thead>
              <tbody>
                ${cases.map((c) => {
                  const [key, seed] = c.split('|');
                  return html`<tr>
                    <td>${key}${seed ? html`<br /><small>seed ${seed}</small>` : ''}</td>
                    ${models.map((m) => {
                      const res = results.find(
                        (x) => x.model_id === m && `${x.case_key}|${x.seed ?? ''}` === c,
                      );
                      if (!res) return html`<td>—</td>`;
                      const checks = parseJson<Record<string, unknown>>(res.checks_json, {});
                      return html`<td>
                        ${outputPreview(res.storage_key, res.mime)}
                        <small
                          >${res.status === 'complete'
                            ? `${res.run_seconds}s${res.peak_vram_mb ? ` · ${Math.round(res.peak_vram_mb)} MB` : ''}`
                            : `${res.error_code}: ${res.error_message ?? ''}`}</small
                        >
                        ${Object.keys(checks).length
                          ? html`<details>
                              <summary>checks</summary>
                              <small>${JSON.stringify(checks)}</small>
                            </details>`
                          : ''}
                        ${res.status === 'complete'
                          ? postForm(
                              `/benchmark-results/${res.id}/rate`,
                              html`<div class="row compact">
                                  ${select(
                                    'Quality',
                                    'quality',
                                    [
                                      ['', '—'],
                                      ...['1', '2', '3', '4', '5'].map((n) => [n, n] as [string, string]),
                                    ],
                                    res.quality ?? '',
                                  )}${select(
                                    'Consistency',
                                    'consistency',
                                    [
                                      ['', '—'],
                                      ...['1', '2', '3', '4', '5'].map((n) => [n, n] as [string, string]),
                                    ],
                                    res.consistency ?? '',
                                  )}
                                </div>
                                ${field('Notes', 'notes', res.notes ?? '')}<button>Save rating</button>`,
                              { cls: 'compact' },
                            )
                          : ''}
                      </td>`;
                    })}
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`,
        ),
      );
    }
    return web.render(
      req,
      `Benchmark: ${run.suite}`,
      '/benchmarks',
      html`<p class="muted"><a href="/benchmarks">← all benchmarks</a></p>
        ${card(
          'Run',
          kv([
            ['Status', badge(run.status)],
            ['Worker', run.worker_url],
            [
              'GPU',
              gpu.available
                ? (gpu.gpus ?? [])
                    .map((g) => `${g.name} (${Math.round(g.vram_total_mb / 1024)} GB)`)
                    .join(', ')
                : `none — ${gpu.reason ?? ''}`,
            ],
            ['CUDA', gpu.cuda_version ?? '—'],
            ['Cost estimate rate', `${inr(run.hourly_rate_inr)}/h`],
            ['Error', run.error_message ?? '—'],
            ['Finished', when(run.finished_at)],
          ]),
        )}
        ${card(
          'Summary',
          html`${table(
              [
                'Model',
                'Licence',
                'Success',
                'Load',
                'Mean / p95 run',
                'Peak VRAM',
                'Same-seed reproducible',
                'Est. cost / output',
                'Quality',
                'Consistency',
                'Errors',
              ],
              aggs.map(row),
            )}
            <p class="muted">
              Cost estimate = mean run time × the hourly rate entered (start-up and model loading excluded).
              Quality and consistency are your ratings; the app never chooses a model by itself.
            </p>`,
        )}
        ${selectionForms} ${grid}`,
    );
  });

  r.post('/benchmark-results/:id/rate', (req) => {
    const row = s.db.get<{ run_id: string }>(
      'SELECT run_id FROM benchmark_results WHERE id = ?',
      req.params['id']!,
    );
    if (!row) throw new AppError('NOT_FOUND', 'Result not found');
    if (!req.form['quality']) throw new AppError('VALIDATION_FAILED', 'Choose a quality rating');
    svc().rate(req.params['id']!, {
      quality: Number(req.form['quality']),
      consistency: req.form['consistency'] ? Number(req.form['consistency']) : null,
      notes: req.form['notes'] ?? '',
    });
    return web.redirect(`/benchmarks/${row.run_id}`, 'Rating saved');
  });

  r.post('/benchmarks/:id/select', (req) => {
    const sel = svc().select({
      runId: req.params['id']!,
      modelId: req.form['model_id'] ?? '',
      rationale: req.form['rationale'] ?? '',
      licenseAcknowledged: req.form['license_acknowledged'] === 'true',
    });
    return web.redirect(
      `/benchmarks/${req.params['id']}`,
      `Selected ${sel.model_id} for ${sel.kind}. Reconnect the worker (Settings) to start using it.`,
    );
  });
}
