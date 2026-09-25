import {
  EMOTIONS,
  NARRATION_STYLES,
  REFERENCE_EXPRESSIONS,
  REFERENCE_POSES,
  REFERENCE_VIEWS,
  VOICE_PRESENTATIONS,
} from '../../domain/enums.ts';
import type { Character, Location, Prop, VoiceProfile } from '../../domain/types.ts';
import { AppError } from '../../lib/errors.ts';
import type { Web } from '../app.ts';
import { formPatch } from '../forms.ts';
import { badge, button, card, field, grid, html, mediaUrl, options, postForm, select, table } from '../ui.ts';

const CHARACTER_FIELDS: Array<[keyof Character, string, boolean]> = [
  ['species', 'Species', false],
  ['age', 'Age', false],
  ['role', 'Role', false],
  ['personality', 'Personality', true],
  ['appearance', 'Appearance', true],
  ['face', 'Face', true],
  ['hair', 'Hair / fur', false],
  ['eyes', 'Eyes', false],
  ['body', 'Body', false],
  ['proportions', 'Proportions', false],
  ['clothing', 'Clothing', false],
  ['accessories', 'Accessories', false],
  ['colors', 'Colours', false],
  ['prompt', 'Prompt', true],
  ['negative_prompt', 'Negative prompt', true],
];

function characterForm(web: Web, projectId: string, c: Partial<Character> = {}) {
  const voices = web.studio.characters.listVoices(projectId).filter((v) => v.role === 'character');
  return html`${field('Name', 'name', c.name, { required: true })}
    <div class="grid2">
      ${CHARACTER_FIELDS.map(([k, label, long]) =>
        field(label, k, c[k], long ? { textarea: true, rows: 2 } : {}),
      )}
    </div>
    ${select(
      'Voice profile',
      'voice_profile_id',
      options(voices, (v) => `${v.name}${v.locked ? ' 🔒' : ''}`),
      c.voice_profile_id,
    )}`;
}

function voiceForm(v: Partial<VoiceProfile> = {}) {
  return html`${field('Voice name', 'name', v.name, { required: true })}
    <div class="row">
      ${select(
        'Role',
        'role',
        [
          ['character', 'character'],
          ['narrator', 'narrator'],
        ],
        v.role ?? 'character',
      )}
      ${field('Voice model', 'voice_model', v.voice_model ?? 'mock-tts', {
        help: 'Mock TTS only for now (in-process or worker). Open-source TTS models arrive in Phase 3/4.',
      })}
      ${field('Voice identity / reference id', 'voice_identity', v.voice_identity)}
    </div>
    <div class="row">
      ${field('Language', 'language', v.language ?? 'en')}
      ${select(
        'Presentation',
        'presentation',
        VOICE_PRESENTATIONS.map((p) => [p, p]),
        v.presentation ?? 'neutral',
      )}
      ${field('Pitch (semitones)', 'pitch', v.pitch ?? 0, { type: 'number', step: '0.5' })}
      ${field('Speed', 'speed', v.speed ?? 1, { type: 'number', step: '0.05' })}
    </div>
    <div class="row">
      ${field('Speaking style', 'speaking_style', v.speaking_style)}
      ${select(
        'Narration style',
        'narration_style',
        [['', '—'], ...NARRATION_STYLES.map((n) => [n, n] as [string, string])],
        v.narration_style,
      )}
      ${select(
        'Default emotion',
        'default_emotion',
        EMOTIONS.map((e) => [e, e]),
        v.default_emotion ?? 'neutral',
      )}
    </div>`;
}

function locationForm(l: Partial<Location> = {}) {
  const f: Array<[keyof Location, string, boolean]> = [
    ['description', 'Description', true],
    ['environment', 'Environment', false],
    ['architecture', 'Architecture', false],
    ['important_objects', 'Important objects', false],
    ['colors', 'Colours', false],
    ['lighting', 'Lighting', false],
    ['weather', 'Weather', false],
    ['time_of_day', 'Time of day', false],
    ['prompt', 'Prompt', true],
    ['negative_prompt', 'Negative prompt', true],
  ];
  return html`${field('Name', 'name', l.name, { required: true })}
    <div class="grid2">
      ${f.map(([k, label, long]) => field(label, k, l[k], long ? { textarea: true, rows: 2 } : {}))}
    </div>`;
}

