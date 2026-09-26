import { VIDEO_LENGTHS, VIDEO_STYLES, type VideoLength } from '../../domain/video-styles.ts';
import { AppError, toAppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import type { AttentionItem, Video } from '../../repositories/videos.ts';
import type { Web } from '../app.ts';
import { yes } from '../forms.ts';
import { raw } from '../html.ts';
import { button, card, html, inr, kv, mediaUrl, postForm, type SafeHtml } from '../ui.ts';
import { engineCard, videoStatusBadge } from './simple.ts';

/**
 * Simple Mode: CREATE (one page: idea, length, style, outputs → GENERATE), the video page (live
 * stages, plan review, needs attention, Video Ready) and the simple scene editor.
 */
export function registerCreatePages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/create', (req) => {
    const a = s.settings.get('app');
    const engine = s.engine.status();
    const canRun = engine.state === 'READY' || engine.state === 'DEVELOPER_TEST_MODE';
    const cloud = s.settings.get('cloud');
    const body = html`${canRun ? '' : engineCard(engine)}
    ${postForm(
      '/create',
      html`<label class="field"
          ><span class="big">What story would you like to create?</span
          ><textarea
            class="idea"
            name="idea"
            rows="4"
            required
            placeholder="Milo the fox cub helps a lost baby turtle find its way home to the river."
          ></textarea>
        </label>
        ${card(
          'Length',
          html`<div class="choice-grid">
              ${(
                Object.entries(VIDEO_LENGTHS) as Array<[VideoLength, (typeof VIDEO_LENGTHS)[VideoLength]]>
              ).map(
                ([k, v]) =>
                  html`<label class="choice"
                    ><input
                      type="radio"
                      name="length"
                      value="${k}"
                      ${k === a.defaultLength ? raw('checked') : ''}
                    />
                    <strong>${v.label}</strong><small>${v.hint}</small></label
                  >`,
              )}
            </div>
            <label class="field"
              ><span>Custom length (minutes)</span
              ><input
                type="number"
                name="customMinutes"
                value="${a.customMinutes}"
                step="0.5"
                min="0.5"
                max="30"
            /></label>`,
        )}
        ${card(
          'Style',
          html`<div class="choice-grid">
            ${VIDEO_STYLES.map(
              (st) =>
                html`<label class="choice"
                  ><input
                    type="radio"
                    name="style"
                    value="${st.id}"
                    ${st.id === a.defaultStyle ? raw('checked') : ''}
                  />
                  <strong>${st.label}</strong><small>${st.description}</small></label
                >`,
            )}
          </div>`,
        )}
        ${card(
          'Outputs',
          html`<label class="check"
              ><input type="hidden" name="episode" value="false" /><input
                type="checkbox"
                name="episode"
                value="true"
                ${a.makeEpisode ? raw('checked') : ''}
              />
              <strong>Full Episode</strong> — 16:9, 1920×1080</label
            >
            <label class="check"
              ><input type="hidden" name="shorts" value="false" /><input
                type="checkbox"
                name="shorts"
                value="true"
                ${a.makeShorts ? raw('checked') : ''}
              />
              <strong>Shorts</strong> — 9:16 for YouTube Shorts</label
            >`,
        )}
        <details class="card">
          <summary>More options</summary>
          <div class="row">
            <label class="field"
              ><span>Language</span
              ><select name="language">
                ${(
                  [
                    ['en', 'English'],
                    ['hi', 'Hindi'],
                    ['hinglish', 'Hinglish'],
                  ] as const
                ).map(
                  ([v, l]) =>
                    html`<option value="${v}" ${v === a.language ? raw('selected') : ''}>${l}</option>`,
                )}
              </select></label
            >
            <label class="field"
              ><span>Narrator</span
              ><select name="narrator">
                <option value="female" ${a.narrator === 'female' ? raw('selected') : ''}>Female voice</option>
                <option value="male" ${a.narrator === 'male' ? raw('selected') : ''}>Male voice</option>
              </select></label
            >
            <label class="field"
              ><span>Background music</span
              ><select name="music">
                ${['auto', 'calm', 'playful', 'adventure', 'emotional', 'off'].map(
                  (m) =>
                    html`<option value="${m}" ${m === a.backgroundMusic ? raw('selected') : ''}>
                      ${m === 'auto'
                        ? 'Automatic'
                        : m === 'off'
                          ? 'No music'
                          : m[0]!.toUpperCase() + m.slice(1)}
                    </option>`,
                )}
              </select></label
            >
            <label class="field"
              ><span>Shorts to make</span
              ><input type="number" name="shortsCount" value="${a.shortsCount}" min="1" max="5"
            /></label>
          </div>
          <label class="check"
            ><input type="hidden" name="reviewPlan" value="false" /><input
              type="checkbox"
              name="reviewPlan"
              value="true"
            />
            Let me review the story plan before the pictures are made</label
          >
        </details>
        <p class="muted">
          Real AI on a rented RunPod GPU. The GPU stops by itself when the video is done. Spending limit:
          ${inr(cloud.sessionBudgetInr)} per video (Settings).
        </p>
        <button class="primary huge" ${canRun ? '' : raw('disabled')}>GENERATE VIDEO</button>`,
    )}`;
    return web.render(req, 'Create', '/create', body);
  });

  r.post('/create', (req) => {
    const f = req.form;
    const engine = s.engine.status();
    if (engine.state === 'NEEDS_ATTENTION')
      throw new AppError(
        'PRECONDITION_FAILED',
        `The AI Engine needs attention first: ${engine.issues.map((i) => i.message).join(' ')}`,
      );
    const length = (Object.keys(VIDEO_LENGTHS) as VideoLength[]).find((k) => k === f['length']) ?? 'short';
    const v = s.orchestrator.create({
      idea: f['idea'] ?? '',
      length,
      customMinutes: Number(f['customMinutes'] ?? 2),
      styleId: f['style'] ?? s.settings.get('app').defaultStyle,
      makeEpisode: yes(f['episode']),
      makeShorts: yes(f['shorts']),
      shortsCount: Number(f['shortsCount'] ?? 2),
      language: f['language'] === 'hi' ? 'hi' : f['language'] === 'hinglish' ? 'hinglish' : 'en',
      narrator: f['narrator'] === 'male' ? 'male' : 'female',
      musicMood: f['music'] ?? 'auto',
      reviewPlan: yes(f['reviewPlan']),
    });
    startInBackground(web, v.id);
    return web.redirect(`/videos/${v.id}`, 'Started. You can leave this page; the video keeps being made.');
  });

  // --- the video page -------------------------------------------------------------------------------

  r.get('/videos/:id', (req) => {
    const v = s.videos.get(req.params['id']!);
    const stages = s.videos.stages(v);
    const running = v.status === 'generating';
    const stageList = html`<ol class="stages">
      ${stages.map(
        (st) =>
          html`<li class="${st.status}">
            <span class="st"
              >${{ pending: '○', running: '●', done: '✓', warn: '!', failed: '✗', skipped: '–' }[
                st.status
              ]}</span
            >
            <span><strong>${st.label}</strong>${st.detail ? html` — ${st.detail}` : ''}</span>
          </li>`,
      )}
    </ol>`;
    let main: SafeHtml;
    if (v.status === 'plan_review') main = planReview(v);
    else if (v.status === 'needs_attention' || v.status === 'failed') main = attention(web, v);
    else if (['ready', 'approved', 'scheduled', 'published'].includes(v.status)) main = videoReady(web, v);
    else if (v.status === 'cancelled')
      main = card(
        'Cancelled',
        html`<p>${v.stage_detail}</p>
          ${button(`/videos/${v.id}/continue`, 'CONTINUE MAKING THIS VIDEO', {}, { kind: 'primary' })}`,
      );
    else if (v.status === 'draft')
      main = card(
        'Not started',
        html`<p>${v.stage_detail || 'Press the button to make the video.'}</p>
          ${button(`/videos/${v.id}/continue`, 'MAKE VIDEO', {}, { kind: 'primary' })}`,
      );
    else
      main = card(
        'Making your video',
        html`<p>${v.stage_detail || 'Starting…'}</p>
          <p class="muted">
            This page refreshes every 5 seconds. You can close it; the video keeps being made.
          </p>
          ${button(
            `/videos/${v.id}/cancel`,
            'Cancel',
            {},
            {
              kind: 'danger',
              confirm: 'Stop making this video? The cloud GPU is stopped; what is finished is kept.',
            },
          )}`,
      );
    const body = html`${running ? raw('<meta http-equiv="refresh" content="5" />') : ''}
      <p>${videoStatusBadge(v)} <span class="muted">“${v.idea.slice(0, 200)}”</span></p>
      ${main} ${card('Progress', stageList)}`;
    return web.render(req, v.title, '/videos', body);
  });

  r.post('/videos/:id/continue', (req) => {
    const v = s.videos.get(req.params['id']!);
    // A stopped stage is run again from its start; finished stages are kept.
    const failed = s.videos.stages(v).find((x) => x.status === 'failed' || x.status === 'running');
    if (failed) s.videos.setStage(v.id, failed.stage, 'pending', '');
    s.videos.update(v.id, { status: 'generating', attention_json: '[]', error_message: null });
    startInBackground(web, v.id);
    return web.redirect(`/videos/${v.id}`, 'Continuing.');
  });
  r.post('/videos/:id/cancel', (req) => {
    s.orchestrator.cancel(req.params['id']!);
    return web.redirect(`/videos/${req.params['id']}`, 'Stopping… the cloud GPU is being shut down.');
  });
  r.post('/videos/:id/approve-plan', (req) => {
    const id = req.params['id']!;
    void s.orchestrator
      .approvePlan(id)
      .catch((err: unknown) => s.logger.error('video failed', { video: id, error: toAppError(err).message }));
    return web.redirect(`/videos/${id}`, 'Plan approved. Making the video.');
  });
  r.post('/videos/:id/skip/:shot', (req) => {
    s.orchestrator.skipShot(req.params['id']!, req.params['shot']!);
    return web.redirect(
      `/videos/${req.params['id']}`,
      'That shot was removed. Press CONTINUE to finish the video.',
    );
  });
  r.post('/videos/:id/regenerate', (req) => {
    const v = s.videos.get(req.params['id']!);
    const copy = s.orchestrator.create({
      idea: v.idea,
      length: v.length_key as VideoLength,
      customMinutes: v.target_seconds / 60,
      styleId: v.style_id,
      makeEpisode: !!v.make_episode,
      makeShorts: !!v.make_shorts,
      shortsCount: v.shorts_count,
      language: v.language as 'en' | 'hi' | 'hinglish',
      narrator: v.narrator === 'male' ? 'male' : 'female',
      musicMood: v.music_mood,
      reviewPlan: false,
    });
    startInBackground(web, copy.id);
    return web.redirect(
      `/videos/${copy.id}`,
      'A new version is being made from the same idea. The old one is kept.',
    );
  });

  // --- simple scene editor ------------------------------------------------------------------------------

  r.get('/videos/:id/edit', (req) => {
    const v = s.videos.get(req.params['id']!);
    if (!v.story_id) throw new AppError('PRECONDITION_FAILED', 'The story has not been written yet.');
    const tree = s.stories.tree(v.story_id);
    const body = html`<p>
        Change what is said, redraw a picture or re-animate a clip, then press <strong>REBUILD VIDEO</strong>.
        Only what you changed is made again.
      </p>
      ${tree.scenes.map(({ scene, narration, shots }) =>
        card(
          `Scene ${scene.position + 1}: ${scene.title}`,
          shots.map(({ shot, dialogue }) => {
            const img = shot.approved_image_asset_id ? s.assets.get(shot.approved_image_asset_id) : null;
            const lines = narration.filter((n) => n.shot_id === shot.id);
            return html`<div class="shot-edit" id="shot-${shot.id}">
              ${img
                ? html`<img src="${mediaUrl(img.storage_key)}" alt="" loading="lazy" width="240" />`
                : html`<div class="nothumb">no picture yet</div>`}
              ${postForm(
                `/videos/${v.id}/shots/${shot.id}/text`,
                html`<p class="muted">${shot.action}</p>
                  ${lines.map(
                    (n) =>
                      html`<label class="field"
                        ><span>Narrator</span><textarea name="n_${n.id}" rows="2">${n.text}</textarea>
                      </label>`,
                  )}
                  ${dialogue.map(
                    (d) =>
                      html`<label class="field"
                        ><span>${d.character_id ? s.characters.get(d.character_id).name : 'Line'}</span
                        ><textarea name="d_${d.id}" rows="2">${d.text}</textarea>
                      </label>`,
                  )}
                  ${lines.length || dialogue.length ? html`<button>Save words</button>` : ''}`,
              )}
              <div class="actions">
                ${button(`/videos/${v.id}/shots/${shot.id}/redraw`, 'Redraw picture')}
                ${shot.approved_image_asset_id
                  ? button(`/videos/${v.id}/shots/${shot.id}/reanimate`, 'Re-animate')
                  : ''}
                ${button(
                  `/videos/${v.id}/skip/${shot.id}`,
                  'Remove shot',
                  {},
                  { kind: 'danger', confirm: 'Remove this shot from the video?' },
                )}
              </div>
            </div>`;
          }),
        ),
      )}
      <div class="actions">
        ${button(`/videos/${v.id}/rebuild`, 'REBUILD VIDEO', {}, { kind: 'primary' })}
        <a class="btn" href="/stories/${v.story_id}">OPEN ADVANCED EDITOR</a>
      </div>`;
    return web.render(req, `Edit: ${v.title}`, '/videos', body);
  });

  r.post('/videos/:id/shots/:shot/text', (req) => {
    const v = s.videos.get(req.params['id']!);
    const shotId = req.params['shot']!;
    if (!v.story_id || s.stories.storyIdForShot(shotId) !== v.story_id)
      throw new AppError('NOT_FOUND', 'Shot not found');
    let changed = 0;
    for (const [k, text] of Object.entries(req.form)) {
      const value = text.trim();
      if (!value) continue;
      if (k.startsWith('n_')) {
        const n = s.stories.getNarration(k.slice(2));
        if (n.shot_id === shotId && n.text !== value)
          (s.stories.updateNarration(n.id, { text: value }), changed++);
      } else if (k.startsWith('d_')) {
        const d = s.stories.getDialogue(k.slice(2));
        if (d.shot_id === shotId && d.text !== value)
          (s.stories.updateDialogue(d.id, { text: value }), changed++);
      }
    }
    if (changed) markChanged(web, v, 'final');
    return web.redirect(
      `/videos/${v.id}/edit`,
      changed ? 'Saved. Press REBUILD VIDEO to hear it.' : 'Nothing changed.',
    );
  });
  r.post('/videos/:id/shots/:shot/redraw', (req) => {
    const v = s.videos.get(req.params['id']!);
    const shotId = req.params['shot']!;
    if (!v.story_id || s.stories.storyIdForShot(shotId) !== v.story_id)
      throw new AppError('NOT_FOUND', 'Shot not found');
    s.stories.setShotState(shotId, {
      approved_image_asset_id: null,
      approved_video_asset_id: null,
      lipsync_video_asset_id: null,
      approval_state: 'draft',
    });
    markChanged(web, v, 'images');
    return web.redirect(
      `/videos/${v.id}/edit`,
      'This picture will be drawn again when you press REBUILD VIDEO.',
    );
  });
  r.post('/videos/:id/shots/:shot/reanimate', (req) => {
    const v = s.videos.get(req.params['id']!);
    const shotId = req.params['shot']!;
    if (!v.story_id || s.stories.storyIdForShot(shotId) !== v.story_id)
      throw new AppError('NOT_FOUND', 'Shot not found');
    s.stories.setShotState(shotId, {
      approved_video_asset_id: null,
      lipsync_video_asset_id: null,
      approval_state: 'image_approved',
    });
    markChanged(web, v, 'animation');
    return web.redirect(
      `/videos/${v.id}/edit`,
      'This clip will be animated again when you press REBUILD VIDEO.',
    );
  });
  r.post('/videos/:id/rebuild', (req) => {
    const v = s.videos.get(req.params['id']!);
    s.videos.update(v.id, { status: 'generating' });
    startInBackground(web, v.id);
    return web.redirect(`/videos/${v.id}`, 'Rebuilding: only the changed parts are made again.');
  });
}

