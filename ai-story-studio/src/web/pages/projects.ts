import { ASPECT_RATIOS, QUALITY_MODES } from '../../domain/enums.ts';
import type { Project, StylePreset } from '../../domain/types.ts';
import { exportProject, importProject, MAX_BACKUP_BYTES } from '../../services/backup.ts';
import { toAppError } from '../../lib/errors.ts';
import type { Web } from '../app.ts';
import { formPatch } from '../forms.ts';
import { badge, button, card, field, grid, html, options, postForm, select, table, when } from '../ui.ts';

export function projectForm(web: Web, p: Partial<Project> = {}) {
  const s = web.studio;
  const voices = p.id ? s.characters.listVoices(p.id).filter((v) => v.role === 'narrator') : [];
  return html` ${field('Name', 'name', p.name, { required: true })} ${field('Series', 'series', p.series)}
    ${field('Description', 'description', p.description, { textarea: true })}
    <div class="row">
      ${field('Genre', 'genre', p.genre, { placeholder: 'e.g. Fantasy, Educational, Bedtime story' })}
      ${field('Target audience', 'target_audience', p.target_audience)}
    </div>
    <div class="row">
      ${select(
        'Default style',
        'default_style_id',
        options(s.projects.listStyles(p.id), (x) => x.name),
        p.default_style_id,
      )}
      ${select(
        'Aspect ratio',
        'aspect_ratio',
        ASPECT_RATIOS.map((a) => [
          a,
          a === '16:9' ? '16:9 landscape (1920×1080)' : '9:16 vertical (1080×1920)',
        ]),
        p.aspect_ratio ?? '16:9',
      )}
      ${select(
        'FPS',
        'fps',
        [
          ['24', '24'],
          ['30', '30'],
        ],
        p.fps ?? Number(s.settings.get('execution').fps),
      )}
      ${select(
        'Default quality',
        'default_quality',
        QUALITY_MODES.map((q) => [q, q.replace('_', ' ')]),
        p.default_quality ?? s.settings.get('execution').defaultQuality,
      )}
    </div>
    ${p.id
      ? select(
          'Narrator voice',
          'narrator_voice_id',
          options(voices, (v) => `${v.name}${v.locked ? ' 🔒' : ''}`),
          p.narrator_voice_id,
          { help: 'Create narrator voices on the Characters page (role: narrator).' },
        )
      : ''}
    ${field('Production notes', 'production_notes', p.production_notes, { textarea: true })}`;
}

function styleForm(st: Partial<StylePreset> = {}) {
  return html` ${field('Name', 'name', st.name, { required: true })}
    ${field('Style prompt', 'style_prompt', st.style_prompt, { textarea: true })}
    <div class="row">
      ${field('Rendering', 'rendering', st.rendering)}${field('Lighting', 'lighting', st.lighting)}
    </div>
    <div class="row">
      ${field('Colours', 'colors', st.colors)}${field('Camera characteristics', 'camera', st.camera)}
    </div>
    ${field('Negative prompt', 'negative_prompt', st.negative_prompt, { textarea: true })}`;
}

