import { EMOTIONS, QUALITY_MODES, STORY_STATUSES } from '../../domain/enums.ts';
import type { GeneratedAsset, GenerationAttempt, Scene, Shot } from '../../domain/types.ts';
import { AppError } from '../../lib/errors.ts';
import { parseJson } from '../../lib/json.ts';
import type { MockVideoManifest } from '../../providers/mock/image.ts';
import { suggestReuse } from '../../services/reuse.ts';
import { suggestAmbience, suggestMusicMood, suggestShotSfx } from '../../services/sfx-suggest.ts';
import { importStoryPackage, MAX_PACKAGE_BYTES, validateStoryPackage } from '../../services/story-package.ts';
import type { Web } from '../app.ts';
import { formPatch } from '../forms.ts';
import {
  assetPreview,
  badge,
  button,
  card,
  checkbox,
  field,
  grid,
  html,
  inr,
  kv,
  options,
  postForm,
  select,
  table,
  when,
  type SafeHtml,
} from '../ui.ts';

export async function posterFor(web: Web, asset: GeneratedAsset | undefined): Promise<string | undefined> {
  if (!asset || !asset.mime.includes('mock-video')) return undefined;
  try {
    const m = JSON.parse((await web.studio.assets.read(asset.id)).toString('utf8')) as MockVideoManifest;
    return m.sourceImageKey;
  } catch {
    return undefined;
  }
}

export async function preview(web: Web, assetId: string | null | undefined): Promise<SafeHtml> {
  const a = web.studio.assets.find(assetId);
  if (!a) return html`<div class="noposter">—</div>`;
  return assetPreview(a, await posterFor(web, a));
}

function sceneForm(web: Web, projectId: string, sc: Partial<Scene> = {}) {
  const s = web.studio;
  return html` ${field('Title', 'title', sc.title, { required: true })}
    ${field('Summary', 'summary', sc.summary, { textarea: true })}
    <div class="row">
      ${select(
        'Location',
        'location_id',
        options(s.characters.listLocations(projectId), (l) => `${l.name}${l.locked ? ' 🔒' : ''}`),
        sc.location_id,
      )}
      ${field('Time of day', 'time_of_day', sc.time_of_day)}
    </div>
    <div class="row">
      ${field('Music mood', 'music_mood', sc.music_mood, { placeholder: 'e.g. gentle suspense' })}
      ${field('Music genre', 'music_genre', sc.music_genre)}
      ${select(
        'Music energy',
        'music_energy',
        [
          ['', '—'],
          ['low', 'low'],
          ['medium', 'medium'],
          ['high', 'high'],
        ],
        sc.music_energy,
      )}
      ${field('Ambience', 'ambience', sc.ambience, { placeholder: 'e.g. forest, rain, city' })}
    </div>
    ${field('Notes', 'notes', sc.notes, { textarea: true, rows: 2 })}`;
}

function shotForm(web: Web, projectId: string, sh: Partial<Shot> = {}) {
  const s = web.studio;
  return html` <div class="row">
      ${field('Title', 'title', sh.title)}${field('Emotion', 'emotion', sh.emotion)}
    </div>
    ${field('Action', 'action', sh.action, { textarea: true, rows: 2 })}
    <div class="row">
      ${field('Framing', 'framing', sh.framing, { placeholder: 'wide / medium / close-up' })}
      ${field('Camera angle', 'camera_angle', sh.camera_angle)}
      ${field('Camera movement', 'camera_movement', sh.camera_movement)}
      ${field('Lighting', 'lighting', sh.lighting)}
    </div>
    <div class="row">
      ${select(
        'Location (overrides scene)',
        'location_id',
        options(s.characters.listLocations(projectId), (l) => l.name),
        sh.location_id,
      )}
      ${select(
        'Style (overrides project)',
        'style_id',
        options(s.projects.listStyles(projectId), (x) => x.name),
        sh.style_id,
      )}
      ${select(
        'Generation mode',
        'generation_mode',
        QUALITY_MODES.map((q) => [q, q.replace('_', ' ')]),
        sh.generation_mode ?? 'optimized',
      )}
    </div>
    <div class="row">
      ${field('Duration (s)', 'duration_sec', sh.duration_sec ?? 5, { type: 'number', step: '0.1' })}
      ${select(
        'FPS',
        'fps',
        [
          ['24', '24'],
          ['30', '30'],
        ],
        sh.fps ?? 24,
      )}
      ${field('Seed', 'seed', sh.seed ?? '', { type: 'number', help: 'Empty = new seed per attempt' })}
    </div>
    <div class="row">
      ${checkbox('Speaking mouth visible', 'mouth_visible', sh.mouth_visible ?? 0)}
      ${checkbox('Lip sync enabled', 'lipsync_enabled', sh.lipsync_enabled ?? 1)}
    </div>
    <div class="row">
      ${field('Music notes', 'music_notes', sh.music_notes)}${field(
        'Ambience notes',
        'ambience_notes',
        sh.ambience_notes,
      )}
    </div>`;
}

