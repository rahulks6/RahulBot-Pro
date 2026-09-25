import {
  ASSET_KINDS,
  AUDIO_LAYERS,
  CONTINUITY_TAGS,
  JOB_STATUSES,
  TRACKS,
  type AudioLayer,
} from '../../domain/enums.ts';
import type { TimelineItem } from '../../domain/types.ts';
import { AppError } from '../../lib/errors.ts';
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
import { preview } from './stories.ts';

export function registerProductionPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  // --- Asset library ------------------------------------------------------------------
  r.get('/assets', async (req) => {
    const filter = {
      projectId: req.query.get('project') || undefined,
      kind: req.query.get('kind') || undefined,
      approval: req.query.get('approval') || undefined,
      search: req.query.get('q') || undefined,
      reusableOnly: req.query.get('reusable') === '1',
      limit: 120,
    };
    const assets = s.assets.list(filter);
    const rows: Array<Array<SafeHtml | string | number>> = [];
    for (const a of assets) {
      rows.push([
        await preview(web, a.id),
        html`${a.label || a.id}<br /><small
            >${a.kind}${a.source_asset_id ? ` · from ${a.source_asset_id}` : ''}${a.is_native_resolution
              ? ''
              : ' · upscaled'}</small
          >`,
        badge(a.approval),
        a.usage_count,
        html`${a.reusable ? badge('reusable', 'good') : ''}
        ${a.continuity_tag ? badge(a.continuity_tag, 'neutral') : ''}`,
        postForm(
          `/assets/${a.id}/flags`,
          html`${checkbox('Reusable', 'reusable', a.reusable)}${select(
              'Series continuity',
              'continuity_tag',
              CONTINUITY_TAGS.map((t) => [t, t || '—']),
              a.continuity_tag,
            )}${field('Tags', 'tags', a.tags)}<button>Save</button>`,
          { cls: 'compact' },
        ),
      ]);
    }
    return web.render(
      req,
      'Assets',
      '/assets',
      html`<form method="get" action="/assets" class="row filters">
          ${select(
            'Project',
            'project',
            [['', 'all'], ...s.projects.list().map((p) => [p.id, p.name] as [string, string])],
            filter.projectId ?? '',
          )}
          ${select(
            'Kind',
            'kind',
            [['', 'all'], ...ASSET_KINDS.map((k) => [k, k] as [string, string])],
            filter.kind ?? '',
          )}
          ${select(
            'Approval',
            'approval',
            [
              ['', 'all'],
              ['approved', 'approved'],
              ['pending', 'pending'],
              ['rejected', 'rejected'],
            ],
            filter.approval ?? '',
          )}
          ${field('Search', 'q', filter.search ?? '')}
          ${select(
            'Reusable',
            'reusable',
            [
              ['', 'any'],
              ['1', 'reusable only'],
            ],
            filter.reusableOnly ? '1' : '',
          )}
          <button>Filter</button>
        </form>
        <p class="muted">
          Continuity tags (intro, outro, theme, catchphrase…) mark intentional series reuse so the originality
          check does not flag it.
        </p>
        ${card(
          `Library (${assets.length})`,
          table(
            ['Preview', 'Asset', 'Approval', 'Uses', 'Flags', 'Library settings'],
            rows,
            'No assets match.',
          ),
        )}`,
    );
  });
  r.post('/assets/:id/flags', (req) => {
    const tag = req.form['continuity_tag'] ?? '';
    if (!(CONTINUITY_TAGS as readonly string[]).includes(tag))
      throw new AppError('VALIDATION_FAILED', 'Unknown continuity tag');
    s.assets.setLibraryFlags(req.params['id']!, {
      reusable: req.form['reusable'] === 'true',
      continuityTag: tag,
      tags: (req.form['tags'] ?? '').slice(0, 300),
    });
    return web.redirect('/assets', 'Asset updated');
  });

  // --- Generation queue ---------------------------------------------------------------
  r.get('/queue', (req) => {
    const status = req.query.get('status') ?? 'active';
    const jobs = s.jobs.list({ status: status === 'all' ? undefined : status, limit: 200 } as {
      status?: string;
      limit: number;
    });
    const waiting = s.jobs.waiting();
    const gpuWaiting = waiting.filter(
      (j) => s.generation.providerFor(j.kind).computeLocation !== 'local_cpu',
    );
    const est = gpuWaiting.length ? s.generation.estimateGpuSeconds(gpuWaiting) : 0;
    return web.render(
      req,
      'Generation Queue',
      '/queue',
      html`${card(
          'Batch',
          html`${kv([
              ['Waiting jobs', waiting.length],
              ['GPU jobs (batched in one session)', gpuWaiting.length],
              ['Local CPU jobs', waiting.length - gpuWaiting.length],
              ['Estimated GPU time', `${Math.round(est)}s (startup + model loads + generation)`],
            ])}
            <p class="muted">
              Queue jobs, then run them together: the GPU is started once, each model is loaded once, results
              are downloaded and verified, and the GPU is terminated — even on failure or cancellation.
            </p>
            ${button(
              '/queue/run',
              s.env.mockGeneration ? 'Run batch (mock GPU, ₹0)' : 'Run batch',
              {},
              { kind: 'primary' },
            )}`,
        )}
        <form method="get" action="/queue" class="inline">
          ${select(
            'Show',
            'status',
            [['active', 'active'], ['all', 'all'], ...JOB_STATUSES.map((x) => [x, x] as [string, string])],
            status,
          )}<button>Show</button>
        </form>
        ${card(
          'Jobs',
          table(
            ['Created', 'Kind', 'Target', 'Mode', 'Status', 'Attempts', 'Error', ''],
            jobs.map((j) => [
              when(j.created_at),
              html`<a href="/jobs/${j.id}">${j.kind}</a>`,
              j.shot_id ? html`<a href="/shots/${j.shot_id}">${j.target_type}</a>` : j.target_type,
              j.mode,
              badge(j.status),
              `${j.attempt_count}/${j.max_attempts}`,
              j.error_message ?? '',
              ['complete', 'failed', 'cancelled'].includes(j.status)
                ? ''
                : button(`/jobs/${j.id}/cancel`, 'Cancel', {}, { kind: 'danger' }),
            ]),
            'No jobs.',
          ),
        )}`,
    );
  });
  r.post('/queue/run', async (req) => {
    const result = await s.generation.processQueue();
    const back =
      req.raw.headers.referer && new URL(req.raw.headers.referer).host === req.raw.headers.host
        ? new URL(req.raw.headers.referer).pathname
        : '/queue';
    const msg = `Batch ${result.batchId}: ${result.completed} complete, ${result.failed} failed, ${result.cancelled} cancelled; ${result.gpuSessions} GPU session(s); ${s.env.mockGeneration ? 'simulated ' : ''}cost ${inr(result.simulatedCostInr)}. ${result.messages.join(' ')}`;
    return result.failed > 0 ? web.redirect(back, undefined, msg) : web.redirect(back, msg);
  });
  r.get('/jobs/:id', (req) => {
    const j = s.jobs.get(req.params['id']!);
    return web.render(
      req,
      `Job ${j.kind}`,
      '/queue',
      html`${card(
        'Job',
        kv([
          ['Status', badge(j.status)],
          ['Target', `${j.target_type} ${j.target_id}`],
          ['Batch', j.batch_id ?? '—'],
          ['Attempts', `${j.attempt_count}/${j.max_attempts}`],
          ['Error', j.error_message ?? '—'],
          ['Parameters', j.params_json],
        ]),
      )}
      ${card(
        'Status log',
        table(
          ['At', 'Status', 'Message'],
          s.jobs.log(j).map((l) => [when(l.at), badge(l.status), l.message]),
        ),
      )}
      ${card(
        'Attempts',
        table(
          ['#', 'Status', 'Model', 'Seed', 'GPU', 'Seconds', 'Cost', 'Error'],
          s.jobs
            .attemptsForJob(j.id)
            .map((a) => [
              a.attempt_number,
              badge(a.status),
              a.model,
              a.seed ?? '',
              a.gpu_model ?? a.provider,
              a.generation_seconds,
              `${inr(a.estimated_cost_inr)}${a.is_mock ? ' sim' : ''}`,
              a.error_message ?? '',
            ]),
        ),
      )}`,
    );
  });
  r.post('/jobs/:id/cancel', (req) => {
    s.generation.cancel(req.params['id']!);
    return web.redirect('/queue', 'Job cancelled');
  });

  // --- Editor / timeline ---------------------------------------------------------------
  r.get('/editor', (req) => {
    const rows = s.projects
      .list()
      .flatMap((p) =>
        s.stories
          .list(p.id)
          .map((st) => [
            p.name,
            html`<a href="/editor/${st.id}">${st.title}</a>`,
            s.timelines.forStory(st.id) ? 'built' : 'not built',
          ]),
      );
    return web.render(
      req,
      'Editor',
      '/editor',
      card('Choose a story', table(['Project', 'Story', 'Timeline'], rows)),
    );
  });

  r.get('/editor/:storyId', async (req) => {
    const story = s.stories.get(req.params['storyId']!);
    const view = s.timeline.view(story.id);
    if (!view) {
      return web.render(
        req,
        `Editor: ${story.title}`,
        '/editor',
        card(
          'Timeline',
          html`<p>No timeline yet.</p>
            ${button(`/editor/${story.id}/build`, 'Build timeline automatically', {}, { kind: 'primary' })}`,
        ),
      );
    }
    const total = Math.max(view.durationSec, 1);
    const lanes = TRACKS.map((track) => {
      const items = view.items.filter((i) => i.track === track);
      return html`<div class="lane">
        <div class="lane-label">${track}</div>
        <div class="lane-body">
          ${items.map(
            (i) =>
              html`<a
                class="tl-clip ${track}${i.asset_id ? '' : ' missing'}${i.manual ? ' manual' : ''}"
                href="#item-${i.id}"
                title="${i.label}"
                style="left:${((i.start_sec / total) * 100).toFixed(3)}%;width:${Math.max(
                  0.4,
                  (i.duration_sec / total) * 100,
                ).toFixed(3)}%"
                >${i.label}</a
              >`,
          )}
        </div>
      </div>`;
    });
    const previews = [['full', 'Complete mix'], ...AUDIO_LAYERS.map((l) => [l, `Solo ${l}`])] as Array<
      [string, string]
    >;
    const previewKey = (name: string) => `projects/${story.project_id}/previews/${story.id}-${name}.wav`;
    const existing = await Promise.all(previews.map(async ([name]) => s.storage.exists(previewKey(name))));
    const itemRow = (i: TimelineItem) =>
      html`<tr id="item-${i.id}">
        <td>${i.track}</td>
        <td>
          ${i.label}${i.manual ? html` ${badge('manual', 'neutral')}` : ''}${i.asset_id
            ? ''
            : html` ${badge('missing audio/clip', 'bad')}`}
        </td>
        <td colspan="2">
          ${postForm(
            `/timeline-items/${i.id}`,
            html`<div class="row compact">
              ${field('Start', 'start_sec', i.start_sec, { type: 'number', step: '0.01' })}${field(
                'Duration',
                'duration_sec',
                i.duration_sec,
                { type: 'number', step: '0.01' },
              )}${field('Trim in', 'trim_in_sec', i.trim_in_sec, {
                type: 'number',
                step: '0.01',
              })}${i.track === 'video'
                ? select(
                    'Transition',
                    'transition',
                    [
                      ['cut', 'cut'],
                      ['crossfade', 'crossfade'],
                      ['fade_black', 'fade to black'],
                    ],
                    i.transition,
                  )
                : field('Volume dB', 'volume_db', i.volume_db, { type: 'number', step: '0.5' })}${field(
                'Fade in',
                'fade_in_sec',
                i.fade_in_sec,
                { type: 'number', step: '0.1' },
              )}${field('Fade out', 'fade_out_sec', i.fade_out_sec, { type: 'number', step: '0.1' })}<button>
                Save
              </button>
            </div>`,
            { cls: 'compact' },
          )}${button(`/timeline-items/${i.id}/delete`, 'Remove', {}, { kind: 'ghost' })}
        </td>
      </tr>`;
    return web.render(
      req,
      `Editor: ${story.title}`,
      '/editor',
      html`<p class="muted">
          <a href="/stories/${story.id}">← story</a> · ${view.items.length} items ·
          ${view.durationSec.toFixed(1)}s
        </p>
        ${card(
          'Timeline',
          html`<div class="timeline">${lanes}</div>
            <div class="actions">
              ${button(`/editor/${story.id}/build`, 'Rebuild automatically (manual edits kept)')}${button(
                `/stories/${story.id}/build-final`,
                'BUILD FINAL',
                { format: 'landscape' },
                { kind: 'primary' },
              )}
            </div>
            ${postForm(
              `/editor/${story.id}/title`,
              html`<div class="row">
                  ${field('Title / intro / outro text', 'text', '', { required: true })}${field(
                    'Start (s)',
                    'start',
                    0,
                    { type: 'number', step: '0.1' },
                  )}${field('Duration (s)', 'duration', 3, { type: 'number', step: '0.1' })}
                </div>
                <button>Add title card</button>`,
            )}`,
        )}
        ${card(
          'Audio preview (solo layers or complete mix)',
          html`<div class="actions">
              ${previews.map(([name, label]) =>
                button(`/editor/${story.id}/preview`, label, { layers: name }),
              )}
            </div>
            ${previews.map(([name, label], idx) =>
              existing[idx]
                ? html`<p>
                    ${label}: <audio controls preload="none" src="${mediaUrl(previewKey(name))}"></audio>
                  </p>`
                : '',
            )}
            <p class="muted">
              Changing one line or one music cue regenerates only that audio; the video is never regenerated
              for audio changes.
            </p>`,
        )}
        ${card(
          'Items',
          html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Item</th>
                  <th colspan="2">Timing & levels</th>
                </tr>
              </thead>
              <tbody>
                ${view.items.map(itemRow)}
              </tbody>
            </table>
          </div>`,
        )}`,
    );
  });
  r.post('/editor/:storyId/build', (req) => {
    const v = s.timeline.build(req.params['storyId']!);
    return web.redirect(
      `/editor/${req.params['storyId']}`,
      `Timeline built: ${v.items.length} items. ${v.warnings.join(' ')}`,
    );
  });
  r.post('/editor/:storyId/title', (req) => {
    s.timeline.addTitle(
      req.params['storyId']!,
      req.form['text'] ?? '',
      num(req.form['start'], 0),
      num(req.form['duration'], 3),
    );
    return web.redirect(`/editor/${req.params['storyId']}`, 'Title added');
  });
  r.post('/editor/:storyId/preview', async (req) => {
    const name = req.form['layers'] ?? 'full';
    const layers: AudioLayer[] | undefined =
      name === 'full'
        ? undefined
        : (AUDIO_LAYERS as readonly string[]).includes(name)
          ? [name as AudioLayer]
          : undefined;
    const { mix } = await s.timeline.writePreview(req.params['storyId']!, layers);
    const missing = mix.missingAudioItems.length
      ? ` ${mix.missingAudioItems.length} item(s) have no audio yet (use BUILD FINAL or generate audio).`
      : '';
    return web.redirect(
      `/editor/${req.params['storyId']}`,
      `Preview rendered (${mix.durationSec.toFixed(1)}s, peak ${mix.preLimiterPeakDb} dBFS).${missing}`,
    );
  });
  const storyOfItem = (id: string) => {
    const row = s.db.get<{ story_id: string }>(
      'SELECT t.story_id FROM timeline_items i JOIN timelines t ON t.id = i.timeline_id WHERE i.id = ?',
      id,
    );
    if (!row) throw new AppError('NOT_FOUND', 'Timeline item not found');
    return row.story_id;
  };
  r.post('/timeline-items/:id', (req) => {
    const storyId = storyOfItem(req.params['id']!);
    const patch: Record<string, unknown> = {};
    for (const k of [
      'start_sec',
      'duration_sec',
      'trim_in_sec',
      'volume_db',
      'fade_in_sec',
      'fade_out_sec',
      'transition',
    ])
      if (req.form[k] !== undefined) patch[k] = req.form[k];
    s.timelines.updateItem(req.params['id']!, patch);
    return web.redirect(`/editor/${storyId}`, 'Item updated (kept on automatic rebuilds)');
  });
  r.post('/timeline-items/:id/delete', (req) => {
    const storyId = storyOfItem(req.params['id']!);
    s.timelines.deleteItem(req.params['id']!);
    return web.redirect(`/editor/${storyId}`, 'Item removed');
  });
}