export function registerProjectPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/projects', (req) => {
    const rows = s.projects
      .list()
      .map((p) => [
        html`<a href="/projects/${p.id}">${p.name}</a>`,
        p.series,
        p.genre,
        `${p.width}×${p.height} @${p.fps}`,
        s.stories.list(p.id).length,
        when(p.updated_at),
      ]);
    return web.render(
      req,
      'Projects',
      '/projects',
      html`${card(
        'All projects',
        table(
          ['Name', 'Series', 'Genre', 'Output', 'Stories', 'Updated'],
          rows,
          'No projects yet — create one or import a Story Package.',
        ),
      )}
      ${grid([
        card(
          'New project',
          postForm('/projects', html`${projectForm(web)}<button class="primary">Create project</button>`),
        ),
        card(
          'Import project backup',
          postForm(
            '/projects/import-backup',
            html`<label class="field"
                ><span>Backup file (.json)</span
                ><input type="file" accept=".json,application/json" data-read-into="backup"
              /></label>
              <textarea name="backup" hidden></textarea><button>Import as new project</button>`,
          ),
        ),
      ])}`,
    );
  });

  r.post('/projects', (req) => {
    const p = s.projects.create(formPatch(req.form));
    return web.redirect(`/projects/${p.id}`, 'Project created');
  });

  r.post(
    '/projects/import-backup',
    async (req) => {
      const result = await importProject(s, req.form['backup'] ?? '');
      return web.redirect(
        `/projects/${result.projectId}`,
        `Backup imported as a new project (${result.rows} rows, ${result.mediaFiles} media files)`,
      );
    },
    MAX_BACKUP_BYTES,
  );

  r.get('/projects/:id', (req) => {
    const p = s.projects.get(req.params['id']!);
    const stories = s.stories.list(p.id);
    const chars = s.characters.list(p.id);
    const locs = s.characters.listLocations(p.id);
    const props = s.characters.listProps(p.id);
    const body = html` ${grid([
      card(
        'Stories / episodes',
        html`${table(
            ['Ep', 'Title', 'Status', 'Target'],
            stories.map((st) => [
              st.episode_number ?? '',
              html`<a href="/stories/${st.id}">${st.title}</a>`,
              badge(st.status),
              `${st.target_duration_sec}s`,
            ]),
          )}
          ${postForm(
            `/projects/${p.id}/stories`,
            html`<div class="row">${field('New story title', 'title', '', { required: true })}</div>
              <button>Add story</button>`,
          )} <a href="/stories/import?project=${p.id}">Import Story Package into this project →</a>`,
      ),
      card(
        'Cast & world',
        html`<p>
            <strong>Characters:</strong> ${chars.map(
              (c) => html`<a href="/characters/${c.id}">${c.name}${c.locked ? ' 🔒' : ''}</a> `,
            )}
          </p>
          <p>
            <strong>Locations:</strong> ${locs.map(
              (l) => html`<a href="/locations/${l.id}">${l.name}${l.locked ? ' 🔒' : ''}</a> `,
            )}
          </p>
          <p><strong>Props:</strong> ${props.map((x) => html`<a href="/props/${x.id}">${x.name}</a> `)}</p>
          <p><a href="/characters?project=${p.id}">Manage characters & voices →</a></p>`,
      ),
    ])}
    ${card(
      'Project settings',
      postForm(`/projects/${p.id}/update`, html`${projectForm(web, p)}<button class="primary">Save</button>`),
    )}
    ${card(
      'Backup',
      html`<p>
          Export everything (metadata, story, characters, prompts, generation history, audio configuration,
          timeline, quality reports).
        </p>
        <p>
          <a class="btn" href="/projects/${p.id}/backup">Download metadata-only backup</a>
          <a class="btn" href="/projects/${p.id}/backup?media=1">Download full media backup</a>
        </p>`,
    )}
    ${card(
      'Danger zone',
      button(
        `/projects/${p.id}/delete`,
        'Delete project',
        {},
        { kind: 'danger', confirm: `Delete "${p.name}" and all of its stories and assets?` },
      ),
    )}`;
    return web.render(req, p.name, '/projects', body);
  });

  r.post('/projects/:id/update', (req) => {
    s.projects.update(req.params['id']!, formPatch(req.form));
    return web.redirect(`/projects/${req.params['id']}`, 'Saved');
  });

  r.post('/projects/:id/delete', (req) => {
    s.projects.delete(req.params['id']!);
    return web.redirect('/projects', 'Project deleted');
  });

  r.post('/projects/:id/stories', (req) => {
    const projectId = req.params['id']!;
    const title = (req.form['title'] ?? '').trim();
    if (!s.projects.find(projectId))
      return web.redirect('/projects', undefined, 'Project could not be found.');
    if (!title) return web.redirect(`/projects/${projectId}`, undefined, 'Story title is required.');
    let id: string;
    try {
      id = s.stories.create(projectId, { title }).id;
    } catch (err) {
      const e = toAppError(err);
      s.logger.error('story create failed', { project: projectId, error: e.message });
      return web.redirect(`/projects/${projectId}`, undefined, `Story could not be saved: ${e.message}`);
    }
    // Read it back: only report success for a story that is really stored under this project.
    const saved = s.db.get<{ project_id: string; title: string }>(
      'SELECT project_id, title FROM stories WHERE id = ?',
      id,
    );
    if (saved?.project_id !== projectId)
      return web.redirect(
        `/projects/${projectId}`,
        undefined,
        'Story could not be saved: it was not found after saving.',
      );
    s.logger.info('story created', { project: projectId, story: id });
    return web.redirect(`/stories/${id}`, `Story '${saved.title}' created.`);
  });

  r.get('/projects/:id/backup', async (req) => {
    const p = s.projects.get(req.params['id']!);
    const includeMedia = req.query.get('media') === '1';
    const backup = await exportProject(s, p.id, { includeMedia });
    return {
      type: 'json',
      body: backup,
      filename: `${p.name}-${includeMedia ? 'full' : 'metadata'}-backup.json`,
    };
  });

  // --- Styles -------------------------------------------------------------------
  r.get('/styles', (req) => {
    const rows = s.projects
      .listStyles()
      .map((st) => [
        html`<a href="/styles/${st.id}">${st.name}</a>`,
        st.project_id ? html`<a href="/projects/${st.project_id}">project</a>` : 'global',
        st.style_prompt.slice(0, 90),
      ]);
    return web.render(
      req,
      'Styles',
      '/styles',
      html`${card('Style presets', table(['Name', 'Scope', 'Style prompt'], rows))}
      ${card(
        'New style preset',
        postForm('/styles', html`${styleForm()}<button class="primary">Create style</button>`),
      )}`,
    );
  });
  r.post('/styles', (req) => {
    const st = s.projects.createStyle(formPatch(req.form), null);
    return web.redirect(`/styles/${st.id}`, 'Style created');
  });
  r.get('/styles/:id', (req) => {
    const st = s.projects.getStyle(req.params['id']!);
    return web.render(
      req,
      st.name,
      '/styles',
      html`${card(
        'Edit style',
        postForm(`/styles/${st.id}/update`, html`${styleForm(st)}<button class="primary">Save</button>`),
      )}
      ${button(
        `/styles/${st.id}/delete`,
        'Delete style',
        {},
        { kind: 'danger', confirm: 'Delete this style preset?' },
      )}`,
    );
  });
  r.post('/styles/:id/update', (req) => {
    s.projects.updateStyle(req.params['id']!, formPatch(req.form));
    return web.redirect(`/styles/${req.params['id']}`, 'Saved');
  });
  r.post('/styles/:id/delete', (req) => {
    s.projects.deleteStyle(req.params['id']!);
    return web.redirect('/styles', 'Style deleted');
  });
}