function propForm(p: Partial<Prop> = {}) {
  return html`${field('Name', 'name', p.name, { required: true })}${field(
      'Description',
      'description',
      p.description,
      { textarea: true, rows: 2 },
    )}
    <div class="row">${field('Scale', 'scale', p.scale)}${field('Colours', 'colors', p.colors)}</div>
    ${field('Prompt', 'prompt', p.prompt, { textarea: true, rows: 2 })}${field(
      'Negative prompt',
      'negative_prompt',
      p.negative_prompt,
      { textarea: true, rows: 2 },
    )}`;
}

function lockPanel(kind: string, id: string, locked: number, lockedAt: string | null) {
  return locked
    ? html`<p>
          ${badge('locked', 'good')} since ${lockedAt ?? ''}. Canonical identity is frozen; future shots use
          it automatically.
        </p>
        ${postForm(
          `/${kind}/${id}/unlock`,
          html`${field('Reason for unlocking', 'reason', '', { required: true })}<button class="danger">
              Unlock
            </button>`,
          { confirm: 'Unlocking allows the canonical identity to change. Continue?' },
        )}`
    : html`<p>${badge('unlocked', 'warn')} Approve references, then lock to freeze the canonical identity.</p>
        ${button(`/${kind}/${id}/lock`, 'Lock', {}, { kind: 'primary' })}`;
}

function projectPicker(web: Web, current: string | null, path: string) {
  const projects = web.studio.projects.list();
  return html`<form method="get" action="${path}" class="inline">
    ${select(
      'Project',
      'project',
      projects.map((p) => [p.id, p.name]),
      current,
    )}<button>Show</button>
  </form>`;
}

