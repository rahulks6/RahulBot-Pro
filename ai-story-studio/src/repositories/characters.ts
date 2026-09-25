import type { Database } from '../db/database.ts';
import type {
  Character,
  CharacterReference,
  CharacterVariant,
  Location,
  Prop,
  ReferenceAsset,
  VoiceProfile,
} from '../domain/types.ts';
import {
  characterInput,
  locationInput,
  propInput,
  referenceSlotInput,
  variantInput,
  voiceInput,
} from '../domain/inputs.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { parseOrThrow, pickKnown } from '../lib/schema.ts';
import { assertLockedFieldsUnchanged, nowIso, requireRow } from './base.ts';

/** Canonical character identity fields frozen by Character Lock (spec §11). */
export const CHARACTER_LOCK_FIELDS = [
  'species',
  'appearance',
  'face',
  'hair',
  'eyes',
  'body',
  'proportions',
  'colors',
  'clothing',
  'accessories',
  'prompt',
  'negative_prompt',
  'preferred_seeds_json',
  'generation_settings_json',
] as const;

export const LOCATION_LOCK_FIELDS = [
  'description',
  'environment',
  'architecture',
  'important_objects',
  'colors',
  'lighting',
  'weather',
  'time_of_day',
  'prompt',
  'negative_prompt',
] as const;

export const PROP_LOCK_FIELDS = ['description', 'scale', 'colors', 'prompt', 'negative_prompt'] as const;

/** Voice Lock (spec §26): identity cannot drift; emotion is a per-line delivery parameter instead. */
export const VOICE_LOCK_FIELDS = [
  'voice_model',
  'voice_identity',
  'reference_asset_id',
  'language',
  'presentation',
  'pitch',
  'speed',
  'speaking_style',
  'narration_style',
  'default_emotion',
  'settings_json',
] as const;

export interface CharacterLockSnapshot {
  fields: Record<string, unknown>;
  referenceIds: string[];
  lockedAt: string;
}