function startInBackground(web: Web, videoId: string): void {
  web.studio.orchestrator.start(videoId).catch((err: unknown) =>
    web.studio.logger.error('video production failed to start', {
      video: videoId,
      error: toAppError(err).message,
    }),
  );
}

/** Something was edited: stages from `from` onwards are made again at the next rebuild. */
function markChanged(web: Web, v: Video, from: string): void {
  const s = web.studio;
  const stages = s.videos.stages(v);
  const at = stages.findIndex((x) => x.stage === from);
  const earliest = stages.findIndex((x) => x.status === 'pending');
  if (earliest < 0 || at < earliest) s.videos.resetStagesFrom(v.id, from);
  s.videos.update(v.id, { status: 'draft', stage_detail: 'Changes are waiting: press REBUILD VIDEO.' });
}

interface PlanSummary {
  logline?: string;
  moral?: string;
  characters?: string[];
  scenes?: Array<{ title: string; shots: number }>;
  shots?: number;
  seconds?: number;
  newLooks?: number;
}

function planReview(v: Video): SafeHtml {
  const plan = parseJson<PlanSummary>(v.plan_json, {});
  return card(
    'Review the plan',
    html`${kv([
        ['Story', v.title],
        ['In one sentence', plan.logline ?? ''],
        ['Moral', plan.moral ?? ''],
        ['Characters', (plan.characters ?? []).join(', ')],
        ['Length', `${plan.shots ?? '?'} shots, about ${Math.round((plan.seconds ?? 0) / 6) / 10} minutes`],
        ['New character looks', String(plan.newLooks ?? 0)],
      ])}
      <ol>
        ${(plan.scenes ?? []).map((sc) => html`<li>${sc.title} — ${sc.shots} shot(s)</li>`)}
      </ol>
      <div class="actions">
        ${button(`/videos/${v.id}/approve-plan`, 'LOOKS GOOD — MAKE THE VIDEO', {}, { kind: 'primary' })}
        ${v.story_id
          ? html`<a class="btn" href="/stories/${v.story_id}">Change the story (Advanced)</a>`
          : ''}
        ${button(`/videos/${v.id}/cancel`, 'Cancel')}
      </div>`,
  );
}