export function registerCharacterPages(web: Web): void {
  const s = web.studio;
  const r = web.router;
  const pickProject = (q: URLSearchParams) => q.get('project') || s.projects.list()[0]?.id || null;

  r.get('/characters', (req) => {
    const pid = pickProject(req.query);
    if (!pid) return web.render(req, 'Characters', '/characters', html`<p>Create a project first.</p>`);
    const chars = s.characters.list(pid);
    const voices = s.characters.listVoices(pid);
    return web.render(
      req,
      'Characters',
      '/characters',
      html`${projectPicker(web, pid, '/characters')}
      ${card(
        'Characters',
        table(
          ['Name', 'Species', 'Role', 'Voice', 'Lock', 'References'],
          chars.map((c) => [
            html`<a href="/characters/${c.id}">${c.name}</a>`,
            c.species,
            c.role,
            c.voice_profile_id ? s.characters.getVoice(c.voice_profile_id).name : '—',
            c.locked ? badge('locked', 'good') : badge('unlocked', 'warn'),
            `${s.characters.listReferences(c.id).filter((x) => x.approved).length} approved`,
          ]),
        ),
      )}
      ${card(
        'Voice profiles',
        table(
          ['Name', 'Role', 'Model', 'Language', 'Presentation', 'Pitch', 'Lock'],
          voices.map((v) => [
            html`<a href="/voices/${v.id}">${v.name}</a>`,
            v.role,
            v.voice_model,
            v.language,
            v.presentation,
            v.pitch,
            v.locked ? badge('locked', 'good') : badge('unlocked', 'warn'),
          ]),
        ),
      )}
      ${grid([
        card(
          'New character',
          postForm(
            `/characters?project=${pid}`,
            html`<input type="hidden" name="_project" value="${pid}" />${characterForm(web, pid)}<button
                class="primary"
              >
                Create character
              </button>`,
          ),
        ),
        card(
          'New voice profile',
          postForm(
            '/voices',
            html`<input type="hidden" name="_project" value="${pid}" />${voiceForm()}<button class="primary">
                Create voice
              </button>`,
          ),
        ),
      ])}`,
    );
  });

  r.post('/characters', (req) => {
    const c = s.characters.create(req.form['_project'] ?? '', formPatch(req.form));
    return web.redirect(`/characters/${c.id}`, 'Character created');
  });

  r.get('/characters/:id', (req) => {
    const c = s.characters.get(req.params['id']!);
    const refs = s.characters.listReferences(c.id);
    const variants = s.characters.listVariants(c.id);
    const slotGroups: Array<[string, readonly string[]]> = [
      ['view', REFERENCE_VIEWS],
      ['expression', REFERENCE_EXPRESSIONS],
      ['pose', REFERENCE_POSES],
    ];
    const refGrid = slotGroups.map(
      ([type, slots]) =>
        html`<h3>${type}s</h3>
          <div class="refs">
            ${slots.map((slot) => {
              const list = refs.filter(
                (x) => x.slot_type === type && x.slot === slot && x.variant_id === null,
              );
              return html`<div class="ref">
                <strong>${slot.replace('_', ' ')}</strong> ${list.map(
                  (x) =>
                    html`<figure class="${x.approved ? 'approved' : ''}">
                      <img src="${mediaUrl(x.storage_key)}" alt="${slot}" />${x.is_mock
                        ? html`<span class="mock-tag">MOCK</span>`
                        : ''}
                      ${c.locked
                        ? ''
                        : button(`/character-refs/${x.id}/approve`, x.approved ? 'Unapprove' : 'Approve', {
                            approved: x.approved ? 'false' : 'true',
                          })}
                    </figure>`,
                )}
                ${c.locked
                  ? ''
                  : button(`/characters/${c.id}/reference`, 'Generate (mock)', { slot_type: type, slot })}
              </div>`;
            })}
          </div>`,
    );
    const variantRefs = refs.filter((x) => x.variant_id !== null);
    return web.render(
      req,
      c.name,
      '/characters',
      html`<p class="muted"><a href="/characters?project=${c.project_id}">← all characters</a></p>
        ${card('Character Lock', lockPanel('characters', c.id, c.locked, c.locked_at))}
        ${card(
          'Reference sheet',
          html`${refGrid}
            <p class="muted">Upload your own reference image:</p>
            ${postForm(
              `/characters/${c.id}/upload-reference`,
              html`<div class="row">
                  ${select(
                    'Slot type',
                    'slot_type',
                    [
                      ['view', 'view'],
                      ['expression', 'expression'],
                      ['pose', 'pose'],
                      ['other', 'other'],
                    ],
                    'view',
                  )}${field('Slot', 'slot', 'front')}${select(
                    'Variant',
                    'variant_id',
                    options(variants, (v) => v.name, 'canonical'),
                    '',
                  )}
                </div>
                <label class="field"
                  ><span>Image (PNG/JPEG/WebP, ≤10 MB)</span
                  ><input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    data-read-into="image"
                    data-as="dataurl" /></label
                ><textarea name="image" hidden></textarea><button>Upload reference</button>`,
            )}`,
          '',
        )}
        ${card(
          'Variants (outfits / states — canonical identity unchanged)',
          html`${table(
            ['Name', 'Clothing override', 'Prompt additions', 'References', ''],
            variants.map((v) => [
              v.name,
              v.clothing_override,
              v.prompt_additions,
              html`${variantRefs
                .filter((x) => x.variant_id === v.id)
                .map((x) => html`<img class="thumb" src="${mediaUrl(x.storage_key)}" alt="" />`)}
              ${button(`/characters/${c.id}/reference`, 'Generate (mock)', {
                slot_type: 'view',
                slot: 'full_body',
                variant_id: v.id,
              })}`,
              button(
                `/variants/${v.id}/delete`,
                'Delete',
                {},
                { kind: 'danger', confirm: 'Delete variant?' },
              ),
            ]),
            'No variants.',
          )}
          ${postForm(
            `/characters/${c.id}/variants`,
            html`<div class="row">
                ${field('Name', 'name', '', { required: true, placeholder: 'e.g. Winter clothes' })}${field(
                  'Clothing override',
                  'clothing_override',
                  '',
                )}${field('Prompt additions', 'prompt_additions', '')}${field(
                  'Negative additions',
                  'negative_additions',
                  '',
                )}
              </div>
              <button>Add variant</button>`,
          )}`,
        )}
        ${card(
          c.locked ? 'Character details (canonical fields locked)' : 'Character details',
          postForm(
            `/characters/${c.id}/update`,
            html`${characterForm(web, c.project_id, c)}<button class="primary">Save</button>`,
          ),
        )}
        ${button(
          `/characters/${c.id}/delete`,
          'Delete character',
          {},
          { kind: 'danger', confirm: 'Delete this character?' },
        )}`,
    );
  });

  r.post('/characters/:id/update', (req) => {
    s.characters.update(req.params['id']!, formPatch(req.form));
    return web.redirect(`/characters/${req.params['id']}`, 'Saved');
  });
  r.post('/characters/:id/delete', (req) => {
    const c = s.characters.get(req.params['id']!);
    s.characters.delete(c.id);
    return web.redirect(`/characters?project=${c.project_id}`, 'Character deleted');
  });
  r.post('/characters/:id/lock', (req) => {
    s.characters.lock(req.params['id']!);
    return web.redirect(`/characters/${req.params['id']}`, 'Character locked');
  });
  r.post('/characters/:id/unlock', (req) => {
    s.characters.unlock(req.params['id']!, req.form['reason'] ?? '');
    return web.redirect(`/characters/${req.params['id']}`, 'Character unlocked');
  });
  r.post('/characters/:id/variants', (req) => {
    s.characters.createVariant(req.params['id']!, formPatch(req.form));
    return web.redirect(`/characters/${req.params['id']}`, 'Variant added');
  });
  r.post('/variants/:id/delete', (req) => {
    const v = s.characters.getVariant(req.params['id']!);
    s.characters.deleteVariant(v.id);
    return web.redirect(`/characters/${v.character_id}`, 'Variant deleted');
  });
  r.post('/characters/:id/reference', async (req) => {
    const id = req.params['id']!;
    s.generation.queueReference(
      { type: 'character', id },
      {
        slot_type: req.form['slot_type'] ?? 'view',
        slot: req.form['slot'] ?? 'front',
        variant_id: req.form['variant_id'] || null,
      },
      { mode: 'fast_preview' },
    );
    const result = await s.generation.processQueue();
    return web.redirect(
      `/characters/${id}`,
      `Mock reference generated (${result.completed} job(s), simulated ₹${result.simulatedCostInr}). Review and approve it.`,
    );
  });
  r.post(
    '/characters/:id/upload-reference',
    async (req) => {
      const c = s.characters.get(req.params['id']!);
      const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(req.form['image'] ?? '');
      if (!m) throw new AppError('VALIDATION_FAILED', 'Choose a PNG, JPEG or WebP image');
      const data = Buffer.from(m[3]!, 'base64');
      if (data.length > 10 * 1024 * 1024)
        throw new AppError('VALIDATION_FAILED', 'Image is larger than 10 MB');
      const magicOk =
        (m[2] === 'png' && data.subarray(0, 4).toString('hex') === '89504e47') ||
        (m[2] === 'jpeg' && data.subarray(0, 2).toString('hex') === 'ffd8') ||
        (m[2] === 'webp' && data.subarray(8, 12).toString('ascii') === 'WEBP');
      if (!magicOk) throw new AppError('VALIDATION_FAILED', 'File content does not match its image type');
      const ref = await s.assets.createReference(
        c.project_id,
        'character',
        c.id,
        data,
        m[2] === 'jpeg' ? 'jpg' : m[2]!,
        m[1]!,
        `${req.form['slot_type']}:${req.form['slot']}`,
        false,
      );
      s.characters.addReference(c.id, ref, {
        slot_type: req.form['slot_type'],
        slot: req.form['slot'],
        variant_id: req.form['variant_id'] || undefined,
      });
      return web.redirect(`/characters/${c.id}`, 'Reference uploaded — approve it to use it');
    },
    16 * 1024 * 1024,
  );
  r.post('/character-refs/:id/approve', (req) => {
    const row = s.db.get<{ character_id: string }>(
      'SELECT character_id FROM character_references WHERE id = ?',
      req.params['id']!,
    );
    if (!row) throw new AppError('NOT_FOUND', 'Reference not found');
    s.characters.setReferenceApproval(req.params['id']!, req.form['approved'] === 'true');
    return web.redirect(`/characters/${row.character_id}`, 'Reference updated');
  });

  // --- Voices -------------------------------------------------------------------------
  r.post('/voices', (req) => {
    const v = s.characters.createVoice(req.form['_project'] ?? '', formPatch(req.form));
    return web.redirect(`/voices/${v.id}`, 'Voice created');
  });
  r.get('/voices/:id', (req) => {
    const v = s.characters.getVoice(req.params['id']!);
    const previewKey = `projects/${v.project_id}/previews/voice-${v.id}.wav`;
    return web.render(
      req,
      `Voice: ${v.name}`,
      '/characters',
      html`<p class="muted"><a href="/characters?project=${v.project_id}">← characters & voices</a></p>
        ${card('Voice Lock', lockPanel('voices', v.id, v.locked, v.locked_at))}
        ${card(
          'Preview (emotion changes delivery, never identity)',
          html`${postForm(
            `/voices/${v.id}/preview`,
            html`<div class="row">
                ${field('Sample line', 'text', `Hello! My name is ${v.name}.`)}${select(
                  'Emotion',
                  'emotion',
                  EMOTIONS.map((e) => [e, e]),
                  v.default_emotion,
                )}
              </div>
              <button>Generate preview (mock, local CPU)</button>`,
          )}
          ${req.query.get('previewed')
            ? html`<audio controls src="${mediaUrl(previewKey)}?t=${Date.now()}"></audio>`
            : ''}`,
        )}
        ${card(
          v.locked ? 'Voice settings (identity locked)' : 'Voice settings',
          postForm(`/voices/${v.id}/update`, html`${voiceForm(v)}<button class="primary">Save</button>`),
        )}
        ${button(
          `/voices/${v.id}/delete`,
          'Delete voice',
          {},
          { kind: 'danger', confirm: 'Delete this voice profile?' },
        )}`,
    );
  });
  r.post('/voices/:id/update', (req) => {
    s.characters.updateVoice(req.params['id']!, formPatch(req.form));
    return web.redirect(`/voices/${req.params['id']}`, 'Saved');
  });
  r.post('/voices/:id/lock', (req) => {
    s.characters.lockVoice(req.params['id']!);
    return web.redirect(`/voices/${req.params['id']}`, 'Voice locked');
  });
  r.post('/voices/:id/unlock', (req) => {
    s.characters.unlockVoice(req.params['id']!, req.form['reason'] ?? '');
    return web.redirect(`/voices/${req.params['id']}`, 'Voice unlocked');
  });
  r.post('/voices/:id/delete', (req) => {
    const v = s.characters.getVoice(req.params['id']!);
    s.characters.deleteVoice(v.id);
    return web.redirect(`/characters?project=${v.project_id}`, 'Voice deleted');
  });
  r.post('/voices/:id/preview', async (req) => {
    const v = s.characters.getVoice(req.params['id']!);
    const vs = s.audio.voiceSettings(v);
    const res = await s.providers.tts.synthesize(
      {
        text: (req.form['text'] ?? '').slice(0, 300) || 'Hello.',
        language: vs.language,
        emotion: req.form['emotion'] ?? 'neutral',
        speed: 1,
        voice: vs,
      },
      { attemptKey: `preview:${v.id}` },
    );
    await s.storage.put(`projects/${v.project_id}/previews/voice-${v.id}.wav`, res.file.data);
    return web.redirect(`/voices/${v.id}?previewed=1`, 'Preview generated');
  });

  // --- Locations ------------------------------------------------------------------------
  r.get('/locations', (req) => {
    const pid = pickProject(req.query);
    if (!pid) return web.render(req, 'Locations', '/locations', html`<p>Create a project first.</p>`);
    return web.render(
      req,
      'Locations',
      '/locations',
      html`${projectPicker(web, pid, '/locations')}
      ${card(
        'Locations',
        table(
          ['Name', 'Environment', 'Time of day', 'Lock'],
          s.characters
            .listLocations(pid)
            .map((l) => [
              html`<a href="/locations/${l.id}">${l.name}</a>`,
              l.environment,
              l.time_of_day,
              l.locked ? badge('locked', 'good') : badge('unlocked', 'warn'),
            ]),
        ),
      )}
      ${card(
        'New location',
        postForm(
          '/locations',
          html`<input type="hidden" name="_project" value="${pid}" />${locationForm()}<button class="primary">
              Create location
            </button>`,
        ),
      )}`,
    );
  });
  r.post('/locations', (req) => {
    const l = s.characters.createLocation(req.form['_project'] ?? '', formPatch(req.form));
    return web.redirect(`/locations/${l.id}`, 'Location created');
  });
  r.get('/locations/:id', (req) => {
    const l = s.characters.getLocation(req.params['id']!);
    const refs = s.assets.listReferences('location', l.id);
    return web.render(
      req,
      l.name,
      '/locations',
      html`<p class="muted"><a href="/locations?project=${l.project_id}">← all locations</a></p>
        ${card('Location Lock', lockPanel('locations', l.id, l.locked, l.locked_at))}
        ${card(
          'References',
          html`<div class="refs">
              ${refs.map(
                (x) =>
                  html`<figure class="${x.approved ? 'approved' : ''}">
                    <img src="${mediaUrl(x.storage_key)}" alt="${x.label}" />${x.is_mock
                      ? html`<span class="mock-tag">MOCK</span>`
                      : ''}${l.locked
                      ? ''
                      : button(`/location-refs/${x.id}/approve`, x.approved ? 'Unapprove' : 'Approve', {
                          approved: x.approved ? 'false' : 'true',
                        })}
                  </figure>`,
              )}
            </div>
            ${l.locked
              ? ''
              : button(`/locations/${l.id}/reference`, 'Generate reference (mock)', { slot: 'wide' })}`,
        )}
        ${card(
          l.locked ? 'Details (locked)' : 'Details',
          postForm(
            `/locations/${l.id}/update`,
            html`${locationForm(l)}<button class="primary">Save</button>`,
          ),
        )}
        ${button(
          `/locations/${l.id}/delete`,
          'Delete location',
          {},
          { kind: 'danger', confirm: 'Delete this location?' },
        )}`,
    );
  });
  r.post('/locations/:id/update', (req) => {
    s.characters.updateLocation(req.params['id']!, formPatch(req.form));
    return web.redirect(`/locations/${req.params['id']}`, 'Saved');
  });
  r.post('/locations/:id/lock', (req) => {
    s.characters.lockLocation(req.params['id']!);
    return web.redirect(`/locations/${req.params['id']}`, 'Location locked');
  });
  r.post('/locations/:id/unlock', (req) => {
    s.characters.unlockLocation(req.params['id']!, req.form['reason'] ?? '');
    return web.redirect(`/locations/${req.params['id']}`, 'Location unlocked');
  });
  r.post('/locations/:id/delete', (req) => {
    const l = s.characters.getLocation(req.params['id']!);
    s.characters.deleteLocation(l.id);
    return web.redirect(`/locations?project=${l.project_id}`, 'Location deleted');
  });
  r.post('/locations/:id/reference', async (req) => {
    s.generation.queueReference(
      { type: 'location', id: req.params['id']! },
      { slot_type: 'view', slot: req.form['slot'] ?? 'wide' },
      { mode: 'fast_preview' },
    );
    await s.generation.processQueue();
    return web.redirect(`/locations/${req.params['id']}`, 'Mock reference generated');
  });
  r.post('/location-refs/:id/approve', (req) => {
    const ref = s.db.get<{ owner_id: string }>(
      "SELECT owner_id FROM reference_assets WHERE id = ? AND owner_type = 'location'",
      req.params['id']!,
    );
    if (!ref) throw new AppError('NOT_FOUND', 'Reference not found');
    s.assets.setReferenceApproved(req.params['id']!, req.form['approved'] === 'true');
    return web.redirect(`/locations/${ref.owner_id}`, 'Reference updated');
  });

  // --- Props ----------------------------------------------------------------------------
  r.get('/props', (req) => {
    const pid = pickProject(req.query);
    if (!pid) return web.render(req, 'Props', '/props', html`<p>Create a project first.</p>`);
    const chars = s.characters.list(pid);
    return web.render(
      req,
      'Props',
      '/props',
      html`${projectPicker(web, pid, '/props')}
      ${card(
        'Props',
        table(
          ['Name', 'Scale', 'Colours', 'Characters', 'Lock'],
          s.characters.listProps(pid).map((p) => [
            html`<a href="/props/${p.id}">${p.name}</a>`,
            p.scale,
            p.colors,
            s.characters
              .propCharacters(p.id)
              .map((id) => chars.find((c) => c.id === id)?.name ?? id)
              .join(', '),
            p.locked ? badge('locked', 'good') : badge('unlocked', 'warn'),
          ]),
        ),
      )}
      ${card(
        'New prop',
        postForm(
          '/props',
          html`<input type="hidden" name="_project" value="${pid}" />${propForm()}${select(
              'Associated characters',
              'characters',
              chars.map((c) => [c.id, c.name]),
              [],
              { multiple: true },
            )}<button class="primary">Create prop</button>`,
        ),
      )}`,
    );
  });
  r.post('/props', (req) => {
    const p = s.characters.createProp(
      req.form['_project'] ?? '',
      formPatch(req.form, ['name', 'description', 'scale', 'colors', 'prompt', 'negative_prompt']),
      req.formAll['characters'] ?? [],
    );
    return web.redirect(`/props/${p.id}`, 'Prop created');
  });
  r.get('/props/:id', (req) => {
    const p = s.characters.getProp(req.params['id']!);
    return web.render(
      req,
      p.name,
      '/props',
      html`<p class="muted"><a href="/props?project=${p.project_id}">← all props</a></p>
        ${card('Prop Lock', lockPanel('props', p.id, p.locked, p.locked_at))}
        ${card(
          p.locked ? 'Details (locked)' : 'Details',
          postForm(`/props/${p.id}/update`, html`${propForm(p)}<button class="primary">Save</button>`),
        )}
        ${button(
          `/props/${p.id}/delete`,
          'Delete prop',
          {},
          { kind: 'danger', confirm: 'Delete this prop?' },
        )}`,
    );
  });
  r.post('/props/:id/update', (req) => {
    s.characters.updateProp(req.params['id']!, formPatch(req.form));
    return web.redirect(`/props/${req.params['id']}`, 'Saved');
  });
  r.post('/props/:id/lock', (req) => {
    s.characters.lockProp(req.params['id']!);
    return web.redirect(`/props/${req.params['id']}`, 'Prop locked');
  });
  r.post('/props/:id/unlock', (req) => {
    s.characters.unlockProp(req.params['id']!, req.form['reason'] ?? '');
    return web.redirect(`/props/${req.params['id']}`, 'Prop unlocked');
  });
  r.post('/props/:id/delete', (req) => {
    const p = s.characters.getProp(req.params['id']!);
    s.characters.deleteProp(p.id);
    return web.redirect(`/props?project=${p.project_id}`, 'Prop deleted');
  });
}