function attemptCard(a: GenerationAttempt, previewHtml: SafeHtml): SafeHtml {
  const settings = parseJson<Record<string, unknown>>(a.settings_json, {});
  const actions =
    a.status === 'succeeded' && a.output_asset_id && (a.kind === 'image' || a.kind === 'video')
      ? html`<div class="actions">
          ${a.approval !== 'approved'
            ? button(`/attempts/${a.id}/approve`, 'Approve', {}, { kind: 'primary' })
            : ''}${a.approval !== 'rejected'
            ? button(`/attempts/${a.id}/reject`, 'Reject', {}, { kind: 'danger' })
            : ''}
        </div>`
      : '';
  return html`<article class="attempt ${a.approval}">
    ${a.output_asset_id ? previewHtml : html`<div class="noposter failed">${a.error_code ?? a.status}</div>`}
    <div class="meta">
      ${badge(a.status)} ${badge(a.approval)} <small>#${a.attempt_number} · ${when(a.created_at)}</small>
    </div>
    ${kv([
      ['Model', `${a.model} ${a.model_version}`],
      ['Seed', a.seed ?? '—'],
      [
        'Resolution',
        a.width
          ? `${a.width}×${a.height}${settings['native'] === false ? (a.kind === 'video' ? ' (upscaled to the target resolution)' : ' (below the target resolution)') : ''}`
          : '—',
      ],
      ['GPU', a.gpu_model ?? a.provider],
      ['Time / cost', `${a.generation_seconds}s · ${inr(a.estimated_cost_inr)}${a.is_mock ? ' sim' : ''}`],
      ['Error', a.error_message ?? '—'],
    ])}
    <details>
      <summary>Prompt</summary>
      <p class="prompt">${a.prompt}</p>
      <p class="prompt neg">${a.negative_prompt}</p>
    </details>
    ${actions}
  </article>`;
}

