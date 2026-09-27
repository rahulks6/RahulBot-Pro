import { AppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import {
  BIBLE_SECTIONS,
  type ContinuityFact,
  type Episode,
  type FactKind,
  type Season,
  type Series,
} from '../../repositories/series.ts';
import { HINGLISH, languageName } from '../../services/localization.ts';
import { publicState } from '../../services/publisher.ts';
import { SeriesService } from '../../services/series.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { raw } from '../html.ts';
import { button, card, field, html, kv, mediaUrl, postForm, select, when, type SafeHtml } from '../ui.ts';
import { startInBackground } from './create.ts';

/**
 * Simple Mode: SERIES. The series screen (bible, characters, seasons, episodes, continuity,
 * languages, calendar), GENERATE NEXT EPISODE, PLAN SEASON, and the episode review screen where
 * the English and Hinglish versions are watched side by side and the episode is approved for canon.
 */
const STATUS_LABEL: Record<Episode['production_status'], [string, string]> = {
  planned: ['PLANNED', ''],
  generating: ['MAKING', 'warn'],
  qc: ['QUALITY CHECK', 'warn'],
  ready_for_review: ['READY FOR REVIEW', 'warn'],
  approved: ['APPROVED', 'good'],
  rejected: ['REJECTED', 'bad'],
  needs_attention: ['NEEDS ATTENTION', 'bad'],
  failed: ['FAILED', 'bad'],
  cancelled: ['CANCELLED', ''],
};

const FACT_KINDS: Array<[FactKind, string]> = [
  ['canon', 'Canon fact'],
  ['event', 'Event'],
  ['relationship', 'Relationship'],
  ['discovery', 'Discovery'],
  ['new_character', 'New character'],
  ['new_location', 'New location'],
  ['object_state', 'Object state'],
  ['character_state', 'Character state'],
  ['mystery_open', 'Open mystery'],
  ['mystery_resolved', 'Resolved mystery'],
];

type TimingReport = { lines?: number; rewritten?: number; paced?: number; flagged?: Array<{ text: string }> };

export function episodeBadge(e: Episode): SafeHtml {
  const [label, kind] = STATUS_LABEL[e.production_status];
  return html`<span class="badge ${kind}">${label}</span>`;
}

function episodeTitle(e: Episode): string {
  return e.title_en || e.working_title || (e.idea ? e.idea.slice(0, 60) : 'Idea chosen by the writer');
}

export function registerSeriesPages(web: Web): void {
  const s = web.studio;
  const r = web.router;
  const svc = new SeriesService(s);

  const str = (v: string | undefined, max: number) => (v ?? '').trim().slice(0, max);

  // --- the list + new series ----------------------------------------------------------------------

  const newSeriesForm = (): SafeHtml =>
    postForm(
      '/series',
      html`${field('Series name (a working title is fine)', 'name', '', {
          required: true,
          placeholder: 'Untitled Sci-Fi Series',
        })}
        ${field('One-line description', 'description', '', {
          placeholder: 'Two curious kids and a helper robot solve science mysteries.',
        })}
        <div class="row">
          ${select(
            'Start from',
            'starter',
            [
              ['scifi', 'An original sci-fi starter bible (editable)'],
              ['blank', 'An empty bible'],
            ],
            'scifi',
          )}
          ${field('Minutes per episode', 'minutes', 6, { type: 'number' })}
          ${field('Episodes in season 1', 'season_episodes', 30, { type: 'number' })}
        </div>
        <label class="check"
          ><input type="hidden" name="hinglish" value="false" /><input
            type="checkbox"
            name="hinglish"
            value="true"
            checked
          />
          Also make a Hinglish version of every episode (same pictures, Hinglish voices and captions)</label
        >
        <button class="primary">CREATE SERIES</button>`,
    );

  r.get('/series', (req) => {
    const list = s.series.list();
    const body = html`${list.length
      ? card(
          'Your series',
          html`<ul class="pub-list">
            ${list.map((x) => {
              const p = svc.pipeline(x.id);
              return html`<li>
                <a href="/series/${x.id}"><strong>${x.name}</strong></a>
                <span class="muted"
                  >${p['published']} published · ${p['scheduled']} scheduled · ${p['ready']} ready ·
                  ${p['generating']} being made · ${p['planned']} planned</span
                >
              </li>`;
            })}
          </ul>`,
        )
      : html`<p class="subtitle">
          A series keeps the same characters, world and rules across many episodes, and remembers what
          happened.
        </p>`}
    ${card('New series', newSeriesForm())}`;
    return web.render(req, 'Series', '/series', body);
  });

  r.post('/series', (req) => {
    const f = req.form;
    const series = svc.create({
      name: str(f['name'], 80),
      description: str(f['description'], 400),
      starter: f['starter'] === 'blank' ? 'blank' : 'scifi',
      episodeMinutes: Number(f['minutes'] ?? 6) || 6,
      seasonEpisodes: Number(f['season_episodes'] ?? 30) || 30,
      hinglish: yes(f['hinglish']),
    });
    return web.redirect(`/series/${series.id}`, `Series "${series.name}" created with Season 1.`);
  });

  // --- the series screen ------------------------------------------------------------------------------

  const episodeRow = (e: Episode): SafeHtml => {
    const pubs = e.video_id ? s.videos.publications(e.video_id).filter((p) => p.kind === 'episode') : [];
    const langs = pubs.map(
      (p) => html`<small class="muted">${languageName(p.language)}: ${publicState(p)}</small>`,
    );
    return html`<tr>
      <td>${e.number}</td>
      <td>
        ${e.production_status === 'planned'
          ? html`<strong>${episodeTitle(e)}</strong><br /><small class="muted">${e.premise || e.idea}</small>`
          : html`<a href="/series/episodes/${e.id}"><strong>${episodeTitle(e)}</strong></a>`}
        ${e.title_hi ? html`<br /><small>${e.title_hi}</small>` : ''}
      </td>
      <td>${episodeBadge(e)} ${langs.length ? html`<br />${langs}` : ''}</td>
      <td>
        ${e.production_status === 'planned'
          ? html`${button(`/series/episodes/${e.id}/make`, 'MAKE THIS EPISODE', {}, { kind: 'primary' })}
            ${button(
              `/series/episodes/${e.id}/remove`,
              'Remove',
              {},
              { confirm: 'Remove this planned idea?' },
            )}`
          : e.video_id
            ? html`<a href="/videos/${e.video_id}">Progress →</a>`
            : ''}
      </td>
    </tr>`;
  };

  const seasonCard = (series: Series, season: Season): SafeHtml => {
    const eps = s.series.episodes({ seasonId: season.id });
    const made = eps.filter((e) => e.production_status !== 'planned').length;
    return card(
      `Season ${season.number}${season.title && season.title !== `Season ${season.number}` ? ` — ${season.title}` : ''}`,
      html`<p class="muted">
          ${made} of ${season.episode_target} episodes made · ${eps.length - made} planned ·
          ${season.status.replace('_', ' ')}
        </p>
        ${eps.length
          ? html`<table class="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Episode</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${eps.map(episodeRow)}
              </tbody>
            </table>`
          : html`<p class="muted">No episodes yet.</p>`}
        ${postForm(
          `/series/${series.id}/seasons/${season.id}/plan`,
          html`<div class="row">
              ${field('How many episode ideas', 'count', 5, { type: 'number' })}
              <button>PLAN SEASON</button>
            </div>
            <small class="muted"
              >The story model suggests new episode ideas for this season that do not repeat earlier ones.
              They are saved as PLANNED; nothing is made until you press MAKE THIS EPISODE.</small
            >`,
          { cls: 'stack' },
        )}
        <details>
          <summary>Edit the season plan</summary>
          ${postForm(
            `/series/${series.id}/seasons/${season.id}`,
            html`<div class="row">
                ${field('Title', 'title', season.title)}
                ${field('Episode target', 'episode_target', season.episode_target, { type: 'number' })}
                ${select(
                  'Status',
                  'status',
                  [
                    ['planned', 'Planned'],
                    ['in_production', 'In production'],
                    ['complete', 'Complete'],
                  ],
                  season.status,
                )}
              </div>
              ${field('Season premise', 'premise', season.premise, { textarea: true })}
              ${field('Main mystery', 'main_mystery', season.main_mystery, { textarea: true, rows: 2 })}
              ${field('Character arcs', 'arcs', season.arcs, { textarea: true, rows: 2 })}
              ${field('Where it begins', 'beginning_state', season.beginning_state, {
                textarea: true,
                rows: 2,
              })}
              ${field('Midseason turn', 'midseason', season.midseason, { textarea: true, rows: 2 })}
              ${field('Where the finale leaves things', 'finale_state', season.finale_state, {
                textarea: true,
                rows: 2,
              })}
              <button>Save season</button>`,
          )}
        </details>`,
    );
  };

  const factList = (series: Series, facts: ContinuityFact[], retire: boolean): SafeHtml =>
    facts.length
      ? html`<ul class="pub-list">
          ${facts.map(
            (f) =>
              html`<li>
                <span class="badge">${FACT_KINDS.find(([k]) => k === f.kind)?.[1] ?? f.kind}</span>
                ${f.subject ? html`<strong>${f.subject}:</strong> ` : ''}${f.fact}
                ${f.episode_id
                  ? html`<small class="muted"> (episode ${s.series.episode(f.episode_id).number})</small>`
                  : ''}
                ${retire
                  ? button(
                      `/series/${series.id}/facts/${f.id}/retire`,
                      'Retire',
                      {},
                      {
                        confirm: 'Retire this fact? The writer stops using it (it stays in the history).',
                      },
                    )
                  : ''}
              </li>`,
          )}
        </ul>`
      : html`<p class="muted">None.</p>`;

  const characterCards = (series: Series): SafeHtml => {
    const chars = s.characters.list(series.project_id);
    return html`${chars.length
        ? chars.map((c) => {
            const prof = s.series.characterProfile(c.id);
            const p = parseJson<Record<string, string>>(prof?.profile_json, {});
            const h = s.series.hinglishStyle(prof);
            const pron = parseJson<Record<string, string>>(prof?.pronunciation_json, {});
            const hiVoice = parseJson<{ voice_profile_id?: string }>(prof?.voice_hi_json, {});
            const enVoice = c.voice_profile_id ? s.characters.getVoice(c.voice_profile_id) : null;
            const hv = hiVoice.voice_profile_id ? s.characters.getVoice(hiVoice.voice_profile_id) : null;
            return html`<details>
              <summary>
                <strong>${c.name}</strong> <span class="muted">${c.role || p['role'] || ''}</span>
              </summary>
              ${kv([
                ['Look', c.appearance || c.prompt || '—'],
                ['English voice', enVoice ? `${enVoice.name} (${enVoice.voice_identity || 'default'})` : '—'],
                [
                  'Hinglish voice',
                  hv ? `${hv.name} (${hv.voice_identity})` : 'chosen at the first Hinglish episode',
                ],
              ])}
              <p><a href="/library/characters/${c.id}">Look, reference pictures and locks →</a></p>
              ${postForm(
                `/series/${series.id}/characters/${c.id}`,
                html`<div class="row">
                    ${field('Role', 'role', c.role || p['role'] || '')}
                    ${field('Age', 'age', c.age || p['age'] || '')}
                  </div>
                  ${field('Personality', 'personality', c.personality || p['personality'] || '')}
                  ${field('Speech style', 'speech_style', p['speech_style'] ?? '')}
                  ${field('Catchphrases', 'catchphrases', p['catchphrases'] ?? '')}
                  ${field('Relationships', 'relationships', p['relationships'] ?? '')}
                  <h4>Hinglish style</h4>
                  <div class="row">
                    ${select(
                      'English words in Hinglish lines',
                      'english_share',
                      [
                        ['0.25', 'Few (25%)'],
                        ['0.4', 'Balanced (40%)'],
                        ['0.55', 'Many (55%)'],
                        ['0.7', 'Mostly English (70%)'],
                      ],
                      String(h.english_share),
                    )}
                    ${select(
                      'Tone',
                      'formality',
                      [
                        ['casual', 'Casual'],
                        ['neutral', 'Neutral'],
                        ['polite', 'Polite'],
                      ],
                      h.formality,
                    )}
                    ${field(
                      `How to say "${c.name}" (Devanagari, for the voice)`,
                      'pronunciation',
                      pron[c.name] ?? '',
                    )}
                  </div>
                  ${field('Notes for the Hinglish writer', 'notes', h.notes)}
                  <button>Save ${c.name}</button>`,
              )}
            </details>`;
          })
        : html`<p class="muted">
            No recurring characters yet. Add them below, or let the first episode create them.
          </p>`}
      <details>
        <summary>+ New recurring character</summary>
        ${postForm(
          `/series/${series.id}/characters`,
          html`${field('Name', 'name', '', { required: true })}
            <div class="row">
              ${field('Species / kind', 'species', 'human')} ${field('Role', 'role', '')}
              ${field('Age', 'age', '')}
            </div>
            ${field('Look (face, hair, clothes, colours)', 'appearance', '', { textarea: true, rows: 2 })}
            ${field('Personality', 'personality', '')}
            <small class="muted"
              >Only ORIGINAL characters: never copy an existing cartoon character's name or look.</small
            >
            <button class="primary">Add character</button>`,
        )}
      </details>`;
  };

  r.get('/series/:id', (req) => {
    const series = s.series.get(req.params['id']!);
    const seasons = s.series.seasons(series.id);
    const current = svc.currentSeason(series.id);
    const bible = s.series.bible(series);
    const counts = svc.pipeline(series.id);
    const hinglish = s.series.localizations(series).includes(HINGLISH);
    const busy = s.series
      .episodes({ seriesId: series.id })
      .find((e) => ['generating', 'qc'].includes(e.production_status));
    const engine = s.engine.status();
    const buffer = s.publisher.buffer();
    const calendar = s.publisher.calendar(21);
    const proposed = s.series.facts(series.id, { status: ['proposed'] });
    const nextPlanned = s.series
      .episodes({ seasonId: current.id })
      .find((e) => e.production_status === 'planned');
    const body = html`<p class="subtitle">${series.description || series.genre}</p>
      <p>
        <span class="badge good">${counts['published']} published</span>
        <span class="badge">${counts['scheduled']} scheduled</span>
        <span class="badge warn">${counts['ready']} ready for review</span>
        <span class="badge">${counts['generating']} being made</span>
        <span class="badge">${counts['planned']} planned</span>
        · Languages: English${hinglish ? ' + Hinglish' : ''}
      </p>
      ${card(
        'Generate next episode',
        busy
          ? html`<p>
              Episode ${busy.number} is being made now.
              <a href="/videos/${busy.video_id}">Watch its progress →</a>
            </p>`
          : postForm(
              `/series/${series.id}/episodes`,
              html`<p>
                  Season ${current.number}. The writer gets the series memory (bible, canon, recent episodes,
                  open mysteries) and avoids repeating earlier episodes.
                  ${nextPlanned
                    ? html`Leave the idea empty to make the next planned episode:
                        <strong>${nextPlanned.number}. ${episodeTitle(nextPlanned)}</strong>.`
                    : ''}
                </p>
                ${field('Your idea (leave empty and the AI chooses a new one)', 'idea', '', {
                  textarea: true,
                  rows: 3,
                  placeholder: 'The station clock skips one second every night and the kids find out why.',
                })}
                <div class="row">
                  ${field('Minutes', 'minutes', series.episode_minutes, { type: 'number' })}
                  ${field('Shorts (9:16)', 'shorts', 2, { type: 'number' })}
                </div>
                <label class="check"
                  ><input type="hidden" name="hinglish" value="false" /><input
                    type="checkbox"
                    name="hinglish"
                    value="true"
                    ${hinglish ? raw('checked') : ''}
                  />
                  Also make the Hinglish version</label
                >
                <button class="primary huge" ${engine.state === 'NEEDS_ATTENTION' ? raw('disabled') : ''}>
                  GENERATE EPISODE
                </button>
                ${engine.state === 'NEEDS_ATTENTION'
                  ? html`<p class="flash error">
                      The AI Engine needs attention first. <a href="/settings/ai-engine">Open AI Engine →</a>
                    </p>`
                  : ''}`,
            ),
      )}
      ${seasons.map((x) => seasonCard(series, x))}
      <p>
        ${button(
          `/series/${series.id}/seasons`,
          `+ Add Season ${seasons.length + 1}`,
          {},
          {
            confirm: `Add Season ${seasons.length + 1}?`,
          },
        )}
      </p>
      ${card(
        'Production calendar',
        html`${buffer.map(
            (b) =>
              html`<p>
                <strong>${b.channel}</strong> (${languageName(b.language)}): ${b.scheduled} episode(s)
                scheduled${b.through ? ` until ${when(b.through)}` : ''} · ${b.ready} ready for review
                ${b.scheduled < 2 ? html`<span class="badge warn">LOW BUFFER</span>` : ''}
              </p>`,
          )}
          ${calendar.length
            ? html`<ul class="pub-list">
                ${calendar.map(
                  (c) =>
                    html`<li>
                      ${when(c.at)} · <strong>${c.channel}</strong> ·
                      ${c.kind === 'short' ? 'Short' : 'Episode'}:
                      <a href="/publish/${c.videoId}">${c.title}</a>
                      <span class="badge">${c.state}</span>
                    </li>`,
                )}
              </ul>`
            : html`<p class="muted">Nothing scheduled in the next 3 weeks.</p>`}
          <p><a href="/publish/youtube">Channel schedules →</a></p>`,
      )}
      ${card('Characters (series canon)', characterCards(series))}
      ${card(
        'Continuity memory',
        html`<p class="muted">
            Canon is what the writer must respect. Facts from a new episode stay PROPOSED until you approve
            that episode; rejected episodes never change the canon.
          </p>
          <h3>Canon</h3>
          ${factList(series, s.series.facts(series.id, { status: ['canon'] }), true)}
          <h3>Proposed (waiting for episode approval)</h3>
          ${factList(series, proposed, false)}
          <details>
            <summary>+ Add a canon fact by hand</summary>
            ${postForm(
              `/series/${series.id}/facts`,
              html`<div class="row">
                  ${select('Kind', 'kind', FACT_KINDS, 'canon')}
                  ${field('About (name or thing)', 'subject', '')}
                </div>
                ${field('Fact', 'fact', '', { required: true })}
                <button>Add to canon</button>`,
            )}
          </details>`,
      )}
      ${card(
        'Series Bible',
        postForm(
          `/series/${series.id}/bible`,
          html`${BIBLE_SECTIONS.map(
              (sec) =>
                html`<details>
                  <summary>${sec}${bible[sec] ? '' : html` <small class="muted">(empty)</small>`}</summary>
                  ${field(sec, `bible_${sec}`, bible[sec] ?? '', { textarea: true, rows: 3 })}
                </details>`,
            )} <button class="primary">Save the bible</button>`,
        ),
      )}
      ${card(
        'Series settings',
        postForm(
          `/series/${series.id}/settings`,
          html`${field('Name', 'name', series.name, { required: true })}
            ${field('Description', 'description', series.description)}
            <div class="row">
              ${field('Target age', 'target_age', series.target_age)}
              ${field('Audience', 'target_audience', series.target_audience)}
              ${field('Minutes per episode', 'episode_minutes', series.episode_minutes, { type: 'number' })}
            </div>
            ${field('Tone', 'story_tone', series.story_tone)}
            <label class="check"
              ><input type="hidden" name="hinglish" value="false" /><input
                type="checkbox"
                name="hinglish"
                value="true"
                ${hinglish ? raw('checked') : ''}
              />
              Make a Hinglish version of every episode</label
            >
            <button>Save settings</button>`,
        ),
      )}`;
    return web.render(req, series.name, '/series', body);
  });

  r.post('/series/:id/settings', (req) => {
    const series = s.series.get(req.params['id']!);
    const f = req.form;
    const name = str(f['name'], 80);
    if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'Give the series a name.');
    const minutes = Number(f['episode_minutes']);
    s.series.update(series.id, {
      name,
      description: str(f['description'], 400),
      target_age: str(f['target_age'], 20) || series.target_age,
      target_audience: str(f['target_audience'], 120),
      story_tone: str(f['story_tone'], 200),
      episode_minutes: Number.isFinite(minutes) ? Math.min(15, Math.max(1, minutes)) : series.episode_minutes,
      localizations_json: JSON.stringify(yes(f['hinglish']) ? [HINGLISH] : []),
    });
    return web.redirect(`/series/${series.id}`, 'Series settings saved.');
  });

  r.post('/series/:id/bible', (req) => {
    const series = s.series.get(req.params['id']!);
    const bible: Record<string, string> = {};
    for (const sec of BIBLE_SECTIONS) {
      const v = str(req.form[`bible_${sec}`], 4000);
      if (v) bible[sec] = v;
    }
    s.series.update(series.id, { bible_json: JSON.stringify(bible) });
    return web.redirect(`/series/${series.id}`, 'Series Bible saved. New episodes use it.');
  });

  r.post('/series/:id/seasons', (req) => {
    const series = s.series.get(req.params['id']!);
    const seasons = s.series.seasons(series.id);
    const number = (seasons[seasons.length - 1]?.number ?? 0) + 1;
    for (const x of seasons.filter((x) => x.status === 'in_production'))
      s.series.updateSeason(x.id, { status: 'complete' });
    s.series.createSeason({
      series_id: series.id,
      number,
      title: `Season ${number}`,
      episode_target: seasons[seasons.length - 1]?.episode_target ?? 12,
      status: 'in_production',
    });
    return web.redirect(`/series/${series.id}`, `Season ${number} added; new episodes go there.`);
  });

  r.post('/series/:id/seasons/:sid', (req) => {
    const season = s.series.season(req.params['sid']!);
    if (season.series_id !== req.params['id']) throw new AppError('NOT_FOUND', 'Season not found.');
    const f = req.form;
    const target = Math.round(Number(f['episode_target']));
    s.series.updateSeason(season.id, {
      title: str(f['title'], 80) || season.title,
      episode_target: target >= 1 && target <= 200 ? target : season.episode_target,
      status:
        (['planned', 'in_production', 'complete'] as const).find((x) => x === f['status']) ?? season.status,
      premise: str(f['premise'], 2000),
      main_mystery: str(f['main_mystery'], 1000),
      arcs: str(f['arcs'], 1000),
      beginning_state: str(f['beginning_state'], 1000),
      midseason: str(f['midseason'], 1000),
      finale_state: str(f['finale_state'], 1000),
    });
    return web.redirect(`/series/${season.series_id}`, 'Season saved.');
  });

  r.post('/series/:id/seasons/:sid/plan', async (req) => {
    const season = s.series.season(req.params['sid']!);
    if (season.series_id !== req.params['id']) throw new AppError('NOT_FOUND', 'Season not found.');
    const engine = s.engine.status();
    if (engine.state === 'NEEDS_ATTENTION')
      throw new AppError(
        'PRECONDITION_FAILED',
        'The AI Engine needs attention first (Settings → AI Engine).',
      );
    const { created, skipped } = await svc.planSeason(season.id, Number(req.form['count'] ?? 5));
    return web.redirect(
      `/series/${season.series_id}`,
      `${created.length} episode idea(s) planned${skipped.length ? `; skipped as repeats: ${skipped.join(', ')}` : ''}.`,
    );
  });

  r.post('/series/:id/episodes', (req) => {
    const series = s.series.get(req.params['id']!);
    const f = req.form;
    const engine = s.engine.status();
    if (engine.state === 'NEEDS_ATTENTION')
      throw new AppError(
        'PRECONDITION_FAILED',
        'The AI Engine needs attention first (Settings → AI Engine).',
      );
    const shorts = Math.max(0, Math.min(5, Math.round(Number(f['shorts'] ?? 2)) || 0));
    const minutes = Number(f['minutes']);
    const idea = str(f['idea'], 2000);
    // No idea typed: the next PLANNED idea of the season is made first (if there is one).
    const next = idea
      ? undefined
      : s.series
          .episodes({ seasonId: svc.currentSeason(series.id).id })
          .find((e) => e.production_status === 'planned');
    const { episode, video } = svc.startEpisode({
      seriesId: series.id,
      idea,
      ...(next ? { episodeId: next.id } : {}),
      ...(Number.isFinite(minutes) && minutes > 0 ? { minutes: Math.min(15, Math.max(0.3, minutes)) } : {}),
      hinglish: yes(f['hinglish']),
      makeShorts: shorts > 0,
      shortsCount: Math.max(1, shorts),
    });
    startInBackground(web, video.id);
    return web.redirect(
      `/series/episodes/${episode.id}`,
      `Episode ${episode.number} started. You can leave this page; it keeps being made.`,
    );
  });

  r.post('/series/episodes/:eid/make', (req) => {
    const e = s.series.episode(req.params['eid']!);
    const engine = s.engine.status();
    if (engine.state === 'NEEDS_ATTENTION')
      throw new AppError(
        'PRECONDITION_FAILED',
        'The AI Engine needs attention first (Settings → AI Engine).',
      );
    const { episode, video } = svc.startEpisode({
      seriesId: e.series_id,
      seasonId: e.season_id,
      episodeId: e.id,
    });
    startInBackground(web, video.id);
    return web.redirect(`/series/episodes/${episode.id}`, `Episode ${episode.number} started.`);
  });

  r.post('/series/episodes/:eid/remove', (req) => {
    const e = s.series.episode(req.params['eid']!);
    svc.deletePlanned(e.id);
    return web.redirect(`/series/${e.series_id}`, 'Planned idea removed.');
  });

  r.post('/series/:id/characters', (req) => {
    const series = s.series.get(req.params['id']!);
    const f = req.form;
    const c = s.characters.create(series.project_id, {
      name: str(f['name'], 60),
      species: str(f['species'], 60) || 'human',
      role: str(f['role'], 120),
      age: str(f['age'], 30),
      appearance: str(f['appearance'], 1000),
      personality: str(f['personality'], 400),
      prompt: str(f['appearance'], 1000),
    });
    s.series.saveCharacterProfile(series.id, c.id, {
      profile_json: JSON.stringify({ role: c.role, personality: c.personality, age: c.age }),
    });
    return web.redirect(`/series/${series.id}`, `${c.name} added to the series.`);
  });

  r.post('/series/:id/characters/:cid', (req) => {
    const series = s.series.get(req.params['id']!);
    const c = s.characters.get(req.params['cid']!);
    if (c.project_id !== series.project_id) throw new AppError('NOT_FOUND', 'Character not found.');
    const f = req.form;
    const prof = s.series.characterProfile(c.id);
    const profile = {
      ...parseJson<Record<string, string>>(prof?.profile_json, {}),
      role: str(f['role'], 120),
      age: str(f['age'], 30),
      personality: str(f['personality'], 400),
      speech_style: str(f['speech_style'], 300),
      catchphrases: str(f['catchphrases'], 300),
      relationships: str(f['relationships'], 400),
    };
    const share = Number(f['english_share']);
    const pron = str(f['pronunciation'], 60);
    if (pron && !/[ऀ-ॿ]/.test(pron))
      throw new AppError(
        'VALIDATION_FAILED',
        'Write the pronunciation in Devanagari (e.g. आइरा), or leave it empty.',
      );
    s.series.saveCharacterProfile(series.id, c.id, {
      profile_json: JSON.stringify(profile),
      hinglish_json: JSON.stringify({
        english_share: Number.isFinite(share) ? Math.min(0.9, Math.max(0.1, share)) : 0.4,
        formality: (['casual', 'neutral', 'polite'] as const).find((x) => x === f['formality']) ?? 'casual',
        notes: str(f['notes'], 300),
      }),
      pronunciation_json: JSON.stringify({
        ...parseJson<Record<string, string>>(prof?.pronunciation_json, {}),
        [c.name]: pron,
      }),
    });
    s.characters.update(c.id, { role: profile.role, age: profile.age, personality: profile.personality });
    return web.redirect(`/series/${series.id}`, `${c.name} saved.`);
  });

  r.post('/series/:id/facts', (req) => {
    const series = s.series.get(req.params['id']!);
    const f = req.form;
    const fact = str(f['fact'], 400);
    if (!fact) throw new AppError('VALIDATION_FAILED', 'Write the fact.');
    s.series.addFact({
      series_id: series.id,
      kind: FACT_KINDS.find(([k]) => k === f['kind'])?.[0] ?? 'canon',
      subject: str(f['subject'], 80),
      fact,
      status: 'canon',
    });
    return web.redirect(`/series/${series.id}`, 'Added to the canon.');
  });

  r.post('/series/:id/facts/:fid/retire', (req) => {
    const series = s.series.get(req.params['id']!);
    const changed = s.db.run(
      "UPDATE continuity_facts SET status = 'retired' WHERE id = ? AND series_id = ? AND status = 'canon'",
      req.params['fid']!,
      series.id,
    ).changes;
    if (!changed) throw new AppError('NOT_FOUND', 'That canon fact was not found.');
    return web.redirect(`/series/${series.id}`, 'Fact retired.');
  });

  // --- the episode review screen ------------------------------------------------------------------

  r.get('/series/episodes/:eid', (req) => {
    const e = s.series.episode(req.params['eid']!);
    const series = s.series.get(e.series_id);
    const season = s.series.season(e.season_id);
    const v = e.video_id ? s.videos.get(e.video_id) : null;
    const stages = v ? s.videos.stages(v) : [];
    const locs = v ? s.series.videoLocalizations(v.id) : [];
    const exp = v?.episode_export_id ? s.reports.getExport(v.episode_export_id) : null;
    const enKey = exp?.master_asset_id ? s.assets.get(exp.master_asset_id).storage_key : null;
    const player = (key: string | null, poster: string | null, vertical = false): SafeHtml =>
      key
        ? html`<video
            controls
            preload="metadata"
            src="${mediaUrl(key)}"
            ${poster ? raw(`poster="${mediaUrl(poster)}"`) : ''}
            style="width:${vertical ? '200px' : '100%'}"
          ></video>`
        : html`<p class="muted">Not made yet.</p>`;
    const prefix = `S${String(season.number).padStart(2, '0')}E${String(e.number).padStart(2, '0')}`;
    /** Download links with clear file names, e.g. S01E03_EPISODE_HINGLISH.mp4. */
    const downloads = (
      lang: 'EN' | 'HINGLISH',
      video: string | null,
      srt: string | null,
      vtt: string | null,
    ): SafeHtml =>
      video
        ? html`<p>
            <a class="btn" href="${mediaUrl(video)}" download="${prefix}_EPISODE_${lang}.mp4">Download MP4</a>
            ${srt ? html`<a href="${mediaUrl(srt)}" download="${prefix}_EPISODE_${lang}.srt">SRT</a>` : ''}
            ${vtt
              ? html` · <a href="${mediaUrl(vtt)}" download="${prefix}_EPISODE_${lang}.vtt">WebVTT</a>`
              : ''}
          </p>`
        : html``;
    const continuity = parseJson<Array<{ severity: string; message: string; fixed?: boolean }>>(
      e.continuity_json,
      [],
    );
    const similar = parseJson<Array<{ number: number; score: number; fields?: string[] }>>(
      e.similarity_json,
      [],
    );
    const proposed = s.series.facts(series.id, {
      status: ['proposed', 'canon', 'rejected'],
      episodeId: e.id,
    });
    const epLoc = locs.find((l) => !l.short_id);
    const shorts = v ? s.videos.shorts(v.id).filter((x) => x.status === 'ready') : [];
    const finished = ['ready_for_review', 'needs_attention', 'approved', 'rejected'].includes(
      e.production_status,
    );
    const qa = epLoc
      ? parseJson<Array<{ speaker: string; hinglish: string; issues: Array<{ message: string }> }>>(
          epLoc.qa_json,
          [],
        )
      : [];
    const timing = epLoc ? parseJson<TimingReport>(epLoc.timing_json, {}) : {};
    const flagged = Array.isArray(timing.flagged) ? timing.flagged : [];
    const body = html`<p class="subtitle">
        <a href="/series/${series.id}">${series.name}</a> · Season ${season.number} · Episode ${e.number}
        ${episodeBadge(e)}
      </p>
      ${e.title_hi ? html`<p>Hinglish title: <strong>${e.title_hi}</strong></p>` : ''}
      ${v && ['generating', 'qc'].includes(e.production_status)
        ? card(
            'Progress',
            html`<ol class="stages">
                ${stages.map(
                  (x) =>
                    html`<li class="${x.status}">
                      <strong>${x.label}</strong> <span class="badge">${x.status.toUpperCase()}</span>
                      ${x.detail ? html`<br /><small>${x.detail}</small>` : ''}
                    </li>`,
                )}
              </ol>
              <p><a href="/videos/${v.id}">Full progress and CANCEL →</a></p>`,
          )
        : ''}
      ${e.synopsis || e.premise || e.lesson
        ? card(
            'Story',
            kv([
              ['Idea', e.idea || 'chosen by the writer'],
              ['Synopsis', e.synopsis || e.premise || '—'],
              ['Lesson', e.lesson || '—'],
              ['Continuity', e.continuity_summary || '—'],
            ]),
          )
        : ''}
      ${finished && v
        ? card(
            'Watch both versions',
            html`<div class="row">
                <div>
                  <h3>English</h3>
                  ${player(enKey, v.thumbnail_key)}
                  ${downloads('EN', enKey, v.captions_srt_key, v.captions_vtt_key)}
                </div>
                <div>
                  <h3>Hinglish</h3>
                  ${epLoc
                    ? html`${player(epLoc.video_key, epLoc.thumbnail_key)}
                        ${downloads(
                          'HINGLISH',
                          epLoc.video_key,
                          epLoc.captions_srt_key,
                          epLoc.captions_vtt_key,
                        )}
                        <span class="badge ${epLoc.status === 'ready' ? 'good' : 'warn'}"
                          >${epLoc.status.toUpperCase()}</span
                        >`
                    : html`<p class="muted">No Hinglish version for this episode.</p>`}
                </div>
              </div>
              ${shorts.length
                ? html`<h3>Shorts</h3>
                    <div class="row">
                      ${shorts.map((sh) => {
                        const hi = locs.find((l) => l.short_id === sh.id);
                        return html`<div>
                          <small>Short ${sh.idx + 1} — English</small>${player(
                            sh.video_key,
                            sh.thumbnail_key,
                            true,
                          )}
                          ${hi
                            ? html`<small>Short ${sh.idx + 1} — Hinglish</small>${player(
                                  hi.video_key,
                                  hi.thumbnail_key,
                                  true,
                                )}`
                            : ''}
                        </div>`;
                      })}
                    </div>`
                : ''}`,
          )
        : ''}
      ${card(
        'Checks',
        html`${similar.length
            ? html`<p class="flash error">
                Similar to earlier episode(s):
                ${similar
                  .map(
                    (x) =>
                      `episode ${x.number} (${Math.round(x.score * 100)}%${x.fields?.length ? `: ${x.fields.join(', ')}` : ''})`,
                  )
                  .join('; ')}
              </p>`
            : html`<p class="good">No repeat of an earlier episode found.</p>`}
          <h3>Continuity</h3>
          ${continuity.length
            ? html`<ul>
                ${continuity.map(
                  (c) =>
                    html`<li>
                      <span class="badge ${c.severity === 'error' ? 'bad' : c.fixed ? 'good' : 'warn'}"
                        >${c.fixed ? 'FIXED' : c.severity.toUpperCase()}</span
                      >
                      ${c.message}
                    </li>`,
                )}
              </ul>`
            : html`<p class="muted">No continuity problems found.</p>`}
          ${epLoc
            ? html`<h3>Hinglish</h3>
                <p>
                  ${timing.lines ?? 0} line(s) · ${timing.rewritten ?? 0} rewritten shorter ·
                  ${timing.paced ?? 0} paced slightly faster · ${flagged.length} still too long
                </p>
                ${flagged.length || qa.length
                  ? html`<ul>
                      ${flagged.map((x) => html`<li><span class="badge warn">TIMING</span> ${x.text}</li>`)}
                      ${qa
                        .slice(0, 20)
                        .map(
                          (q) =>
                            html`<li>
                              <span class="badge warn">STYLE</span> ${q.speaker}: "${q.hinglish}" —
                              ${q.issues.map((i) => i.message).join('; ')}
                            </li>`,
                        )}
                    </ul>`
                  : ''}`
            : ''}`,
      )}
      ${card(
        'What this episode adds to the canon',
        html`${proposed.length
          ? html`<ul>
              ${proposed.map(
                (f) =>
                  html`<li>
                    <span
                      class="badge ${f.status === 'canon'
                        ? 'good'
                        : f.status === 'rejected'
                          ? 'bad'
                          : 'warn'}"
                      >${f.status.toUpperCase()}</span
                    >
                    ${f.subject ? html`<strong>${f.subject}:</strong> ` : ''}${f.fact}
                  </li>`,
              )}
            </ul>`
          : html`<p class="muted">Nothing new.</p>`}
        ${['ready_for_review', 'needs_attention'].includes(e.production_status)
          ? html`<div class="actions">
                ${button(
                  `/series/episodes/${e.id}/approve`,
                  'APPROVE EPISODE',
                  {},
                  {
                    kind: 'primary',
                    confirm: 'Approve this episode? Its proposed facts become canon for later episodes.',
                  },
                )}
                ${button(
                  `/series/episodes/${e.id}/reject`,
                  'REJECT',
                  {},
                  {
                    kind: 'danger',
                    confirm: 'Reject this episode? Nothing from it enters the canon. The videos are kept.',
                  },
                )}
              </div>
              <p class="muted">Approving the story does not upload anything.</p>`
          : ''}`,
      )}
      ${v && finished
        ? card(
            'Publish',
            html`<p>
                Both language versions wait in Publish, each for its own channel. Nothing is uploaded until
                you press APPROVE there (APPROVE BOTH, or one at a time).
              </p>
              <p><a class="btn primary" href="/publish/${v.id}">Review and publish →</a></p>`,
          )
        : ''}`;
    return web.render(req, `Episode ${e.number}: ${episodeTitle(e)}`, '/series', body);
  });

  r.post('/series/episodes/:eid/approve', (req) => {
    const e = svc.approve(req.params['eid']!);
    return web.redirect(`/series/episodes/${e.id}`, `Episode ${e.number} approved: its facts are now canon.`);
  });

  r.post('/series/episodes/:eid/reject', (req) => {
    const e = svc.reject(req.params['eid']!);
    return web.redirect(`/series/episodes/${e.id}`, `Episode ${e.number} rejected: the canon is unchanged.`);
  });
}

/** Home: one line per series with the next step. */
export function continueSeriesCard(web: Web): SafeHtml {
  const s = web.studio;
  const list = s.series.list().filter((x) => x.status === 'active');
  if (!list.length) return html``;
  const svc = new SeriesService(s);
  return card(
    'Continue Series',
    html`<ul class="pub-list">
      ${list.map((x) => {
        const p = svc.pipeline(x.id);
        const season = svc.currentSeason(x.id);
        return html`<li>
          <a href="/series/${x.id}"><strong>${x.name}</strong></a>
          <span class="muted"
            >Season ${season.number}, next episode ${s.series.nextEpisodeNumber(season.id)} · ${p['ready']}
            ready for review · ${p['scheduled']} scheduled</span
          >
          <a class="btn primary" href="/series/${x.id}">GENERATE NEXT EPISODE</a>
        </li>`;
      })}
    </ul>`,
  );
}
