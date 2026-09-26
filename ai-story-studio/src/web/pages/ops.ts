import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../lib/errors.ts';
import { appRoot } from '../../lib/paths.ts';
import { providerInfos } from '../../providers/registry.ts';
import { connectWorker } from '../../providers/worker/connect.ts';
import { AnalyticsService } from '../../services/analytics.ts';
import { KILL_ALL_CONFIRMATION, KILL_ONE_CONFIRMATION } from '../../services/gpu-supervisor.ts';
import type { SettingsKey } from '../../services/settings.ts';
import type { Web } from '../app.ts';
import { hardwareCard, hardwareStatus, localWorkerCard } from './system.ts';
import {
  badge,
  button,
  card,
  checkbox,
  field,
  grid,
  html,
  inr,
  kv,
  postForm,
  select,
  table,
  when,
} from '../ui.ts';

export function registerOpsPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/gpu', async (req) => {
    const simulated = s.env.mockGeneration;
    const budget = s.budget.status(simulated);
    const analytics = new AnalyticsService(s);
    const costs = analytics.costs(simulated);
    const prod = analytics.production(simulated);
    const gpu = s.settings.get('gpu');
    const waiting = s.jobs
      .waiting()
      .filter((j) => s.generation.providerFor(j.kind).computeLocation !== 'local_cpu');
    let preflight = html`<p class="muted">No GPU jobs waiting.</p>`;
    if (waiting.length) {
      try {
        const minVram = Math.max(...waiting.map((j) => s.generation.providerFor(j.kind).minVramGb));
        const plan = await s.gpu.plan(minVram, s.generation.estimateGpuSeconds(waiting));
        preflight = kv([
          ['GPU', `${plan.offer.gpuModel}${plan.simulated ? ' (simulated offer)' : ''}`],
          ['VRAM', `${plan.offer.vramGb} GB (needs ≥ ${plan.minVramGb} GB)`],
          ['Hourly price', `${inr(plan.offer.hourlyRateInr)}/h (max allowed ${inr(gpu.maxHourlyRateInr)}/h)`],
          ['Estimated batch cost', inr(plan.estimatedCostInr)],
          ['Worst-case cost (max lifetime)', inr(plan.estimatedMaxCostInr)],
          ['Budget remaining today', inr(plan.budget.daily.remainingInr)],
        ]);
      } catch (err) {
        preflight = html`<p class="flash error">${(err as Error).message}</p>`;
      }
    }
    const active = s.gpuRepo.active();
    const hw = await hardwareStatus(web, req.query.get('refresh') === '1');
    const exec = s.settings.get('execution');
    return web.render(
      req,
      'GPU & Costs',
      '/gpu',
      html`${grid([
        card(
          'Execution',
          kv([
            ['Mode (setting)', exec.mode.replace('_', ' ').toUpperCase()],
            ['Active', s.cloud.modeLabel()],
            [
              'Where jobs run',
              s.cloud.mode() === 'REAL_CLOUD'
                ? 'rented cloud GPU (paid)'
                : s.cloud.mode() === 'LOCAL_WORKER'
                  ? 'this computer (₹0)'
                  : 'in-app placeholders (₹0)',
            ],
          ]),
          html`<a class="button" href="/gpu?refresh=1">Refresh</a>`,
        ),
        hardwareCard(hw, '/gpu?refresh=1'),
      ])}
      ${s.router.requested() === 'local_gpu' ? localWorkerCard(web) : ''}
      ${grid([
        card(
          `Budget${simulated ? ' (simulated spend)' : ''}`,
          html`${badge(budget.level)}${kv([
              [
                'Today',
                `${inr(budget.daily.spentInr)} / ${inr(budget.daily.limitInr)} (${budget.daily.percent}%)`,
              ],
              [
                'This month',
                `${inr(budget.monthly.spentInr)} / ${inr(budget.monthly.limitInr)} (${budget.monthly.percent}%)`,
              ],
            ])}${budget.messages.map((m) => html`<p class="muted">${m}</p>`)}
            <p><a href="/settings">Change budgets →</a></p>`,
        ),
        card('Next batch pre-flight', preflight),
        card(
          'Safety',
          kv([
            ['Idle timeout', `${gpu.idleTimeoutMinutes} min`],
            ['Maximum GPU lifetime', `${gpu.maxLifetimeMinutes} min`],
            ['Watchdog interval', `${gpu.watchdogIntervalSeconds}s`],
            ['Orphan policy', gpu.orphanPolicy],
            [
              'Cloud GPU',
              s.env.enableCloudGpu && !s.env.mockGeneration ? 'enabled' : 'disabled (mock provider only)',
            ],
          ]),
        ),
      ])}
      ${card(
        'Emergency kill switch',
        html`<p>Only resources created and tagged by AI Story Studio are ever terminated.</p>
          ${postForm(
            '/gpu/kill-all',
            html`${field(`Type ${KILL_ALL_CONFIRMATION} to confirm`, 'confirm', '', {
                required: true,
              })}<button class="danger">TERMINATE ALL AI STORY STUDIO GPU RESOURCES</button>`,
            { confirm: 'Terminate every AI Story Studio GPU resource now?' },
          )}
          ${button('/gpu/watchdog', 'Run watchdog now')}`,
      )}
      ${card(
        'GPU instances',
        table(
          ['Created', 'Provider', 'GPU', 'Rate', 'Status', 'State', 'Reason', ''],
          s.gpuRepo
            .list()
            .map((g) => [
              when(g.created_at),
              `${g.provider}${g.is_mock ? ' (mock)' : ''}`,
              `${g.gpu_model} ${g.vram_gb}GB`,
              `${inr(g.hourly_rate_inr)}/h`,
              badge(g.status),
              g.lifecycle_state ?? '',
              g.termination_reason ?? '',
              active.some((a) => a.id === g.id)
                ? postForm(
                    `/gpu/${g.id}/kill`,
                    html`<input name="confirm" placeholder="${KILL_ONE_CONFIRMATION}" required /><button
                        class="danger"
                      >
                        TERMINATE AI GPU
                      </button>`,
                    { cls: 'inline', confirm: 'Terminate this GPU?' },
                  )
                : '',
            ]),
        ),
      )}
      ${card(
        `Costs${simulated ? ' (simulated)' : ''}`,
        html`${kv([
          ['Total', inr(costs.totalInr)],
          ['GPU hours', costs.gpuHours],
          ['Cost per approved shot', inr(prod.costPerApprovedShotInr)],
          ['Cost per episode', inr(prod.costPerEpisodeInr)],
          ['Cost per finished minute', inr(prod.costPerFinishedMinuteInr)],
          ['Attempts per approved shot', prod.attemptsPerApprovedShot],
          ['Approval rate', `${prod.approvalRate}%`],
          ['Asset reuse rate', `${prod.assetReuseRate}%`],
          [
            'Audio reuse (cached jobs / generated files)',
            `${prod.audioReuse.reusedJobs} / ${prod.audioReuse.generated}`,
          ],
        ])}
        ${grid([
          card(
            'By category',
            table(
              ['Category', 'Seconds', 'Cost'],
              costs.byCategory.map((c) => [c.category, c.seconds, inr(c.costInr)]),
            ),
          ),
          card(
            'By model',
            table(
              ['Model', 'Seconds', 'Cost'],
              costs.byModel.map((c) => [c.model, c.seconds, inr(c.costInr)]),
            ),
          ),
          card(
            'By GPU',
            table(
              ['GPU', 'Seconds', 'Cost'],
              costs.byGpu.map((c) => [c.gpu, c.seconds, inr(c.costInr)]),
            ),
          ),
        ])}`,
      )}
      ${card(
        'GPU events & cleanup log',
        table(
          ['When', 'Event', 'Detail'],
          s.gpuRepo.events(40).map((e) => [when(e.created_at), e.event, e.detail.slice(0, 200)]),
        ),
      )}`,
    );
  });
  r.post('/gpu/watchdog', async () => {
    const rep = await s.gpu.watchdog();
    return web.redirect(
      '/gpu',
      `Watchdog: ${rep.providerInstances} provider instance(s), ${rep.orphansFound.length} orphan(s), ${rep.orphansTerminated.length} terminated, ${rep.timerTerminations.length} timer stop(s).`,
    );
  });
  r.post('/gpu/kill-all', async (req) => {
    const res = await s.gpu.killAll(req.form['confirm'] ?? '');
    return web.redirect(
      '/gpu',
      `Terminated ${res.terminated.length}; failed ${res.failed.length}. Remaining studio GPU instances: ${await s.gpu.liveStudioInstances()}`,
    );
  });
  r.post('/gpu/:id/kill', async (req) => {
    await s.gpu.killInstance(req.params['id']!, req.form['confirm'] ?? '');
    return web.redirect('/gpu', 'GPU terminated');
  });

  // --- Settings -----------------------------------------------------------------------
  r.get('/settings', (req) => {
    const all = s.settings.all();
    const b = all.budget;
    const g = all.gpu;
    const gen = all.generation;
    const a = all.audioMix;
    const q = all.quality;
    const enc = all.encoding;
    const ex = all.execution;
    const opt = (v: string[]) => v.map((x) => [x, x] as [string, string]);
    return web.render(
      req,
      'Settings',
      '/settings',
      html`${card(
        'Execution & GPU',
        postForm(
          '/settings/execution',
          html`${s.env.mockGeneration
              ? html`<p class="flash">
                  <strong>MOCK_GENERATION=true</strong> in .env locks the studio to MOCK mode, whatever is
                  chosen here. Set MOCK_GENERATION=false in .env and restart to use LOCAL GPU or CLOUD GPU
                  (docs/GPU_SETUP.md).
                </p>`
              : ''}
            ${select(
              'Execution mode',
              'mode',
              [
                ['mock', 'MOCK — placeholders, safe testing, ₹0'],
                ['local_gpu', 'LOCAL GPU — this computer, never rents anything'],
                ['cloud_gpu', 'CLOUD GPU — rented GPU, needs every cloud permission'],
              ],
              ex.mode,
            )}
            ${select(
              'Default quality preset',
              'defaultQuality',
              [
                ['fast_preview', 'FAST — quick previews, less compute'],
                ['optimized', 'OPTIMIZED — best cost/time/quality balance'],
                ['high_quality', 'QUALITY — maximum practical quality'],
              ],
              ex.defaultQuality,
            )}
            ${field('Image model (LOCAL GPU; empty = default)', 'imageModel', ex.imageModel)}
            ${field('Video model', 'videoModel', ex.videoModel)}
            ${field('TTS model', 'ttsModel', ex.ttsModel)} ${field('Upscaler', 'upscaler', ex.upscaler)}
            ${field('Music model', 'musicModel', ex.musicModel)}
            ${field('SFX / ambience model', 'sfxModel', ex.sfxModel)}
            <p class="muted">
              Pick models from the <a href="/models">Model Manager</a> (it shows what fits this GPU).
            </p>
            ${field('Max VRAM usage (%)', 'maxVramPercent', ex.maxVramPercent, { type: 'number' })}
            ${select(
              'CPU offload',
              'cpuOffload',
              opt(['auto', 'none', 'model', 'sequential']),
              ex.cpuOffload,
            )}
            ${select('VAE tiling', 'vaeTiling', opt(['auto', 'on', 'off']), ex.vaeTiling)}
            ${select(
              'Attention optimization',
              'attentionOptimization',
              opt(['auto', 'sdpa', 'slicing', 'off']),
              ex.attentionOptimization,
            )}
            ${checkbox(
              'Unload models automatically',
              'autoUnloadModels',
              ex.autoUnloadModels,
              'frees VRAM before a large model loads',
            )}
            ${checkbox(
              'Allow lower resolution / fewer frames to fit VRAM',
              'allowQualityReduction',
              ex.allowQualityReduction,
              'off = the job fails with an explanation instead; any reduction is recorded',
            )}
            ${checkbox(
              'Allow Cloud GPU fallback',
              'allowCloudFallback',
              ex.allowCloudFallback,
              'jobs this GPU cannot run may use the Cloud GPU — only when every cloud permission is already given',
            )}
            ${select(
              'Output resolution',
              'outputResolution',
              [
                ['1080p', '1920×1080 (default)'],
                ['2160p', '3840×2160 (4K, experimental: upscaled master)'],
              ],
              ex.outputResolution,
            )}
            ${select('Default FPS (new projects)', 'fps', opt(['24', '30']), ex.fps)}
            ${checkbox('Clean up temporary files after use', 'cleanTempFiles', ex.cleanTempFiles)}
            ${checkbox(
              'Start the local worker automatically (LOCAL GPU)',
              'localWorkerAutoStart',
              ex.localWorkerAutoStart,
            )}
            ${field('Local worker port', 'localWorkerPort', ex.localWorkerPort, { type: 'number' })}
            <button class="primary">Save</button>`,
        ),
      )}
      ${card(
        'Environment (read-only, from .env)',
        kv([
          ['MOCK_GENERATION', s.env.mockGeneration ? 'true (no paid generation possible)' : 'false'],
          ['ENABLE_CLOUD_GPU', String(s.env.enableCloudGpu)],
          ['DATA_DIR', s.env.dataDir],
          ['Bind address', `${s.env.host}:${s.env.port}`],
          ['ASSEMBLY_MODE', s.env.assemblyMode],
          [
            'FFmpeg (episode assembly)',
            s.env.assemblyMode === 'mock'
              ? 'not used (mock master manifest)'
              : s.ffmpeg
                ? `${s.ffmpeg.version} — BUILD FINAL encodes real MP4 masters`
                : 'not found — BUILD FINAL writes a mock master manifest (install FFmpeg or set FFMPEG_PATH)',
          ],
        ]),
      )}
      ${localWorkerCard(web)}
      ${card(
        'AI components (replaceable)',
        table(
          ['Slot', 'Provider', 'Mock', 'Open source', 'Runs on', 'Paid?'],
          providerInfos(s.providers).map((p) => [
            p.id.replace('mock-', ''),
            p.displayName,
            p.isMock ? 'yes' : 'no',
            p.openSource ? 'yes' : 'no',
            p.computeLocation,
            p.requiresPaidResources ? 'yes' : 'no',
          ]),
        ),
      )}
      ${grid([
        card(
          'Budget (₹) — never raised automatically',
          postForm(
            '/settings/budget',
            html`${field('Daily GPU budget', 'dailyInr', b.dailyInr, { type: 'number', step: '1' })}${field(
                'Monthly GPU budget',
                'monthlyInr',
                b.monthlyInr,
                { type: 'number', step: '1' },
              )}${field('Warn at %', 'warnPercent', b.warnPercent, { type: 'number' })}${field(
                'Block new cloud generations at %',
                'blockPercent',
                b.blockPercent,
                { type: 'number' },
              )}<button class="primary">Save budget</button>`,
          ),
        ),
        card(
          'GPU',
          postForm(
            '/settings/gpu',
            html`${select(
                'Preferred provider',
                'preferredProvider',
                [
                  ['mock', 'Mock (Phase 1)'],
                  ['local', 'Local GPU (future)'],
                  ['runpod', 'RunPod (future)'],
                  ['tensordock', 'TensorDock (future)'],
                  ['vast', 'Vast.ai (future)'],
                ],
                g.preferredProvider,
              )}
              ${field('Maximum hourly price (₹/h)', 'maxHourlyRateInr', g.maxHourlyRateInr, {
                type: 'number',
                step: '1',
              })}${field('Minimum VRAM (GB)', 'minVramGb', g.minVramGb, { type: 'number' })}
              ${field('Idle timeout (min)', 'idleTimeoutMinutes', g.idleTimeoutMinutes, {
                type: 'number',
              })}${field('Maximum GPU lifetime (min)', 'maxLifetimeMinutes', g.maxLifetimeMinutes, {
                type: 'number',
              })}
              ${field('Watchdog interval (s)', 'watchdogIntervalSeconds', g.watchdogIntervalSeconds, {
                type: 'number',
              })}${select(
                'Orphan policy',
                'orphanPolicy',
                [
                  ['terminate', 'terminate orphans'],
                  ['warn', 'warn only'],
                ],
                g.orphanPolicy,
              )} <button class="primary">Save GPU settings</button>`,
          ),
        ),
        card(
          'Generation',
          postForm(
            '/settings/generation',
            html`${field('Max attempts per job (no infinite retries)', 'maxAttempts', gen.maxAttempts, {
                type: 'number',
              })}${checkbox(
                'Upscale OPTIMIZED output to final resolution',
                'upscaleOptimizedOutput',
                gen.upscaleOptimizedOutput,
              )}${checkbox(
                'Suggest reusable assets before generating',
                'suggestReuseBeforeGeneration',
                gen.suggestReuseBeforeGeneration,
              )}
              ${select(
                'Upscaling',
                'upscaleMode',
                [
                  ['auto', 'AUTO — only when output is below the delivery size (recommended)'],
                  ['off', 'OFF — never upscale'],
                  ['force', 'FORCE — always run the upscaler'],
                ],
                gen.upscaleMode,
              )}
              ${field(
                'Character reference strength for real cloud images (0 = off; 0.8 recommended)',
                'characterReferenceStrength',
                gen.characterReferenceStrength,
                { type: 'number', step: '0.05' },
              )}<button class="primary">Save</button>`,
          ),
        ),
        card(
          'Audio mix',
          postForm(
            '/settings/audioMix',
            html`${checkbox('Duck music under narration/dialogue', 'duckingEnabled', a.duckingEnabled)}
              ${field('Ducking amount (dB)', 'duckDb', a.duckDb, { type: 'number', step: '0.5' })}${field(
                'Attack (s)',
                'duckAttackSec',
                a.duckAttackSec,
                { type: 'number', step: '0.05' },
              )}${field('Release (s)', 'duckReleaseSec', a.duckReleaseSec, { type: 'number', step: '0.05' })}
              ${field('Dialogue (dB)', 'dialogueDb', a.dialogueDb, { type: 'number', step: '0.5' })}${field(
                'Narration (dB)',
                'narrationDb',
                a.narrationDb,
                { type: 'number', step: '0.5' },
              )}${field('Music (dB)', 'musicDb', a.musicDb, { type: 'number', step: '0.5' })}
              ${field('SFX (dB)', 'sfxDb', a.sfxDb, { type: 'number', step: '0.5' })}${field(
                'Ambience (dB)',
                'ambienceDb',
                a.ambienceDb,
                { type: 'number', step: '0.5' },
              )}${field('Peak ceiling (dBFS)', 'peakCeilingDb', a.peakCeilingDb, {
                type: 'number',
                step: '0.1',
              })} <button class="primary">Save</button>`,
          ),
        ),
        card(
          'Encoding (BUILD FINAL master)',
          postForm(
            '/settings/encoding',
            html`${field('Video quality (CRF, lower = better)', 'videoCrf', enc.videoCrf, {
                type: 'number',
              })}${select(
                'x264 preset',
                'preset',
                ['ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map(
                  (p) => [p, p] as [string, string],
                ),
                enc.preset,
              )}
              ${field('AAC bitrate (kbps)', 'audioBitrateKbps', enc.audioBitrateKbps, {
                type: 'number',
              })}${select(
                'Sample rate (Hz)',
                'sampleRate',
                [
                  ['48000', '48000'],
                  ['44100', '44100'],
                ],
                enc.sampleRate,
              )}
              ${field('Target loudness (LUFS; YouTube ≈ −14)', 'targetLufs', enc.targetLufs, {
                type: 'number',
                step: '0.5',
              })}${field('True-peak ceiling (dBTP)', 'truePeakDb', enc.truePeakDb, {
                type: 'number',
                step: '0.1',
              })}
              ${field('Crossfade length (s)', 'crossfadeSec', enc.crossfadeSec, {
                type: 'number',
                step: '0.05',
              })}${field('Fade-to-black length (s)', 'fadeBlackSec', enc.fadeBlackSec, {
                type: 'number',
                step: '0.05',
              })}<button class="primary">Save</button>`,
          ),
        ),
        card(
          'Quality-check thresholds (configurable, not permanent rules)',
          postForm(
            '/settings/quality',
            html`${field('Similarity warning %', 'similarityWarnPercent', q.similarityWarnPercent, {
                type: 'number',
              })}${field('Very high similarity %', 'similarityHighPercent', q.similarityHighPercent, {
                type: 'number',
              })}${field('Max identical clip reuse %', 'maxClipReusePercent', q.maxClipReusePercent, {
                type: 'number',
              })}
              ${field('Minimum clip length (s)', 'minClipSeconds', q.minClipSeconds, {
                type: 'number',
                step: '0.05',
              })}${field(
                'Max dialogue/narration level difference (dB)',
                'maxLayerLevelDifferenceDb',
                q.maxLayerLevelDifferenceDb,
                { type: 'number' },
              )}${field(
                'Music must sit below speech by (dB)',
                'musicOverSpeechMarginDb',
                q.musicOverSpeechMarginDb,
                { type: 'number' },
              )}
              ${field(
                'Duration tolerance vs target (%)',
                'durationTolerancePercent',
                q.durationTolerancePercent,
                { type: 'number' },
              )}<button class="primary">Save</button>`,
          ),
        ),
      ])}`,
    );
  });
  r.post('/settings/worker/connect', async () => {
    const c = await connectWorker(s);
    return web.redirect(
      '/settings',
      `Connected to worker ${c.version} (${c.models.length} models${c.models.every((m) => m.mock) ? ', all mock' : ''})`,
    );
  });
  r.post('/settings/:section', async (req) => {
    const section = req.params['section'] as SettingsKey;
    if (!['execution', 'budget', 'gpu', 'generation', 'audioMix', 'quality', 'encoding'].includes(section))
      throw new AppError('NOT_FOUND', 'Unknown settings section');
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.form)) if (!k.startsWith('_')) values[k] = v;
    s.settings.set(section, values);
    s.logger.info('settings changed', { section });
    if (section === 'execution') {
      const st = await s.router.apply();
      if (st.lockedByEnv)
        return web.redirect(
          '/settings',
          'Settings saved. MOCK_GENERATION=true in .env keeps the studio in MOCK mode.',
        );
      return st.ready
        ? web.redirect('/settings', `Settings saved. Execution mode: ${st.label}.`)
        : web.redirect('/settings', undefined, `Settings saved, but ${st.label}: ${st.problems.join(' ')}`);
    }
    return web.redirect('/settings', 'Settings saved');
  });

  r.get('/docs/story-package', (req) => {
    const text = readFileSync(join(appRoot(), 'docs', 'STORY_PACKAGE.md'), 'utf8');
    return web.render(req, 'Story Package format', '/stories', html`<pre class="doc">${text}</pre>`);
  });
}
