import { AppError } from '../../lib/errors.ts';
import type { VideoStatus } from '../../repositories/videos.ts';
import { decodeImageUpload, studioProject } from '../../services/simple-studio.ts';
import type { Web } from '../app.ts';
import { button, card, field, html, mediaUrl, postForm, type SafeHtml } from '../ui.ts';
import { videoCard } from './simple.ts';

const FILTERS: Array<[string, string, VideoStatus[]]> = [
  ['all', 'All', []],
  ['draft', 'Draft', ['draft', 'plan_review']],
  ['generating', 'Generating', ['generating']],
  ['attention', 'Needs Attention', ['needs_attention', 'failed']],
  ['ready', 'Ready', ['ready']],
  ['approved', 'Approved', ['approved']],
  ['scheduled', 'Scheduled', ['scheduled']],
  ['published', 'Published', ['published']],
];

/** Simple Mode: My Videos and the reusable Characters library. */
export function registerLibraryPages(web: Web): void {
  const s = web.studio;
  const r = web.router;

  r.get('/videos', (req) => {
    const key = req.query.get('show') ?? 'all';
    const filter = FILTERS.find((f) => f[0] === key) ?? FILTERS[0]!;
    const videos = s.videos.list({ status: filter[2] });
    const body = html`<p class="filters">
        ${FILTERS.map(
          ([k, label]) =>
            html`<a class="${k === filter[0] ? 'btn primary' : 'btn'}" href="/videos?show=${k}">${label}</a>`,
        )}
      </p>
      ${videos.length
        ? html`<div class="video-grid">${videos.map((v) => videoCard(web, v))}</div>`
        : html`<p class="muted">No videos here. <a href="/create">+ CREATE NEW VIDEO</a></p>`}`;
    return web.render(req, 'My Videos', '/videos', body);
  });

  // --- Characters library ---------------------------------------------------------------------

  r.get('/library/characters', (req) => {
    const project = studioProject(s);
    const chars = s.characters.list(project.id);
    const cards: SafeHtml[] = chars.map((c) => {
      const refs = s.characters.listReferences(c.id).filter((x) => x.approved);
      const face =
        refs.find((x) => x.slot === 'face_closeup') ??
        refs.find((x) => x.slot === 'front') ??
        refs[0] ??
        null;
      const used = s.db.scalar(
        `SELECT COUNT(DISTINCT sc.story_id) FROM shot_characters sh JOIN shots s ON s.id = sh.shot_id
         JOIN scenes sc ON sc.id = s.scene_id WHERE sh.character_id = ?`,
        c.id,
      );
      return html`<article class="char-card">
        ${face
          ? html`<img src="${mediaUrl(face.storage_key)}" alt="${c.name}" loading="lazy" />`
          : html`<div class="nothumb">no picture yet</div>`}
        <h3><a href="/library/characters/${c.id}">${c.name}</a></h3>
        <p class="muted">${(c.appearance || c.personality || '').slice(0, 140)}</p>
        <p class="muted">
          ${refs.length} approved picture(s) · in ${used} video(s)${c.locked ? ' · identity locked' : ''}
        </p>
      </article>`;
    });
    const body = html`<p class="subtitle">
        Characters are remembered. When a new idea mentions a character by name, the same look and voice are
        used again.
      </p>
      ${cards.length
        ? html`<div class="char-grid">${cards}</div>`
        : html`<p class="muted">No characters yet.</p>`}
      ${card(
        'New character',
        postForm(
          '/library/characters',
          html`${field('Name', 'name', '', { required: true, placeholder: 'Milo' })}
            ${field('What do they look like? Who are they?', 'description', '', {
              textarea: true,
              rows: 3,
              required: true,
              placeholder:
                'A curious 6-year-old fox cub with orange fur, a green scarf and big friendly eyes.',
            })}
            <label class="field"
              ><span>Reference picture (optional)</span
              ><input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-read-into="image"
                data-as="dataurl"
              /><small
                >Your own drawing or picture of the character. Without one, AI draws the look the first time
                the character is used.</small
              ></label
            ><textarea name="image" hidden></textarea> <button class="primary">Save character</button>`,
        ),
      )}`;
    return web.render(req, 'Characters', '/library/characters', body);
  });

  r.post(
    '/library/characters',
    async (req) => {
      const project = studioProject(s);
      const name = (req.form['name'] ?? '').trim();
      const description = (req.form['description'] ?? '').trim();
      if (!name || !description)
        throw new AppError('VALIDATION_FAILED', 'Give the character a name and a description.');
      const upload = req.form['image'] ? decodeImageUpload(req.form['image']) : null;
      const c = s.characters.create(project.id, {
        name,
        appearance: description,
        prompt: description,
      });
      if (upload) await addPicture(web, c.id, upload);
      s.logger.info('library character created', { character: c.id, withPicture: Boolean(upload) });
      return web.redirect(`/library/characters/${c.id}`, `${name} saved.`);
    },
    16 * 1024 * 1024,
  );

  r.get('/library/characters/:id', (req) => {
    const c = s.characters.get(req.params['id']!);
    const refs = s.characters.listReferences(c.id);
    const body = html`${card(
        'Pictures',
        refs.length
          ? html`<div class="ref-grid">
              ${refs.map(
                (x) =>
                  html`<figure>
                    <img src="${mediaUrl(x.storage_key)}" alt="${x.slot}" loading="lazy" />
                    <figcaption>
                      ${x.slot.replace(/_/g, ' ')}
                      ${x.approved ? html`<span class="badge good">used</span>` : ''}
                      ${x.approved
                        ? ''
                        : button(
                            `/library/characters/${c.id}/approve/${x.id}`,
                            'Use this picture',
                            {},
                            { kind: 'primary' },
                          )}
                    </figcaption>
                  </figure>`,
              )}
            </div>`
          : html`<p class="muted">No pictures yet. AI draws them the first time ${c.name} is in a video.</p>`,
      )}
      ${card(
        'About',
        postForm(
          `/library/characters/${c.id}`,
          html`${field('Name', 'name', c.name, { required: true })}
            ${field('Look and personality', 'description', c.appearance, { textarea: true, rows: 4 })}
            <label class="field"
              ><span>Add a reference picture</span
              ><input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-read-into="image"
                data-as="dataurl"
            /></label>
            <textarea name="image" hidden></textarea>
            <button class="primary">Save</button>`,
        ),
      )}
      <p class="muted">
        More control (poses, variants, voice, locking):
        <a href="/characters/${c.id}">open in Advanced Mode</a>.
      </p>`;
    return web.render(req, c.name, '/library/characters', body);
  });

  r.post(
    '/library/characters/:id',
    async (req) => {
      const c = s.characters.get(req.params['id']!);
      const patch: Record<string, unknown> = {};
      const name = (req.form['name'] ?? '').trim();
      const description = (req.form['description'] ?? '').trim();
      if (name && name !== c.name) patch['name'] = name;
      if (description !== c.appearance)
        Object.assign(patch, { appearance: description, prompt: description });
      if (Object.keys(patch).length) s.characters.update(c.id, patch);
      if (req.form['image']) await addPicture(web, c.id, decodeImageUpload(req.form['image']));
      return web.redirect(`/library/characters/${c.id}`, 'Saved.');
    },
    16 * 1024 * 1024,
  );

  r.post('/library/characters/:id/approve/:ref', (req) => {
    const c = s.characters.get(req.params['id']!);
    const ref = s.characters.listReferences(c.id).find((x) => x.id === req.params['ref']);
    if (!ref) throw new AppError('NOT_FOUND', 'Picture not found');
    s.characters.setReferenceApproval(ref.id, true);
    return web.redirect(`/library/characters/${c.id}`, 'This picture is now used for the character.');
  });
}

/** A picture the user chose is their decision: it is used (approved) right away, as the front view. */
async function addPicture(
  web: Web,
  characterId: string,
  img: { data: Buffer; ext: string; mime: string },
): Promise<void> {
  const s = web.studio;
  const c = s.characters.get(characterId);
  const taken = new Set(s.characters.listReferences(c.id).map((x) => x.slot));
  const slot = !taken.has('front')
    ? 'front'
    : !taken.has('three_quarter')
      ? 'three_quarter'
      : `user_${taken.size + 1}`;
  const slotType = slot.startsWith('user_') ? 'other' : 'view';
  const ref = await s.assets.createReference(
    c.project_id,
    'character',
    c.id,
    img.data,
    img.ext,
    img.mime,
    `${slotType}:${slot}`,
    false,
  );
  const cref = s.characters.addReference(c.id, ref, { slot_type: slotType, slot });
  s.characters.setReferenceApproval(cref.id, true);
}