export class CharacterRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- Characters -----------------------------------------------------------

  list(projectId: string): Character[] {
    return this.db.all<Character>('SELECT * FROM characters WHERE project_id = ? ORDER BY name', projectId);
  }

  get(id: string): Character {
    return requireRow<Character>(this.db, 'characters', id, 'Character');
  }

  findByName(projectId: string, name: string): Character | undefined {
    return this.db.get<Character>(
      'SELECT * FROM characters WHERE project_id = ? AND name = ? COLLATE NOCASE',
      projectId,
      name,
    );
  }

  create(projectId: string, input: unknown): Character {
    const v = parseOrThrow(characterInput, input, 'character');
    if (this.findByName(projectId, v.name))
      throw new AppError('CONFLICT', `A character named "${v.name}" already exists`);
    const id = newId('chr');
    const now = nowIso();
    const { preferred_seeds, generation_settings, ...rest } = v;
    this.db.insert('characters', {
      id,
      project_id: projectId,
      ...rest,
      voice_profile_id: v.voice_profile_id ?? null,
      preferred_seeds_json: JSON.stringify(preferred_seeds),
      generation_settings_json: JSON.stringify(generation_settings),
      created_at: now,
      updated_at: now,
    });
    return this.get(id);
  }

  update(id: string, patch: Record<string, unknown>): Character {
    const current = this.get(id);
    const merged = {
      ...current,
      preferred_seeds: parseJson<number[]>(current.preferred_seeds_json, []),
      generation_settings: parseJson<Record<string, unknown>>(current.generation_settings_json, {}),
      ...patch,
    };
    const { preferred_seeds, generation_settings, ...rest } = parseOrThrow(
      characterInput,
      pickKnown(characterInput, merged),
      'character',
    );
    const next = {
      ...rest,
      voice_profile_id: rest.voice_profile_id ?? null,
      preferred_seeds_json: JSON.stringify(preferred_seeds),
      generation_settings_json: JSON.stringify(generation_settings),
    };
    assertLockedFieldsUnchanged(
      'Character',
      current as unknown as Record<string, unknown>,
      next,
      CHARACTER_LOCK_FIELDS,
    );
    if (next.name !== current.name) {
      const clash = this.findByName(current.project_id, next.name);
      if (clash && clash.id !== id)
        throw new AppError('CONFLICT', `A character named "${next.name}" already exists`);
    }
    this.db.update('characters', id, { ...next, updated_at: nowIso() });
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.run('DELETE FROM characters WHERE id = ?', id);
  }

  /** Character Lock: freeze canonical identity + approved canonical references. */
  lock(id: string): Character {
    const c = this.get(id);
    const refs = this.listReferences(id).filter((r) => r.approved && r.variant_id === null);
    const snapshot: CharacterLockSnapshot = {
      fields: Object.fromEntries(CHARACTER_LOCK_FIELDS.map((f) => [f, c[f]])),
      referenceIds: refs.map((r) => r.reference_asset_id),
      lockedAt: nowIso(),
    };
    this.db.update('characters', id, {
      locked: 1,
      locked_at: snapshot.lockedAt,
      lock_snapshot_json: JSON.stringify(snapshot),
      updated_at: nowIso(),
    });
    return this.get(id);
  }

  /** Explicit unlock (requires a reason; recorded in the snapshot history). */
  unlock(id: string, reason: string): Character {
    if (!reason.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required to unlock a character');
    const c = this.get(id);
    const prev = parseJson<Record<string, unknown>>(c.lock_snapshot_json, {});
    this.db.update('characters', id, {
      locked: 0,
      lock_snapshot_json: JSON.stringify({ ...prev, unlockedAt: nowIso(), unlockReason: reason.trim() }),
      updated_at: nowIso(),
    });
    return this.get(id);
  }

  lockSnapshot(c: Character): CharacterLockSnapshot | undefined {
    if (!c.locked) return undefined;
    return parseJson<CharacterLockSnapshot | undefined>(c.lock_snapshot_json, undefined);
  }

  // --- Variants -------------------------------------------------------------

  listVariants(characterId: string): CharacterVariant[] {
    return this.db.all<CharacterVariant>(
      'SELECT * FROM character_variants WHERE character_id = ? ORDER BY name',
      characterId,
    );
  }

  getVariant(id: string): CharacterVariant {
    return requireRow<CharacterVariant>(this.db, 'character_variants', id, 'Character variant');
  }

  /** Variants are allowed on locked characters: they add to, never replace, the canonical identity. */
  createVariant(characterId: string, input: unknown): CharacterVariant {
    this.get(characterId);
    const v = parseOrThrow(variantInput, input, 'variant');
    const id = newId('var');
    const now = nowIso();
    this.db.insert('character_variants', {
      id,
      character_id: characterId,
      ...v,
      created_at: now,
      updated_at: now,
    });
    return this.getVariant(id);
  }

  updateVariant(id: string, patch: Record<string, unknown>): CharacterVariant {
    const current = this.getVariant(id);
    const v = parseOrThrow(variantInput, pickKnown(variantInput, { ...current, ...patch }), 'variant');
    this.db.update('character_variants', id, { ...v, updated_at: nowIso() });
    return this.getVariant(id);
  }

  deleteVariant(id: string): void {
    this.getVariant(id);
    this.db.run('DELETE FROM character_variants WHERE id = ?', id);
  }

  // --- References -----------------------------------------------------------

  listReferences(characterId: string): Array<CharacterReference & { storage_key: string; is_mock: number }> {
    return this.db.all(
      `SELECT cr.*, ra.storage_key, ra.is_mock FROM character_references cr
       JOIN reference_assets ra ON ra.id = cr.reference_asset_id
       WHERE cr.character_id = ? ORDER BY cr.variant_id IS NOT NULL, cr.slot_type, cr.slot, cr.created_at`,
      characterId,
    );
  }

  addReference(characterId: string, referenceAsset: ReferenceAsset, input: unknown): CharacterReference {
    const c = this.get(characterId);
    const v = parseOrThrow(referenceSlotInput, input, 'reference slot');
    if (c.locked && !v.variant_id) {
      throw new AppError(
        'LOCKED',
        'Character is locked; canonical references are frozen. Add references to a variant instead.',
      );
    }
    if (v.variant_id && this.getVariant(v.variant_id).character_id !== characterId) {
      throw new AppError('VALIDATION_FAILED', 'Variant belongs to another character');
    }
    const id = newId('cref');
    this.db.insert('character_references', {
      id,
      character_id: characterId,
      variant_id: v.variant_id ?? null,
      slot_type: v.slot_type,
      slot: v.slot,
      reference_asset_id: referenceAsset.id,
      approved: 0,
      created_at: nowIso(),
    });
    return requireRow<CharacterReference>(this.db, 'character_references', id);
  }

  setReferenceApproval(referenceId: string, approved: boolean): void {
    const ref = requireRow<CharacterReference>(
      this.db,
      'character_references',
      referenceId,
      'Character reference',
    );
    const c = this.get(ref.character_id);
    if (c.locked && ref.variant_id === null) {
      throw new AppError('LOCKED', 'Character is locked; canonical reference approvals are frozen.');
    }
    this.db.run('UPDATE character_references SET approved = ? WHERE id = ?', approved ? 1 : 0, referenceId);
    this.db.run(
      'UPDATE reference_assets SET approved = ? WHERE id = ?',
      approved ? 1 : 0,
      ref.reference_asset_id,
    );
  }

  /** Approved reference asset ids used for generation (canonical + chosen variant). */
  approvedReferenceKeys(
    characterId: string,
    variantId: string | null,
  ): Array<{ storage_key: string; slot: string }> {
    const c = this.get(characterId);
    const snapshot = this.lockSnapshot(c);
    return this.listReferences(characterId)
      .filter((r) => r.approved && (r.variant_id === null || r.variant_id === variantId))
      .filter(
        (r) => !snapshot || r.variant_id !== null || snapshot.referenceIds.includes(r.reference_asset_id),
      )
      .map((r) => ({ storage_key: r.storage_key, slot: `${r.slot_type}:${r.slot}` }));
  }

  // --- Voice profiles ---------------------------------------------------------

  listVoices(projectId: string): VoiceProfile[] {
    return this.db.all<VoiceProfile>(
      'SELECT * FROM voice_profiles WHERE project_id = ? ORDER BY role DESC, name',
      projectId,
    );
  }

  getVoice(id: string): VoiceProfile {
    return requireRow<VoiceProfile>(this.db, 'voice_profiles', id, 'Voice profile');
  }

  createVoice(projectId: string, input: unknown): VoiceProfile {
    const { settings, ...v } = parseOrThrow(voiceInput, input, 'voice profile');
    const id = newId('vox');
    const now = nowIso();
    this.db.insert('voice_profiles', {
      id,
      project_id: projectId,
      ...v,
      settings_json: JSON.stringify(settings),
      created_at: now,
      updated_at: now,
    });
    return this.getVoice(id);
  }

  updateVoice(id: string, patch: Record<string, unknown>): VoiceProfile {
    const current = this.getVoice(id);
    const merged = {
      ...current,
      settings: parseJson<Record<string, unknown>>(current.settings_json, {}),
      ...patch,
    };
    const { settings, ...v } = parseOrThrow(voiceInput, pickKnown(voiceInput, merged), 'voice profile');
    const next = { ...v, settings_json: JSON.stringify(settings) };
    assertLockedFieldsUnchanged(
      'Voice',
      current as unknown as Record<string, unknown>,
      next,
      VOICE_LOCK_FIELDS,
    );
    this.db.update('voice_profiles', id, { ...next, updated_at: nowIso() });
    return this.getVoice(id);
  }

  lockVoice(id: string): VoiceProfile {
    const v = this.getVoice(id);
    const now = nowIso();
    this.db.update('voice_profiles', id, {
      locked: 1,
      locked_at: now,
      lock_snapshot_json: JSON.stringify({
        fields: Object.fromEntries(VOICE_LOCK_FIELDS.map((f) => [f, v[f]])),
        lockedAt: now,
      }),
      updated_at: now,
    });
    return this.getVoice(id);
  }

  unlockVoice(id: string, reason: string): VoiceProfile {
    if (!reason.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required to unlock a voice');
    this.getVoice(id);
    this.db.update('voice_profiles', id, { locked: 0, updated_at: nowIso() });
    return this.getVoice(id);
  }

  deleteVoice(id: string): void {
    const v = this.getVoice(id);
    if (v.locked) throw new AppError('LOCKED', 'Locked voices cannot be deleted; unlock first.');
    this.db.run('DELETE FROM voice_profiles WHERE id = ?', id);
  }

  // --- Locations ----------------------------------------------------------------

  listLocations(projectId: string): Location[] {
    return this.db.all<Location>('SELECT * FROM locations WHERE project_id = ? ORDER BY name', projectId);
  }

  getLocation(id: string): Location {
    return requireRow<Location>(this.db, 'locations', id, 'Location');
  }

  createLocation(projectId: string, input: unknown): Location {
    const v = parseOrThrow(locationInput, input, 'location');
    const id = newId('loc');
    const now = nowIso();
    this.db.insert('locations', { id, project_id: projectId, ...v, created_at: now, updated_at: now });
    return this.getLocation(id);
  }

  updateLocation(id: string, patch: Record<string, unknown>): Location {
    const current = this.getLocation(id);
    const v = parseOrThrow(locationInput, pickKnown(locationInput, { ...current, ...patch }), 'location');
    assertLockedFieldsUnchanged(
      'Location',
      current as unknown as Record<string, unknown>,
      v,
      LOCATION_LOCK_FIELDS,
    );
    this.db.update('locations', id, { ...v, updated_at: nowIso() });
    return this.getLocation(id);
  }

  lockLocation(id: string): Location {
    const l = this.getLocation(id);
    const refs = this.db.all<{ id: string }>(
      "SELECT id FROM reference_assets WHERE owner_type = 'location' AND owner_id = ? AND approved = 1",
      id,
    );
    const now = nowIso();
    this.db.update('locations', id, {
      locked: 1,
      locked_at: now,
      lock_snapshot_json: JSON.stringify({
        fields: Object.fromEntries(LOCATION_LOCK_FIELDS.map((f) => [f, l[f]])),
        referenceIds: refs.map((r) => r.id),
        lockedAt: now,
      }),
      updated_at: now,
    });
    return this.getLocation(id);
  }

  unlockLocation(id: string, reason: string): Location {
    if (!reason.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required to unlock a location');
    this.getLocation(id);
    this.db.update('locations', id, { locked: 0, updated_at: nowIso() });
    return this.getLocation(id);
  }

  deleteLocation(id: string): void {
    this.getLocation(id);
    this.db.run('DELETE FROM locations WHERE id = ?', id);
  }

  // --- Props --------------------------------------------------------------------

  listProps(projectId: string): Prop[] {
    return this.db.all<Prop>('SELECT * FROM props WHERE project_id = ? ORDER BY name', projectId);
  }

  getProp(id: string): Prop {
    return requireRow<Prop>(this.db, 'props', id, 'Prop');
  }

  createProp(projectId: string, input: unknown, characterIds: string[] = []): Prop {
    const v = parseOrThrow(propInput, input, 'prop');
    const id = newId('prp');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.insert('props', { id, project_id: projectId, ...v, created_at: now, updated_at: now });
      for (const cid of characterIds) this.db.insert('prop_characters', { prop_id: id, character_id: cid });
    });
    return this.getProp(id);
  }

  updateProp(id: string, patch: Record<string, unknown>): Prop {
    const current = this.getProp(id);
    const v = parseOrThrow(propInput, pickKnown(propInput, { ...current, ...patch }), 'prop');
    assertLockedFieldsUnchanged('Prop', current as unknown as Record<string, unknown>, v, PROP_LOCK_FIELDS);
    this.db.update('props', id, { ...v, updated_at: nowIso() });
    return this.getProp(id);
  }

  lockProp(id: string): Prop {
    const p = this.getProp(id);
    const now = nowIso();
    this.db.update('props', id, {
      locked: 1,
      locked_at: now,
      lock_snapshot_json: JSON.stringify({
        fields: Object.fromEntries(PROP_LOCK_FIELDS.map((f) => [f, p[f]])),
        lockedAt: now,
      }),
      updated_at: now,
    });
    return this.getProp(id);
  }

  unlockProp(id: string, reason: string): Prop {
    if (!reason.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required to unlock a prop');
    this.getProp(id);
    this.db.update('props', id, { locked: 0, updated_at: nowIso() });
    return this.getProp(id);
  }

  propCharacters(propId: string): string[] {
    return this.db
      .all<{ character_id: string }>('SELECT character_id FROM prop_characters WHERE prop_id = ?', propId)
      .map((r) => r.character_id);
  }

  deleteProp(id: string): void {
    this.getProp(id);
    this.db.run('DELETE FROM props WHERE id = ?', id);
  }
}
