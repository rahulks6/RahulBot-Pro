import type { Finding } from '../../domain/types.ts';
import { parseJson } from '../../lib/json.ts';
import { AnalyticsService } from '../../services/analytics.ts';
import { YOUTUBE_CHECK_DISCLAIMER } from '../../services/quality/quality-service.ts';
import type { BuildStep } from '../../services/export.ts';
import type { Web } from '../app.ts';
import {
  badge,
  button,
  card,
  findings,
  html,
  inr,
  kv,
  mediaUrl,
  postForm,
  select,
  table,
  when,
} from '../ui.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function registerQualityPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/quality', (req) => {
    const rows = s.projects.list().flatMap((p) =>
      s.stories.list(p.id).map((st) => {
        const yt = s.reports.latestQuality(st.id).find((q) => q.kind === 'youtube');
        return [
          p.name,
          html`<a href="/quality/${st.id}">${st.title}</a>`,
          yt ? badge(yt.status) : 'not run',
          s.reports.checklistComplete(st.id) ? badge('complete') : badge('pending'),
        ];
      }),
    );
    return web.render(
      req,
      'Quality Check',
      '/quality',
      card('Stories', table(['Project', 'Story', 'YouTube Quality Check', 'Human review'], rows)),
    );
  });

  r.get('/quality/:storyId', (req) => {
    const story = s.stories.get(req.params['storyId']!);
    const reports = s.reports.latestQuality(story.id);
    const byKind = new Map(reports.map((q) => [q.kind, q] as const));
    const sims = s.reports.similarity(story.id);
    const checklist = s.reports.checklist(story.id);
    const section = (kind: 'youtube' | 'story' | 'visual' | 'audio', title: string) => {
      const rep = byKind.get(kind);
      return card(
        `${title} ${rep ? '' : '(not run yet)'}`,
        rep
          ? html`<p>${badge(rep.status)} <small>${when(rep.created_at)}</small></p>
              ${findings(parseJson<Finding[]>(rep.findings_json, []))}`
          : html`<p class="muted">Run the checks.</p>`,
      );
    };
    const titleOf = (id: string) => {
      const o = s.db.get<{ title: string; episode_number: number | null }>(
        'SELECT title, episode_number FROM stories WHERE id = ?',
        id,
      );
      return o ? `${o.episode_number !== null ? `Ep ${o.episode_number}: ` : ''}${o.title}` : id;
    };
    return web.render(
      req,
      `Quality: ${story.title}`,
      '/quality',
      html`<p class="muted"><a href="/stories/${story.id}">← story</a></p>
        <p class="disclaimer">${YOUTUBE_CHECK_DISCLAIMER}</p>
        ${button(`/quality/${story.id}/run`, 'Run all checks', {}, { kind: 'primary' })}
        ${section('youtube', 'YouTube Quality Check (summary)')} ${section('story', 'Story')}
        ${section('visual', 'Visual')} ${section('audio', 'Audio')}
        ${card(
          'Content similarity report (vs previous episodes in this project)',
          html`${table(
              [
                'Compared with',
                'Story',
                'Dialogue',
                'Narration',
                'Shot plan',
                'Prompts',
                'Clip reuse',
                'Repeated clips',
                'Repeated audio',
                'Same title',
              ],
              sims.map((x) => [
                titleOf(x.compared_story_id),
                pct(x.story_similarity),
                pct(x.dialogue_similarity),
                pct(x.narration_similarity),
                pct(x.shot_plan_similarity),
                pct(x.prompt_similarity),
                pct(x.asset_reuse),
                x.repeated_clips,
                x.repeated_audio,
                x.title_duplicate ? 'yes' : 'no',
              ]),
              'No comparison yet (run the checks; needs an earlier episode).',
            )}
            ${findings(sims.flatMap((x) => parseJson<Finding[]>(x.findings_json, [])))}
            <p class="muted">
              Recurring characters, locations, intros/outros, music themes and catchphrases can be
              intentional. Tag intentional reuse in the Asset library.
            </p>`,
        )}
        ${card(
          'Human review gate',
          postForm(
            `/quality/${story.id}/checklist`,
            html`${checklist.map(
                (i) =>
                  html`<label class="check"
                    ><input
                      type="checkbox"
                      name="item"
                      value="${i.item_key}"
                      ${i.checked ? html` checked` : ''}
                    />
                    ${i.label}${i.checked_at ? html` <small>${when(i.checked_at)}</small>` : ''}</label
                  >`,
              )}<button class="primary">Save review</button>`,
          ),
        )}`,
    );
  });
  r.post('/quality/:storyId/run', async (req) => {
    const reports = await s.quality.runAll(req.params['storyId']!);
    const yt = reports.find((q) => q.kind === 'youtube');
    return web.redirect(`/quality/${req.params['storyId']}`, `Checks complete: ${yt?.status ?? 'n/a'}`);
  });
  r.post('/quality/:storyId/checklist', (req) => {
    const checked = new Set(req.formAll['item'] ?? []);
    for (const i of s.reports.checklist(req.params['storyId']!))
      s.reports.setChecklistItem(req.params['storyId']!, i.item_key, checked.has(i.item_key));
    return web.redirect(`/quality/${req.params['storyId']}`, 'Review checklist saved');
  });

  // --- Exports ------------------------------------------------------------------------
  r.get('/exports', (req) => {
    const all = s.reports.exports();
    const stories = s.projects
      .list()
      .flatMap((p) =>
        s.stories.list(p.id).map((st) => [st.id, `${p.name} — ${st.title}`] as [string, string]),
      );
    return web.render(
      req,
      'Exports',
      '/exports',
      html`${card(
        'BUILD FINAL',
        postForm(
          '/exports/build',
          html`<div class="row">
              ${select('Story', 'story_id', stories, '')}${select(
                'Format',
                'format',
                [
                  ['landscape', 'Landscape 1920×1080 (16:9)'],
                  ['vertical', 'Shorts 1080×1920 (9:16, reframed episode footage)'],
                ],
                'landscape',
              )}
            </div>
            <p class="muted">
              Validates approved shots, generates missing narration/dialogue/music/ambience/SFX, applies lip
              sync where a speaking mouth is visible, arranges the timeline, mixes (ducking, normalisation,
              peak protection), encodes and validates. Phase 1 writes a mock master (manifest + real WAV mix).
            </p>
            <button class="primary">BUILD FINAL</button>`,
        ),
      )}
      ${card(
        'Export history',
        table(
          ['Created', 'Story', 'Format', 'Status', 'Duration', 'Mock', ''],
          all.map((e) => [
            when(e.created_at),
            s.stories.get(e.story_id).title,
            `${e.format} ${e.width}×${e.height}@${e.fps}`,
            badge(e.status),
            e.duration_sec ? `${e.duration_sec.toFixed(1)}s` : '',
            e.is_mock ? 'yes' : 'no',
            html`<a href="/exports/${e.id}">details</a>`,
          ]),
        ),
      )}`,
    );
  });
  r.post('/exports/build', async (req) => {
    const exp = await s.exports.buildFinal(
      req.form['story_id'] ?? '',
      req.form['format'] === 'vertical' ? 'vertical' : 'landscape',
    );
    return exp.status === 'complete'
      ? web.redirect(`/exports/${exp.id}`, 'Export complete and validated')
      : web.redirect(`/exports/${exp.id}`, undefined, exp.error_message ?? 'Export failed');
  });
  r.get('/exports/:id', (req) => {
    const e = s.reports.getExport(req.params['id']!);
    const story = s.stories.get(e.story_id);
    const master = s.assets.find(e.master_asset_id);
    const mix = s.assets.find(e.mix_asset_id);
    const steps = parseJson<BuildStep[]>(e.steps_json, []);
    const cost = new AnalyticsService(s).storyCost(story.id, Boolean(e.is_mock));
    return web.render(
      req,
      `Export: ${story.title}`,
      '/exports',
      html`${card(
          'Result',
          kv([
            ['Status', badge(e.status)],
            [
              'Format',
              `${e.format} ${e.width}×${e.height} @${e.fps}fps · H.264/AAC${
                !master
                  ? ''
                  : master.mime !== 'video/mp4'
                    ? ' (mock master — no MP4 encoded: FFmpeg not installed or ASSEMBLY_MODE=mock)'
                    : master.is_mock
                      ? ' (real MP4, mock placeholder visuals)'
                      : ''
              }`,
            ],
            ['Duration', e.duration_sec ? `${e.duration_sec.toFixed(2)}s` : '—'],
            [
              'Master',
              master
                ? html`${master.mime === 'video/mp4'
                      ? html`<video
                            class="master"
                            controls
                            preload="metadata"
                            src="${mediaUrl(master.storage_key)}"
                          ></video
                          ><br />`
                      : ''}<a href="${mediaUrl(master.storage_key)}" download>${master.label}</a>`
                : '—',
            ],
            ['Final mix', mix ? html`<audio controls src="${mediaUrl(mix.storage_key)}"></audio>` : '—'],
            [
              'Episode cost',
              `${inr(cost.totalInr)}${e.is_mock ? ' (simulated)' : ''} · approved clips ${inr(cost.approvedClipsInr)}`,
            ],
            ['Error', e.error_message ?? '—'],
            ['Completed', when(e.completed_at)],
          ]),
        )}
        ${card(
          'Build steps',
          table(
            ['Step', 'Status', 'Detail'],
            steps.map((x) => [x.step, badge(x.status === 'ok' ? 'ok' : x.status), x.detail]),
          ),
        )}
        ${card('Export validation', findings(parseJson<Finding[]>(e.validation_json, [])))}
        <p><a href="/quality/${story.id}">Quality check & human review →</a></p>`,
    );
  });
}
