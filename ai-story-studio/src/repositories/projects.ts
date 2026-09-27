import type { Database } from '../db/database.ts';
import type { Project, StylePreset } from '../domain/types.ts';
import { EXPORT_PROFILES } from '../domain/enums.ts';
import { projectInput, styleInput } from '../domain/inputs.ts';
import { newId } from '../lib/ids.ts';
import { parseOrThrow, pickKnown } from '../lib/schema.ts';
import { nowIso, requireRow } from './base.ts';

export class ProjectRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  list(): Project[] {
    return this.db.all<Project>('SELECT * FROM projects ORDER BY updated_at DESC');
  }

  get(id: string): Project {
    return requireRow<Project>(this.db, 'projects', id, 'Project');
  }

  find(id: string): Project | undefined {
    return this.db.get<Project>('SELECT * FROM projects WHERE id = ?', id);
  }

  create(input: unknown): Project {
    const v = parseOrThrow(projectInput, input, 'project');
    const id = newId('prj');
    const now = nowIso();
    const size = v.aspect_ratio === '9:16' ? EXPORT_PROFILES.vertical : EXPORT_PROFILES.landscape;
    this.db.insert('projects', {
      id,
      name: v.name,
      series: v.series,
      description: v.description,
      genre: v.genre,
      target_audience: v.target_audience,
      default_style_id: v.default_style_id ?? null,
      width: size.width,
      height: size.height,
      aspect_ratio: v.aspect_ratio,
      fps: v.fps,
      default_quality: v.default_quality,
      narrator_voice_id: v.narrator_voice_id ?? null,
      production_notes: v.production_notes,
      created_at: now,
      updated_at: now,
    });
    return this.get(id);
  }

  update(id: string, patch: Record<string, unknown>): Project {
    const current = this.get(id);
    const v = parseOrThrow(projectInput, pickKnown(projectInput, { ...current, ...patch }), 'project');
    const size = v.aspect_ratio === '9:16' ? EXPORT_PROFILES.vertical : EXPORT_PROFILES.landscape;
    this.db.update('projects', id, {
      name: v.name,
      series: v.series,
      description: v.description,
      genre: v.genre,
      target_audience: v.target_audience,
      default_style_id: v.default_style_id ?? null,
      width: size.width,
      height: size.height,
      aspect_ratio: v.aspect_ratio,
      fps: v.fps,
      default_quality: v.default_quality,
      narrator_voice_id: v.narrator_voice_id ?? null,
      production_notes: v.production_notes,
      updated_at: nowIso(),
    });
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.run('DELETE FROM projects WHERE id = ?', id);
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  // --- Style presets (global when project_id is NULL) ---------------------

  listStyles(projectId?: string): StylePreset[] {
    return projectId
      ? this.db.all<StylePreset>(
          'SELECT * FROM style_presets WHERE project_id = ? OR project_id IS NULL ORDER BY project_id IS NULL, name',
          projectId,
        )
      : this.db.all<StylePreset>('SELECT * FROM style_presets ORDER BY name');
  }

  getStyle(id: string): StylePreset {
    return requireRow<StylePreset>(this.db, 'style_presets', id, 'Style preset');
  }

  createStyle(input: unknown, projectId: string | null = null): StylePreset {
    const v = parseOrThrow(styleInput, input, 'style preset');
    const id = newId('sty');
    const now = nowIso();
    this.db.insert('style_presets', { id, project_id: projectId, ...v, created_at: now, updated_at: now });
    return this.getStyle(id);
  }

  updateStyle(id: string, patch: Record<string, unknown>): StylePreset {
    const current = this.getStyle(id);
    const v = parseOrThrow(styleInput, pickKnown(styleInput, { ...current, ...patch }), 'style preset');
    this.db.update('style_presets', id, { ...v, updated_at: nowIso() });
    return this.getStyle(id);
  }

  deleteStyle(id: string): void {
    this.getStyle(id);
    this.db.run('DELETE FROM style_presets WHERE id = ?', id);
  }
}

/** Built-in style presets (spec §15). Not hard-coded into generation: they are ordinary editable rows. */
export const BUILTIN_STYLES = [
  {
    name: 'Premium 3D children’s animation',
    style_prompt:
      'premium 3D animated film still, soft global illumination, appealing stylised characters, rich detail',
    rendering: 'physically based rendering, subsurface scattering, soft shadows',
    lighting: 'warm key light, gentle rim light',
    colors: 'vibrant but harmonious palette',
    camera: 'cinematic 35mm lens, shallow depth of field',
    negative_prompt: 'photorealistic, gore, text, watermark, deformed hands, extra limbs',
  },
  {
    name: '2D cartoon',
    style_prompt: 'clean 2D cartoon illustration, bold outlines, flat shading',
    rendering: 'vector-like cel shading',
    lighting: 'even, bright',
    colors: 'saturated primary colours',
    camera: 'flat orthographic staging',
    negative_prompt: '3D render, photorealistic, text, watermark',
  },
  {
    name: 'Storybook',
    style_prompt: 'illustrated storybook page, textured paper, hand-painted look',
    rendering: 'gouache and coloured pencil texture',
    lighting: 'soft diffuse daylight',
    colors: 'muted warm palette',
    camera: 'wide storybook composition',
    negative_prompt: 'photorealistic, harsh contrast, text, watermark',
  },
  {
    name: 'Clay',
    style_prompt: 'stop-motion claymation style, handmade plasticine textures, fingerprints',
    rendering: 'miniature set, tactile materials',
    lighting: 'practical miniature lighting',
    colors: 'playful pastel palette',
    camera: 'macro lens, slight tilt-shift',
    negative_prompt: 'smooth CGI, photorealistic humans, text',
  },
  {
    name: 'Cinematic fantasy',
    style_prompt: 'epic cinematic fantasy concept art, atmospheric depth',
    rendering: 'painterly detail, volumetric fog',
    lighting: 'dramatic golden-hour light shafts',
    colors: 'deep teal and amber',
    camera: 'anamorphic wide shot',
    negative_prompt: 'cartoon, flat, text, watermark',
  },
  {
    name: 'Anime-inspired',
    style_prompt: 'anime-inspired key visual, expressive eyes, clean line art',
    rendering: 'cel shading with soft gradients',
    lighting: 'bright sky light, lens bloom',
    colors: 'clear saturated colours',
    camera: 'dynamic angles',
    negative_prompt: 'photorealistic, 3D render, text, watermark',
  },
  {
    name: 'Watercolor',
    style_prompt: 'delicate watercolor illustration, wet-on-wet blooms, paper grain',
    rendering: 'transparent washes, soft edges',
    lighting: 'airy natural light',
    colors: 'soft pastel washes',
    camera: 'gentle wide framing',
    negative_prompt: 'hard outlines, 3D, photorealistic, text',
  },
  {
    name: 'Educational animation',
    style_prompt: 'friendly educational explainer animation, clear readable shapes',
    rendering: 'simple flat shapes, clean design',
    lighting: 'bright even lighting',
    colors: 'high-contrast accessible palette',
    camera: 'clear medium shots',
    negative_prompt: 'clutter, scary imagery, text artefacts, watermark',
  },
];

export function ensureBuiltinStyles(repo: ProjectRepository): void {
  const existing = new Set(
    repo
      .listStyles()
      .filter((s) => s.project_id === null)
      .map((s) => s.name),
  );
  for (const style of BUILTIN_STYLES) if (!existing.has(style.name)) repo.createStyle(style, null);
}
