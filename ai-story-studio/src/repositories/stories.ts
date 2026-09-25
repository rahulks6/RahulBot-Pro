import type { Database } from '../db/database.ts';
import type {
  DialogueLine,
  NarrationLine,
  Scene,
  Shot,
  ShotCharacter,
  ShotSfx,
  Story,
} from '../domain/types.ts';
import { dialogueInput, narrationInput, sceneInput, shotInput, storyInput } from '../domain/inputs.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseOrThrow, pickKnown } from '../lib/schema.ts';
import { compactPositions, flag, moveRow, nextPosition, nowIso, reorderRows, requireRow } from './base.ts';

export interface StoryTree {
  story: Story;
  scenes: Array<{
    scene: Scene;
    narration: NarrationLine[];
    shots: Array<{
      shot: Shot;
      characters: ShotCharacter[];
      propIds: string[];
      sfx: ShotSfx[];
      dialogue: DialogueLine[];
    }>;
  }>;
}

export class StoryRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- Stories ------------------------------------------------------------------

  list(projectId: string): Story[] {
    return this.db.all<Story>(
      'SELECT * FROM stories WHERE project_id = ? ORDER BY COALESCE(episode_number, 1e9), created_at',
      projectId,
    );
  }

  get(id: string): Story {
    return requireRow<Story>(this.db, 'stories', id, 'Story');
  }

  create(projectId: string, input: unknown): Story {
    const v = parseOrThrow(storyInput, input, 'story');
    const id = newId('sto');
    const now = nowIso();
    this.db.insert('stories', {
      id,
      project_id: projectId,
      ...v,
      episode_number: v.episode_number ?? null,
      created_at: now,
      updated_at: now,
    });
    return this.get(id);
  }

  update(id: string, patch: Record<string, unknown>): Story {
    const current = this.get(id);
    const v = parseOrThrow(storyInput, pickKnown(storyInput, { ...current, ...patch }), 'story');
    this.db.update('stories', id, { ...v, episode_number: v.episode_number ?? null, updated_at: nowIso() });
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.run('DELETE FROM stories WHERE id = ?', id);
  }

  // --- Scenes -------------------------------------------------------------------

  listScenes(storyId: string): Scene[] {
    return this.db.all<Scene>('SELECT * FROM scenes WHERE story_id = ? ORDER BY position', storyId);
  }

  getScene(id: string): Scene {
    return requireRow<Scene>(this.db, 'scenes', id, 'Scene');
  }

  createScene(storyId: string, input: unknown): Scene {
    this.get(storyId);
    const v = parseOrThrow(sceneInput, input, 'scene');
    const id = newId('scn');
    const now = nowIso();
    this.db.insert('scenes', {
      id,
      story_id: storyId,
      position: nextPosition(this.db, 'scenes', 'story_id', storyId),
      ...v,
      location_id: v.location_id ?? null,
      created_at: now,
      updated_at: now,
    });
    return this.getScene(id);
  }

  updateScene(id: string, patch: Record<string, unknown>): Scene {
    const current = this.getScene(id);
    const v = parseOrThrow(sceneInput, pickKnown(sceneInput, { ...current, ...patch }), 'scene');
    this.db.update('scenes', id, { ...v, location_id: v.location_id ?? null, updated_at: nowIso() });
    return this.getScene(id);
  }

  deleteScene(id: string): void {
    const scene = this.getScene(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM scenes WHERE id = ?', id);
      compactPositions(this.db, 'scenes', 'story_id', scene.story_id);
    });
  }

  moveScene(id: string, direction: 'up' | 'down'): void {
    moveRow(this.db, 'scenes', 'story_id', id, direction);
  }

  reorderScenes(storyId: string, ids: string[]): void {
    reorderRows(this.db, 'scenes', 'story_id', storyId, ids);
  }

  // --- Shots --------------------------------------------------------------------

  listShots(sceneId: string): Shot[] {
    return this.db.all<Shot>('SELECT * FROM shots WHERE scene_id = ? ORDER BY position', sceneId);
  }

  listStoryShots(storyId: string): Array<Shot & { scene_position: number }> {
    return this.db.all(
      `SELECT s.*, sc.position AS scene_position FROM shots s JOIN scenes sc ON sc.id = s.scene_id
       WHERE sc.story_id = ? ORDER BY sc.position, s.position`,
      storyId,
    );
  }

  getShot(id: string): Shot {
    return requireRow<Shot>(this.db, 'shots', id, 'Shot');
  }

  storyIdForShot(shotId: string): string {
    const row = this.db.get<{ story_id: string }>(
      'SELECT sc.story_id FROM shots s JOIN scenes sc ON sc.id = s.scene_id WHERE s.id = ?',
      shotId,
    );
    if (!row) throw new AppError('NOT_FOUND', `Shot not found: ${shotId}`);
    return row.story_id;
  }

  projectIdForStory(storyId: string): string {
    return this.get(storyId).project_id;
  }

  createShot(sceneId: string, input: unknown): Shot {
    this.getScene(sceneId);
    const v = parseOrThrow(shotInput, input, 'shot');
    const id = newId('sht');
    const now = nowIso();
    this.db.insert('shots', {
      id,
      scene_id: sceneId,
      position: nextPosition(this.db, 'shots', 'scene_id', sceneId),
      ...v,
      location_id: v.location_id ?? null,
      style_id: v.style_id ?? null,
      seed: v.seed ?? null,
      image_prompt_locked: flag(v.image_prompt_locked),
      motion_prompt_locked: flag(v.motion_prompt_locked),
      negative_prompt_locked: flag(v.negative_prompt_locked),
      mouth_visible: flag(v.mouth_visible),
      lipsync_enabled: flag(v.lipsync_enabled),
      created_at: now,
      updated_at: now,
    });
    return this.getShot(id);
  }

  /**
   * Update shot fields from the user. A locked prompt is the user's manual
   * prompt, so editing its text here is allowed; the automatic prompt builder
   * can only write prompts through `applyBuiltPrompt`, which refuses locked ones.
   */
  updateShot(id: string, patch: Record<string, unknown>): Shot {
    const current = this.getShot(id);
    const merged = pickKnown(shotInput, { ...current, ...patch });
    const v = parseOrThrow(shotInput, merged, 'shot');
    this.db.update('shots', id, {
      ...v,
      location_id: v.location_id ?? null,
      style_id: v.style_id ?? null,
      seed: v.seed ?? null,
      image_prompt_locked: flag(v.image_prompt_locked),
      motion_prompt_locked: flag(v.motion_prompt_locked),
      negative_prompt_locked: flag(v.negative_prompt_locked),
      mouth_visible: flag(v.mouth_visible),
      lipsync_enabled: flag(v.lipsync_enabled),
      updated_at: nowIso(),
    });
    return this.getShot(id);
  }

  /** Store builder output as the shot's editable prompt; refuses to touch manually locked prompts. */
  applyBuiltPrompt(
    id: string,
    field: 'image_prompt' | 'motion_prompt' | 'negative_prompt',
    text: string,
  ): Shot {
    const shot = this.getShot(id);
    if (shot[`${field}_locked`]) {
      throw new AppError(
        'LOCKED',
        `The ${field.replace('_', ' ')} is manually locked and will not be overwritten.`,
      );
    }
    this.db.update('shots', id, { [field]: text, updated_at: nowIso() });
    return this.getShot(id);
  }

  setShotState(
    id: string,
    values: Partial<
      Pick<
        Shot,
        'approval_state' | 'approved_image_asset_id' | 'approved_video_asset_id' | 'lipsync_video_asset_id'
      >
    >,
  ): void {
    this.db.update('shots', id, { ...values, updated_at: nowIso() });
  }

  deleteShot(id: string): void {
    const shot = this.getShot(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM shots WHERE id = ?', id);
      compactPositions(this.db, 'shots', 'scene_id', shot.scene_id);
    });
  }

  moveShot(id: string, direction: 'up' | 'down'): void {
    moveRow(this.db, 'shots', 'scene_id', id, direction);
  }

  reorderShots(sceneId: string, ids: string[]): void {
    reorderRows(this.db, 'shots', 'scene_id', sceneId, ids);
  }

  // --- Shot cast / props / SFX ----------------------------------------------------

  shotCharacters(shotId: string): ShotCharacter[] {
    return this.db.all<ShotCharacter>(
      'SELECT * FROM shot_characters WHERE shot_id = ? ORDER BY position',
      shotId,
    );
  }

  setShotCharacters(shotId: string, cast: Array<{ character_id: string; variant_id?: string | null }>): void {
    const shot = this.getShot(shotId);
    const projectId = this.projectIdForStory(this.storyIdForShot(shot.id));
    this.db.transaction(() => {
      this.db.run('DELETE FROM shot_characters WHERE shot_id = ?', shotId);
      cast.forEach((c, i) => {
        const owner = this.db.get<{ project_id: string }>(
          'SELECT project_id FROM characters WHERE id = ?',
          c.character_id,
        );
        if (owner?.project_id !== projectId)
          throw new AppError('VALIDATION_FAILED', `Unknown character ${c.character_id}`);
        if (c.variant_id) {
          const variant = this.db.get<{ character_id: string }>(
            'SELECT character_id FROM character_variants WHERE id = ?',
            c.variant_id,
          );
          if (variant?.character_id !== c.character_id)
            throw new AppError('VALIDATION_FAILED', 'Variant does not belong to character');
        }
        this.db.insert('shot_characters', {
          shot_id: shotId,
          character_id: c.character_id,
          variant_id: c.variant_id ?? null,
          position: i,
        });
      });
    });
  }

  shotPropIds(shotId: string): string[] {
    return this.db
      .all<{ prop_id: string }>('SELECT prop_id FROM shot_props WHERE shot_id = ?', shotId)
      .map((r) => r.prop_id);
  }

  setShotProps(shotId: string, propIds: string[]): void {
    this.getShot(shotId);
    this.db.transaction(() => {
      this.db.run('DELETE FROM shot_props WHERE shot_id = ?', shotId);
      for (const pid of new Set(propIds)) this.db.insert('shot_props', { shot_id: shotId, prop_id: pid });
    });
  }

  listShotSfx(shotId: string): ShotSfx[] {
    return this.db.all<ShotSfx>('SELECT * FROM shot_sfx WHERE shot_id = ? ORDER BY offset_sec, tag', shotId);
  }

  addShotSfx(
    shotId: string,
    tag: string,
    opts: { offsetSec?: number; required?: boolean; source?: ShotSfx['source']; approved?: boolean } = {},
  ): ShotSfx {
    this.getShot(shotId);
    const clean = tag.trim().toLowerCase().slice(0, 60);
    if (!clean) throw new AppError('VALIDATION_FAILED', 'SFX tag is required');
    const id = newId('sfx');
    this.db.insert('shot_sfx', {
      id,
      shot_id: shotId,
      tag: clean,
      offset_sec: Math.max(0, opts.offsetSec ?? 0),
      required: flag(opts.required),
      source: opts.source ?? 'manual',
      // Manual and package entries are deliberate choices; suggestions need review.
      approved: flag(opts.approved ?? opts.source !== 'suggested'),
      created_at: nowIso(),
    });
    return requireRow<ShotSfx>(this.db, 'shot_sfx', id);
  }

  setShotSfxApproval(id: string, approved: boolean): void {
    this.db.run('UPDATE shot_sfx SET approved = ? WHERE id = ?', flag(approved), id);
  }

  deleteShotSfx(id: string): void {
    this.db.run('DELETE FROM shot_sfx WHERE id = ?', id);
  }

  // --- Dialogue / narration --------------------------------------------------------

  listDialogue(shotId: string): DialogueLine[] {
    return this.db.all<DialogueLine>(
      'SELECT * FROM dialogue_lines WHERE shot_id = ? ORDER BY position',
      shotId,
    );
  }

  getDialogue(id: string): DialogueLine {
    return requireRow<DialogueLine>(this.db, 'dialogue_lines', id, 'Dialogue line');
  }

  addDialogue(shotId: string, input: unknown): DialogueLine {
    this.getShot(shotId);
    const v = parseOrThrow(dialogueInput, input, 'dialogue');
    const id = newId('dlg');
    const now = nowIso();
    this.db.insert('dialogue_lines', {
      id,
      shot_id: shotId,
      position: nextPosition(this.db, 'dialogue_lines', 'shot_id', shotId),
      ...v,
      character_id: v.character_id ?? null,
      required: flag(v.required),
      created_at: now,
      updated_at: now,
    });
    return this.getDialogue(id);
  }

  /** Changing text/emotion/speed invalidates the generated audio (partial rebuild, spec §70). */
  updateDialogue(id: string, patch: Record<string, unknown>): DialogueLine {
    const current = this.getDialogue(id);
    const v = parseOrThrow(dialogueInput, pickKnown(dialogueInput, { ...current, ...patch }), 'dialogue');
    const audioChanged =
      v.text !== current.text ||
      v.emotion !== current.emotion ||
      v.speed !== current.speed ||
      v.language !== current.language ||
      (v.character_id ?? null) !== current.character_id;
    this.db.update('dialogue_lines', id, {
      ...v,
      character_id: v.character_id ?? null,
      required: flag(v.required),
      audio_asset_id: audioChanged ? null : current.audio_asset_id,
      updated_at: nowIso(),
    });
    return this.getDialogue(id);
  }

  deleteDialogue(id: string): void {
    const line = this.getDialogue(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM dialogue_lines WHERE id = ?', id);
      compactPositions(this.db, 'dialogue_lines', 'shot_id', line.shot_id);
    });
  }

  setDialogueAudio(id: string, audioAssetId: string | null): void {
    this.db.run(
      'UPDATE dialogue_lines SET audio_asset_id = ?, updated_at = ? WHERE id = ?',
      audioAssetId,
      nowIso(),
      id,
    );
  }

  listNarration(sceneId: string): NarrationLine[] {
    return this.db.all<NarrationLine>(
      'SELECT * FROM narration_lines WHERE scene_id = ? ORDER BY position',
      sceneId,
    );
  }

  getNarration(id: string): NarrationLine {
    return requireRow<NarrationLine>(this.db, 'narration_lines', id, 'Narration line');
  }

  addNarration(sceneId: string, input: unknown): NarrationLine {
    this.getScene(sceneId);
    const v = parseOrThrow(narrationInput, input, 'narration');
    if (v.shot_id && this.getShot(v.shot_id).scene_id !== sceneId) {
      throw new AppError('VALIDATION_FAILED', 'Narration shot must belong to the same scene');
    }
    const id = newId('nar');
    const now = nowIso();
    this.db.insert('narration_lines', {
      id,
      scene_id: sceneId,
      position: nextPosition(this.db, 'narration_lines', 'scene_id', sceneId),
      ...v,
      shot_id: v.shot_id ?? null,
      required: flag(v.required),
      created_at: now,
      updated_at: now,
    });
    return this.getNarration(id);
  }

  updateNarration(id: string, patch: Record<string, unknown>): NarrationLine {
    const current = this.getNarration(id);
    const v = parseOrThrow(narrationInput, pickKnown(narrationInput, { ...current, ...patch }), 'narration');
    const audioChanged =
      v.text !== current.text ||
      v.emotion !== current.emotion ||
      v.speed !== current.speed ||
      v.language !== current.language;
    this.db.update('narration_lines', id, {
      ...v,
      shot_id: v.shot_id ?? null,
      required: flag(v.required),
      audio_asset_id: audioChanged ? null : current.audio_asset_id,
      updated_at: nowIso(),
    });
    return this.getNarration(id);
  }

  deleteNarration(id: string): void {
    const line = this.getNarration(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM narration_lines WHERE id = ?', id);
      compactPositions(this.db, 'narration_lines', 'scene_id', line.scene_id);
    });
  }

  setNarrationAudio(id: string, audioAssetId: string | null): void {
    this.db.run(
      'UPDATE narration_lines SET audio_asset_id = ?, updated_at = ? WHERE id = ?',
      audioAssetId,
      nowIso(),
      id,
    );
  }

  /** Whole story with scenes, shots, cast, SFX, dialogue and narration, in order. */
  tree(storyId: string): StoryTree {
    const story = this.get(storyId);
    return {
      story,
      scenes: this.listScenes(storyId).map((scene) => ({
        scene,
        narration: this.listNarration(scene.id),
        shots: this.listShots(scene.id).map((shot) => ({
          shot,
          characters: this.shotCharacters(shot.id),
          propIds: this.shotPropIds(shot.id),
          sfx: this.listShotSfx(shot.id),
          dialogue: this.listDialogue(shot.id),
        })),
      })),
    };
  }
}