function attention(web: Web, v: Video): SafeHtml {
  const items = web.studio.videos.attention(v);
  return card(
    'Needs attention',
    html`<ul class="issues">
        ${items.map(
          (i: AttentionItem) =>
            html`<li>
              ${i.message}
              ${i.shot_id
                ? html`<a class="btn" href="/videos/${v.id}/edit#shot-${i.shot_id}">Review Scene</a> ${button(
                      `/videos/${v.id}/skip/${i.shot_id}`,
                      'Skip',
                      {},
                      { confirm: 'Remove this shot from the video and continue without it?' },
                    )}`
                : ''}
            </li>`,
        )}
      </ul>
      ${v.error_message && !items.length ? html`<p>${v.error_message}</p>` : ''}
      <div class="actions">
        ${button(
          `/videos/${v.id}/continue`,
          items.some((i) => i.shot_id) ? 'RETRY' : 'CONTINUE',
          {},
          { kind: 'primary' },
        )}
      </div>`,
  );
}

function videoReady(web: Web, v: Video): SafeHtml {
  const s = web.studio;
  const exp = v.episode_export_id ? s.reports.getExport(v.episode_export_id) : null;
  const master = exp?.master_asset_id ? s.assets.get(exp.master_asset_id) : null;
  const qc = parseJson<Array<{ severity: string; message: string }>>(v.qc_json, []);
  const problems = qc.filter((q) => q.severity === 'fail');
  const warnings = qc.filter((q) => q.severity === 'warn');
  return html`${card(
    'Video Ready',
    html`${master
        ? html`<video
            class="player"
            controls
            ${v.thumbnail_key ? raw(`poster="${mediaUrl(v.thumbnail_key)}"`) : ''}
            src="${mediaUrl(master.storage_key)}"
          ></video>`
        : html`<p class="muted">No full episode was made for this video.</p>`}
      ${kv([
        ['Title', v.title],
        [
          'Length',
          exp?.duration_sec
            ? `${Math.floor(exp.duration_sec / 60)}:${String(Math.round(exp.duration_sec % 60)).padStart(2, '0')}`
            : '—',
        ],
        ['Format', exp ? `${exp.width}×${exp.height}, ${exp.fps} fps, H.264/AAC` : '—'],
        [
          'Made with',
          exp?.is_mock ? 'PLACEHOLDERS (developer test mode) — not real AI' : 'Real AI (RunPod GPU)',
        ],
        ['GPU cost', inr(v.cost_inr)],
      ])}
      <div class="actions">
        ${['ready'].includes(v.status) && web.router.match('GET', `/publish/${v.id}`)
          ? html`<a class="btn primary" href="/publish/${v.id}">REVIEW & PUBLISH</a>`
          : ''}
        ${master ? html`<a class="btn" href="${mediaUrl(master.storage_key)}" download>Download MP4</a>` : ''}
        <a class="btn" href="/videos/${v.id}/edit">Edit scenes</a>
        ${button(
          `/videos/${v.id}/regenerate`,
          'Make a new version',
          {},
          { confirm: 'Make a new version from the same idea? This one is kept.' },
        )}
      </div>`,
  )}
  ${card(
    'Quality check',
    problems.length || warnings.length
      ? html`<ul>
          ${[...problems, ...warnings].slice(0, 30).map(
            (q) =>
              html`<li>
                <span class="badge ${q.severity === 'fail' ? 'bad' : 'warn'}"
                  >${q.severity === 'fail' ? 'problem' : 'check'}</span
                >
                ${q.message}
              </li>`,
          )}
        </ul>`
      : html`<p>No problems found. (Technical checks only; watch the video before publishing.)</p>`,
  )}`;
}