export function registerStoryPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/stories', (req) => {
    const rows = s.projects
      .list()
      .flatMap((p) =>
        s.stories
          .list(p.id)
          .map((st) => [
            html`<a href="/projects/${p.id}">${p.name}</a>`,
            st.episode_number ?? '',
            html`<a href="/stories/${st.id}">${st.title}</a>`,
            badge(st.status),
            s.stories.listScenes(st.id).length,
            s.stories.listStoryShots(st.id).length,
            when(st.updated_at),
          ]),
      );
    return web.render(
      req,
      'Stories',
      '/stories',
      html`<p><a class="btn primary" href="/stories/import">Import Story Package</a></p>
        ${card(
          'All stories / episodes',
          table(['Project', 'Ep', 'Title', 'Status', 'Scenes', 'Shots', 'Updated'], rows),
        )}`,
    );
  });

  // --- Story Package import ----------------------------------------------------------
  r.get('/stories/import', (req) => {
    const projectId = req.query.get('project') ?? '';
    const imports = s.reports.imports(10);
    return web.render(
      req,
      'Import Story Package',
      '/stories',
      html`${card(
        'Story Package',
        postForm(
          '/stories/import',
          html`<p>
              Paste or load a Story Package JSON (<a href="/docs/story-package">format reference</a>). It is
              fully validated before anything is written; failed imports change nothing.
            </p>
            ${select(
              'Import into',
              'project_id',
              options(s.projects.list(), (p) => p.name, '— create a new project from the package —'),
              projectId,
            )}
            <label class="field"
              ><span>Load file</span
              ><input type="file" accept=".json,application/json" data-read-into="package"
            /></label>
            ${field('Package JSON', 'package', req.query.get('draft') ?? '', { textarea: true, rows: 16 })}
            <div class="actions">
              <button name="_mode" value="validate">Validate only</button
              ><button class="primary" name="_mode" value="import">Validate & import</button>
            </div>`,
        ),
      )}
      ${card(
        'Recent imports',
        table(
          ['When', 'Status', 'Result'],
          imports.map((i) => [
            when(i.created_at),
            badge(i.status),
            i.status === 'imported'
              ? html`<a href="/stories/${i.story_id}">open story</a>`
              : parseJson<Array<{ path: string; message: string }>>(i.errors_json, [])
                  .slice(0, 3)
                  .map((e) => `${e.path}: ${e.message}`)
                  .join('; '),
          ]),
        ),
      )}`,
    );
  });

  r.post(
    '/stories/import',
    (req) => {
      const text = req.form['package'] ?? '';
      const projectId = req.form['project_id'] || undefined;
      if (req.form['_mode'] === 'validate') {
        const v = validateStoryPackage(text);
        if (v.ok)
          return web.redirect(
            `/stories/import${projectId ? `?project=${projectId}` : ''}`,
            `Valid Story Package: "${v.pkg?.story.title}", ${v.pkg?.scenes.length} scene(s). Nothing was imported yet.`,
          );
        throw new AppError('VALIDATION_FAILED', 'Story Package is invalid', v.errors);
      }
      const summary = importStoryPackage(s, text, projectId ? { projectId } : {});
      const reused = summary.reused.length ? ` Reused: ${summary.reused.join(', ')}.` : '';
      return web.redirect(
        `/stories/${summary.storyId}`,
        `Imported: ${Object.entries(summary.created)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')}.${reused} ${summary.warnings.join(' ')}`,
      );
    },
    MAX_PACKAGE_BYTES + 64 * 1024,
  );

  // --- Story detail ---------------------------------------------------------------------
  r.get('/stories/:id', async (req) => {
    const tree = s.stories.tree(req.params['id']!);
    const st = tree.story;
    const projectId = st.project_id;
    const sceneBlocks: SafeHtml[] = [];
    for (const [i, { scene, narration, shots }] of tree.scenes.entries()) {
      const shotRows: Array<Array<SafeHtml | string | number>> = [];
      for (const [j, { shot, characters, dialogue }] of shots.entries()) {
        shotRows.push([
          await preview(web, shot.approved_video_asset_id ?? shot.approved_image_asset_id),
          html`<a href="/shots/${shot.id}">${j + 1}. ${shot.title || '(untitled shot)'}</a><br /><small
              >${shot.action}</small
            >`,
          characters.map((c) => s.characters.get(c.character_id).name).join(', '),
          `${shot.duration_sec}s`,
          `${dialogue.length} line(s)`,
          badge(shot.approval_state),
          html`<div class="actions">
            ${button(`/shots/${shot.id}/move`, '↑', { direction: 'up' })}${button(
              `/shots/${shot.id}/move`,
              '↓',
              { direction: 'down' },
            )}
          </div>`,
        ]);
      }
      sceneBlocks.push(
        html`<section class="card scene">
          <header>
            <h2>Scene ${i + 1}: ${scene.title}</h2>
            <div class="actions">
              ${button(`/scenes/${scene.id}/move`, '↑', { direction: 'up' })}${button(
                `/scenes/${scene.id}/move`,
                '↓',
                { direction: 'down' },
              )}
              ${button(
                `/scenes/${scene.id}/delete`,
                'Delete',
                {},
                { kind: 'danger', confirm: 'Delete this scene and its shots?' },
              )}
            </div>
          </header>
          <p>${scene.summary}</p>
          <p class="muted">
            Location: ${scene.location_id ? s.characters.getLocation(scene.location_id).name : '—'} · Music:
            ${scene.music_mood || '—'} · Ambience: ${scene.ambience || '—'}
          </p>
          ${table(
            ['', 'Shot', 'Characters', 'Duration', 'Dialogue', 'State', 'Order'],
            shotRows,
            'No shots yet.',
          )}
          ${postForm(
            `/scenes/${scene.id}/shots`,
            html`<div class="row">
                ${field('New shot title', 'title', '')}${field('Action', 'action', '')}
              </div>
              <button>Add shot</button>`,
          )}
          <details>
            <summary>Narration (${narration.length})</summary>
            ${table(
              ['Text', 'Emotion', 'Shot', 'Audio', ''],
              narration.map((n) => [
                n.text,
                n.emotion,
                n.shot_id ? (shots.find((x) => x.shot.id === n.shot_id)?.shot.title ?? '') : 'scene start',
                n.audio_asset_id ? badge('ok') : badge('pending'),
                html`<div class="actions">
                  ${button(
                    `/narration/${n.id}/audio`,
                    n.audio_asset_id ? 'Regenerate audio' : 'Generate audio',
                  )}${button(`/narration/${n.id}/delete`, 'Delete', {}, { kind: 'danger' })}
                </div>`,
              ]),
            )}
            ${postForm(
              `/scenes/${scene.id}/narration`,
              html`<div class="row">
                  ${field('Narration text', 'text', '', { required: true })}${select(
                    'Emotion',
                    'emotion',
                    EMOTIONS.map((e) => [e, e]),
                    'neutral',
                  )}${select(
                    'At shot',
                    'shot_id',
                    options(
                      shots.map((x) => x.shot),
                      (x) => x.title || x.id,
                      'scene start',
                    ),
                    '',
                  )}
                </div>
                <button>Add narration</button>`,
            )}
          </details>
          <details>
            <summary>Edit scene</summary>
            ${postForm(
              `/scenes/${scene.id}/update`,
              html`${sceneForm(web, projectId, scene)}<button class="primary">Save scene</button>`,
            )}
            ${(() => {
              const loc = scene.location_id ? s.characters.getLocation(scene.location_id) : null;
              const amb = suggestAmbience(scene, loc);
              const mood = suggestMusicMood(scene);
              return html`<p class="muted">
                Suggestions — ambience: ${amb ?? 'none'} · music mood: ${mood ?? 'none'}
              </p>`;
            })()}
          </details>
        </section>`,
      );
    }
    const body = html` <p class="muted">
        <a href="/projects/${projectId}">← ${s.projects.get(projectId).name}</a>
      </p>
      ${card(
        'Production',
        html`<div class="actions">
          ${button(`/stories/${st.id}/generate-images`, 'Generate images for shots without one')}
          ${button(`/stories/${st.id}/animate`, 'Animate all approved images')}
          ${button('/queue/run', 'Run queue now (mock batch)', {}, { kind: 'primary' })}
          <a class="btn" href="/editor/${st.id}">Open editor / timeline</a>
          <a class="btn" href="/quality/${st.id}">Quality check</a>
          ${button(
            `/stories/${st.id}/build-final`,
            'BUILD FINAL (16:9)',
            { format: 'landscape' },
            { kind: 'primary' },
          )}
        </div>`,
      )}
      ${sceneBlocks}
      ${card(
        'Add scene',
        postForm(
          `/stories/${st.id}/scenes`,
          html`${sceneForm(web, projectId)}<button class="primary">Add scene</button>`,
        ),
      )}
      ${card(
        'Story details',
        postForm(
          `/stories/${st.id}/update`,
          html`<div class="row">
              ${field('Title', 'title', st.title, { required: true })}${field(
                'Episode #',
                'episode_number',
                st.episode_number ?? '',
                { type: 'number' },
              )}${select(
                'Status',
                'status',
                STORY_STATUSES.map((x) => [x, x]),
                st.status,
              )}${field('Language', 'language', st.language, {
                help: 'en, en-GB, hi (Hindi) or hi-Latn (Hinglish)',
              })}${field('Target duration (s)', 'target_duration_sec', st.target_duration_sec, {
                type: 'number',
              })}
            </div>
            ${field('Synopsis', 'synopsis', st.synopsis, { textarea: true })}
            ${field('Story', 'story_text', st.story_text, { textarea: true, rows: 8 })}
            ${field('Moral / lesson', 'moral', st.moral)}
            ${field('Production notes', 'production_notes', st.production_notes, { textarea: true, rows: 2 })}
            <button class="primary">Save story</button>`,
        ),
      )}
      ${button(
        `/stories/${st.id}/delete`,
        'Delete story',
        {},
        { kind: 'danger', confirm: 'Delete this story, its scenes, shots and timeline?' },
      )}`;
    return web.render(
      req,
      st.episode_number !== null ? `Episode ${st.episode_number}: ${st.title}` : st.title,
      '/stories',
      body,
    );
  });

  r.post('/stories/:id/update', (req) => {
    const patch = formPatch(req.form);
    if (patch['episode_number'] === '') patch['episode_number'] = null;
    s.stories.update(req.params['id']!, patch);
    return web.redirect(`/stories/${req.params['id']}`, 'Story saved');
  });
  r.post('/stories/:id/delete', (req) => {
    const st = s.stories.get(req.params['id']!);
    s.stories.delete(st.id);
    return web.redirect(`/projects/${st.project_id}`, 'Story deleted');
  });
  r.post('/stories/:id/scenes', (req) => {
    s.stories.createScene(req.params['id']!, formPatch(req.form));
    return web.redirect(`/stories/${req.params['id']}`, 'Scene added');
  });
  r.post('/stories/:id/generate-images', (req) => {
    let n = 0;
    for (const shot of s.stories.listStoryShots(req.params['id']!)) {
      if (!shot.approved_image_asset_id && !s.jobs.findActive('image', shot.id)) {
        s.generation.queueImage(shot.id);
        n++;
      }
    }
    return web.redirect(
      `/stories/${req.params['id']}`,
      `${n} image job(s) queued. Run the queue to process them in one batch.`,
    );
  });
  r.post('/stories/:id/animate', (req) => {
    let n = 0;
    for (const shot of s.stories.listStoryShots(req.params['id']!)) {
      if (
        shot.approved_image_asset_id &&
        !shot.approved_video_asset_id &&
        !s.jobs.findActive('video', shot.id)
      ) {
        s.generation.queueVideo(shot.id);
        n++;
      }
    }
    return web.redirect(`/stories/${req.params['id']}`, `${n} clip job(s) queued.`);
  });
  r.post('/stories/:id/build-final', async (req) => {
    const format = req.form['format'] === 'vertical' ? 'vertical' : 'landscape';
    const exp = await s.exports.buildFinal(req.params['id']!, format);
    return exp.status === 'complete'
      ? web.redirect(`/exports/${exp.id}`, 'BUILD FINAL complete and validated.')
      : web.redirect(
          `/exports/${exp.id}`,
          undefined,
          `BUILD FINAL did not complete: ${exp.error_message ?? exp.status}`,
        );
  });

  // --- Scenes -----------------------------------------------------------------------------
  const storyOfScene = (id: string) => s.stories.getScene(id).story_id;
  r.post('/scenes/:id/update', (req) => {
    s.stories.updateScene(req.params['id']!, formPatch(req.form));
    return web.redirect(`/stories/${storyOfScene(req.params['id']!)}`, 'Scene saved');
  });
  r.post('/scenes/:id/move', (req) => {
    s.stories.moveScene(req.params['id']!, req.form['direction'] === 'up' ? 'up' : 'down');
    return web.redirect(`/stories/${storyOfScene(req.params['id']!)}`);
  });
  r.post('/scenes/:id/delete', (req) => {
    const storyId = storyOfScene(req.params['id']!);
    s.stories.deleteScene(req.params['id']!);
    return web.redirect(`/stories/${storyId}`, 'Scene deleted');
  });
  r.post('/scenes/:id/shots', (req) => {
    const shot = s.stories.createShot(req.params['id']!, formPatch(req.form));
    return web.redirect(`/shots/${shot.id}`, 'Shot added');
  });
  r.post('/scenes/:id/narration', (req) => {
    s.stories.addNarration(req.params['id']!, formPatch(req.form));
    return web.redirect(`/stories/${storyOfScene(req.params['id']!)}`, 'Narration added');
  });
  r.post('/narration/:id/delete', (req) => {
    const line = s.stories.getNarration(req.params['id']!);
    s.stories.deleteNarration(line.id);
    return web.redirect(`/stories/${storyOfScene(line.scene_id)}`, 'Narration deleted');
  });
  r.post('/narration/:id/audio', (req) => {
    const line = s.stories.getNarration(req.params['id']!);
    s.generation.queueNarrationAudio(line.id, { explicit: Boolean(line.audio_asset_id) });
    return web.redirect(`/stories/${storyOfScene(line.scene_id)}`, 'Narration audio queued');
  });

  // --- Shots ------------------------------------------------------------------------------
  r.get('/shots/:id', async (req) => {
    const shot = s.stories.getShot(req.params['id']!);
    const scene = s.stories.getScene(shot.scene_id);
    const story = s.stories.get(scene.story_id);
    const projectId = story.project_id;
    const chars = s.characters.list(projectId);
    const cast = s.stories.shotCharacters(shot.id);
    const prompt = s.generation.promptFor(shot.id);
    const images = s.jobs.attemptsForShot(shot.id, 'image');
    const videos = s.jobs.attemptsForShot(shot.id, 'video');
    const dialogue = s.stories.listDialogue(shot.id);
    const sfx = s.stories.listShotSfx(shot.id);
    const location = shot.location_id ?? scene.location_id;
    const suggestions = suggestShotSfx(
      shot,
      scene,
      location ? s.characters.getLocation(location) : null,
      sfx.map((x) => x.tag),
    );
    const reuse = s.settings.get('generation').suggestReuseBeforeGeneration ? suggestReuse(s, shot.id) : [];
    const attemptCards = async (list: GenerationAttempt[]) => {
      const out: SafeHtml[] = [];
      for (const a of list) out.push(attemptCard(a, await preview(web, a.output_asset_id)));
      return out;
    };
    const lipsyncNote = shot.mouth_visible
      ? shot.lipsync_enabled
        ? 'Lip sync will be applied (speaking mouth visible).'
        : 'Lip sync disabled for this shot.'
      : 'No visible speaking mouth — lip sync skipped (saves GPU time).';

    const body = html` <p class="muted">
        <a href="/stories/${story.id}">← ${story.title}</a> / ${scene.title} · ${badge(shot.approval_state)}
      </p>
      ${grid([
        card('Approved image', await preview(web, shot.approved_image_asset_id)),
        card(
          'Approved clip',
          html`${await preview(web, shot.approved_video_asset_id)}${shot.lipsync_video_asset_id
            ? html`<p class="muted">Lip-synced version:</p>
                ${await preview(web, shot.lipsync_video_asset_id)}`
            : ''}`,
        ),
      ])}
      ${card(
        'Generate & review (image-first)',
        html`<div class="actions">
            ${shot.approved_image_asset_id
              ? ''
              : button(
                  `/shots/${shot.id}/generate`,
                  'Generate image',
                  { kind: 'image' },
                  { kind: 'primary' },
                )}
            ${button(`/shots/${shot.id}/regenerate`, 'Regenerate image (new seed)', { kind: 'image' })}
            ${shot.approved_image_asset_id && !shot.approved_video_asset_id
              ? button(
                  `/shots/${shot.id}/generate`,
                  'Animate approved image',
                  { kind: 'video' },
                  { kind: 'primary' },
                )
              : ''}
            ${shot.approved_image_asset_id
              ? button(`/shots/${shot.id}/regenerate`, 'Regenerate clip (new seed)', { kind: 'video' })
              : ''}
            ${shot.approved_video_asset_id && shot.mouth_visible && shot.lipsync_enabled
              ? button(`/shots/${shot.id}/lipsync`, 'Lip sync')
              : ''}
            ${button('/queue/run', 'Run queue now', {}, { kind: 'primary' })}
          </div>
          <p class="muted">${lipsyncNote} A failed clip never regenerates the approved image.</p>
          ${reuse.length
            ? html`<h3>Reusable approved assets (suggestions only)</h3>
                ${table(
                  ['Asset', 'Score', 'Why', ''],
                  await Promise.all(
                    reuse.map(async (x) => [
                      await preview(web, x.asset.id),
                      x.score,
                      x.reasons.join(', '),
                      button(
                        `/shots/${shot.id}/reuse`,
                        'Use for this shot',
                        { asset_id: x.asset.id },
                        { confirm: 'Use this existing approved asset instead of generating?' },
                      ),
                    ]),
                  ),
                )}`
            : ''}`,
      )}
      ${card(
        'Image attempts (history is never overwritten)',
        html`<div class="attempts">${await attemptCards(images)}</div>`,
      )}
      ${card('Clip attempts', html`<div class="attempts">${await attemptCards(videos)}</div>`)}
      ${card(
        'Prompt Builder',
        html`${table(
            ['Part', 'Source', 'Text'],
            prompt.sections.map((x) => [x.label, x.source, x.text]),
          )}
          ${kv([
            ['Built image prompt', prompt.built.image],
            ['Built motion prompt', prompt.built.motion],
            ['Built negative prompt', prompt.built.negative],
            ['References', prompt.references.map((x) => x.label).join(', ') || 'none'],
          ])}
          ${postForm(
            `/shots/${shot.id}/prompts`,
            html`<p class="muted">
                When a prompt is <strong>locked</strong> the text below is used verbatim and the builder never
                overwrites it. When unlocked, the text is appended to the built prompt as extra shot notes.
              </p>
              ${field('Image prompt', 'image_prompt', shot.image_prompt, { textarea: true })}${checkbox(
                'Lock image prompt (manual)',
                'image_prompt_locked',
                shot.image_prompt_locked,
              )}
              ${field('Motion prompt', 'motion_prompt', shot.motion_prompt, {
                textarea: true,
                rows: 2,
              })}${checkbox('Lock motion prompt (manual)', 'motion_prompt_locked', shot.motion_prompt_locked)}
              ${field('Negative prompt', 'negative_prompt', shot.negative_prompt, {
                textarea: true,
                rows: 2,
              })}${checkbox(
                'Lock negative prompt (manual)',
                'negative_prompt_locked',
                shot.negative_prompt_locked,
              )}
              <div class="actions"><button class="primary">Save prompts</button></div>`,
          )}
          ${shot.image_prompt_locked
            ? ''
            : button(`/shots/${shot.id}/apply-built`, 'Copy built prompt into the editable image prompt', {})}
          <p><strong>Final image prompt used for generation:</strong></p>
          <p class="prompt">${prompt.final.image}</p>`,
      )}
      ${card(
        'Dialogue',
        html`${table(
          ['#', 'Character', 'Line', 'Emotion', 'Speed', 'Audio', ''],
          await Promise.all(
            dialogue.map(async (d, i) => {
              const audio = s.assets.findAudio(d.audio_asset_id);
              return [
                i + 1,
                d.character_id ? s.characters.get(d.character_id).name : '—',
                html`${d.text}${d.delivery ? html`<br /><small>${d.delivery}</small>` : ''}`,
                d.emotion,
                d.speed,
                audio ? await preview(web, audio.generated_asset_id) : badge('pending'),
                html`<div class="actions">
                    ${button(`/dialogue/${d.id}/audio`, audio ? 'Regenerate' : 'Generate audio')}${button(
                      `/dialogue/${d.id}/delete`,
                      'Delete',
                      {},
                      { kind: 'danger' },
                    )}
                  </div>
                  <details>
                    <summary>Edit</summary>
                    ${postForm(
                      `/dialogue/${d.id}/update`,
                      html`${field('Text', 'text', d.text)}
                        <div class="row">
                          ${select(
                            'Emotion',
                            'emotion',
                            EMOTIONS.map((e) => [e, e]),
                            d.emotion,
                          )}${field('Speed', 'speed', d.speed, { type: 'number', step: '0.05' })}${field(
                            'Delivery',
                            'delivery',
                            d.delivery,
                          )}
                        </div>
                        <button>Save (audio will regenerate)</button>`,
                    )}
                  </details>`,
              ];
            }),
          ),
          'No dialogue.',
        )}
        ${postForm(
          `/shots/${shot.id}/dialogue`,
          html`<div class="row">
              ${select(
                'Character',
                'character_id',
                options(chars, (c) => c.name),
                '',
              )}${field('Line', 'text', '', { required: true })}${select(
                'Emotion',
                'emotion',
                EMOTIONS.map((e) => [e, e]),
                'neutral',
              )}${field('Speed', 'speed', 1, { type: 'number', step: '0.05' })}
            </div>
            <button>Add line</button>`,
        )}`,
      )}
      ${card(
        'Sound effects',
        html`${table(
          ['Tag', 'Offset', 'Required', 'Source', 'Approved', ''],
          sfx.map((c) => [
            c.tag,
            `${c.offset_sec}s`,
            c.required ? 'yes' : 'no',
            c.source,
            c.approved ? badge('approved') : badge('pending'),
            html`<div class="actions">
              ${c.approved ? '' : button(`/sfx/${c.id}/approve`, 'Approve')}${button(
                `/sfx/${c.id}/delete`,
                'Remove',
                {},
                { kind: 'danger' },
              )}
            </div>`,
          ]),
          'No SFX.',
        )}
        ${suggestions.length
          ? html`<p>
              Suggested from shot metadata:
              ${suggestions.map((t) =>
                button(`/shots/${shot.id}/sfx`, `+ ${t}`, { tag: t, source: 'suggested' }),
              )}
            </p>`
          : ''}
        ${postForm(
          `/shots/${shot.id}/sfx`,
          html`<div class="row">
              ${field('Tag', 'tag', '', { required: true, placeholder: 'e.g. footsteps' })}${field(
                'Offset (s)',
                'offset_sec',
                0,
                { type: 'number', step: '0.1' },
              )}${checkbox('Required', 'required', false)}
            </div>
            <button>Add SFX</button>`,
        )}`,
      )}
      ${card(
        'Cast',
        postForm(
          `/shots/${shot.id}/cast`,
          html`${chars.map((c) => {
              const inShot = cast.find((x) => x.character_id === c.id);
              const variants = s.characters.listVariants(c.id);
              return html`<div class="row">
                ${checkbox(
                  `${c.name}${c.locked ? ' 🔒' : ''}`,
                  `cast_${c.id}`,
                  Boolean(inShot),
                )}${variants.length
                  ? select(
                      'Variant',
                      `variant_${c.id}`,
                      options(variants, (v) => v.name, 'canonical'),
                      inShot?.variant_id ?? '',
                    )
                  : ''}
              </div>`;
            })}
            ${select(
              'Props',
              'props',
              s.characters.listProps(projectId).map((p) => [p.id, p.name]),
              s.stories.shotPropIds(shot.id),
              { multiple: true },
            )} <button>Save cast & props</button>`,
        ),
      )}
      ${card(
        'Shot settings',
        postForm(
          `/shots/${shot.id}/update`,
          html`${shotForm(web, projectId, shot)}<button class="primary">Save shot</button>`,
        ),
      )}
      ${button(
        `/shots/${shot.id}/delete`,
        'Delete shot',
        {},
        { kind: 'danger', confirm: 'Delete this shot? Its generation history is deleted too.' },
      )}`;
    return web.render(req, shot.title || 'Shot', '/stories', body);
  });

  const shotBack = (id: string) => `/shots/${id}`;
  r.post('/shots/:id/update', (req) => {
    const patch = formPatch(req.form);
    if (patch['seed'] === '') patch['seed'] = null;
    s.stories.updateShot(req.params['id']!, patch);
    return web.redirect(shotBack(req.params['id']!), 'Shot saved');
  });
  r.post('/shots/:id/prompts', (req) => {
    s.stories.updateShot(req.params['id']!, formPatch(req.form));
    return web.redirect(shotBack(req.params['id']!), 'Prompts saved');
  });
  r.post('/shots/:id/apply-built', (req) => {
    const built = s.generation.promptFor(req.params['id']!).built.image;
    s.stories.applyBuiltPrompt(req.params['id']!, 'image_prompt', built);
    return web.redirect(shotBack(req.params['id']!), 'Built prompt copied into the editable prompt');
  });
  r.post('/shots/:id/move', (req) => {
    const shot = s.stories.getShot(req.params['id']!);
    s.stories.moveShot(shot.id, req.form['direction'] === 'up' ? 'up' : 'down');
    return web.redirect(`/stories/${storyOfScene(shot.scene_id)}`);
  });
  r.post('/shots/:id/delete', (req) => {
    const shot = s.stories.getShot(req.params['id']!);
    s.stories.deleteShot(shot.id);
    return web.redirect(`/stories/${storyOfScene(shot.scene_id)}`, 'Shot deleted');
  });
  r.post('/shots/:id/generate', (req) => {
    const job =
      req.form['kind'] === 'video'
        ? s.generation.queueVideo(req.params['id']!)
        : s.generation.queueImage(req.params['id']!);
    return web.redirect(shotBack(req.params['id']!), `Queued ${job.kind} job. Run the queue to process it.`);
  });
  r.post('/shots/:id/regenerate', (req) => {
    const kind = req.form['kind'] === 'video' ? 'video' : 'image';
    s.generation.regenerate(req.params['id']!, kind, { seed: 'new' });
    return web.redirect(
      shotBack(req.params['id']!),
      `Regeneration queued (${kind}, new seed). Previous attempts are kept.`,
    );
  });
  r.post('/shots/:id/lipsync', (req) => {
    s.generation.queueLipsync(req.params['id']!);
    return web.redirect(shotBack(req.params['id']!), 'Lip-sync job queued (original clip is preserved).');
  });
  r.post('/shots/:id/reuse', (req) => {
    const shot = s.stories.getShot(req.params['id']!);
    const asset = s.assets.get(req.form['asset_id'] ?? '');
    if (asset.approval !== 'approved' || !asset.reusable)
      throw new AppError('PRECONDITION_FAILED', 'Only approved, reusable assets can be reused');
    const storyId = s.stories.storyIdForShot(shot.id);
    if (asset.kind === 'image') {
      s.stories.setShotState(shot.id, {
        approved_image_asset_id: asset.id,
        approval_state: 'image_approved',
      });
    } else {
      const root =
        asset.kind === 'upscaled_video' && asset.source_asset_id
          ? s.assets.get(asset.source_asset_id)
          : asset;
      s.stories.setShotState(shot.id, {
        approved_image_asset_id: root.source_asset_id,
        approved_video_asset_id: asset.id,
        approval_state: 'approved',
      });
    }
    s.assets.recordUsage(asset.id, 'reused for shot', storyId, shot.id);
    return web.redirect(shotBack(shot.id), 'Reusable asset applied to this shot');
  });
  r.post('/shots/:id/cast', (req) => {
    const shotId = req.params['id']!;
    const projectId = s.stories.projectIdForStory(s.stories.storyIdForShot(shotId));
    const cast = s.characters
      .list(projectId)
      .filter((c) => req.form[`cast_${c.id}`] === 'true')
      .map((c) => ({ character_id: c.id, variant_id: req.form[`variant_${c.id}`] || null }));
    s.stories.setShotCharacters(shotId, cast);
    s.stories.setShotProps(shotId, req.formAll['props'] ?? []);
    return web.redirect(shotBack(shotId), 'Cast saved');
  });
  r.post('/shots/:id/dialogue', (req) => {
    s.stories.addDialogue(req.params['id']!, formPatch(req.form));
    return web.redirect(shotBack(req.params['id']!), 'Dialogue added');
  });
  r.post('/shots/:id/sfx', (req) => {
    s.stories.addShotSfx(req.params['id']!, req.form['tag'] ?? '', {
      offsetSec: Number(req.form['offset_sec'] ?? 0) || 0,
      required: req.form['required'] === 'true',
      source: req.form['source'] === 'suggested' ? 'suggested' : 'manual',
    });
    return web.redirect(
      shotBack(req.params['id']!),
      req.form['source'] === 'suggested' ? 'Suggested SFX added — approve it to use it' : 'SFX added',
    );
  });
  const sfxShot = (id: string) =>
    s.db.get<{ shot_id: string }>('SELECT shot_id FROM shot_sfx WHERE id = ?', id)?.shot_id ?? '';
  r.post('/sfx/:id/approve', (req) => {
    const shotId = sfxShot(req.params['id']!);
    s.stories.setShotSfxApproval(req.params['id']!, true);
    return web.redirect(shotBack(shotId), 'SFX approved');
  });
  r.post('/sfx/:id/delete', (req) => {
    const shotId = sfxShot(req.params['id']!);
    s.stories.deleteShotSfx(req.params['id']!);
    return web.redirect(shotBack(shotId), 'SFX removed');
  });
  r.post('/dialogue/:id/update', (req) => {
    const d = s.stories.updateDialogue(req.params['id']!, formPatch(req.form));
    return web.redirect(
      shotBack(d.shot_id),
      d.audio_asset_id
        ? 'Dialogue saved'
        : 'Dialogue saved — its audio (and any lip sync) will be regenerated on the next build',
    );
  });
  r.post('/dialogue/:id/delete', (req) => {
    const d = s.stories.getDialogue(req.params['id']!);
    s.stories.deleteDialogue(d.id);
    return web.redirect(shotBack(d.shot_id), 'Dialogue deleted');
  });
  r.post('/dialogue/:id/audio', (req) => {
    const d = s.stories.getDialogue(req.params['id']!);
    s.generation.queueDialogueAudio(d.id, { explicit: Boolean(d.audio_asset_id) });
    return web.redirect(shotBack(d.shot_id), 'Dialogue audio queued');
  });
  r.post('/attempts/:id/approve', (req) => {
    const a = s.jobs.getAttempt(req.params['id']!);
    s.generation.approveAttempt(a.id);
    return web.redirect(a.shot_id ? shotBack(a.shot_id) : '/queue', `${a.kind} approved`);
  });
  r.post('/attempts/:id/reject', (req) => {
    const a = s.jobs.getAttempt(req.params['id']!);
    s.generation.rejectAttempt(a.id);
    return web.redirect(a.shot_id ? shotBack(a.shot_id) : '/queue', `${a.kind} rejected (kept in history)`);
  });
}
