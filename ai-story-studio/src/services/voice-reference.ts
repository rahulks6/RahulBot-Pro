import type { StudioCore } from '../app/studio.ts';
import type { VoiceConsent, VoiceProfile } from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { boolean, enumOf, object, optional, parseOrThrow, string } from '../lib/schema.ts';
import { decodeWav } from '../media/wav.ts';

export const CONSENT_RELATIONSHIPS = ['self', 'consenting_person'] as const;
export const CONSENT_METHODS = ['self', 'written', 'recorded_statement', 'contract'] as const;

const consentInput = object({
  speaker_name: string({ min: 1, max: 200 }),
  relationship: enumOf(CONSENT_RELATIONSHIPS),
  method: enumOf(CONSENT_METHODS),
  scope: optional(string({ max: 500 }), ''),
  evidence: optional(string({ max: 500 }), ''),
  confirm: optional(boolean(), false),
});

export const REFERENCE_MIN_SEC = 3;
export const REFERENCE_MAX_SEC = 60;
export const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Voice cloning from a reference recording (spec §26 Voice Lock, §57 ethics).
 *
 * A reference can only be attached together with a consent record: who the
 * speaker is, how they agreed (or that it is the owner's own voice), what the
 * voice may be used for and where the evidence is kept. The recording is sent
 * to the TTS model only while that consent is active. Revoking consent deletes
 * the recording, unlocks a voice whose lock depended on it, and detaches (and
 * rejects) every line synthesised from it so the next build regenerates them.
 */
export class VoiceReferenceService {
  private readonly s: StudioCore;

  constructor(core: StudioCore) {
    this.s = core;
  }

  /** Reference id in effect: the frozen one for a locked voice. */
  private effectiveReferenceId(v: VoiceProfile): string | null {
    if (!v.locked) return v.reference_asset_id;
    const snap = parseJson<{ fields?: Partial<VoiceProfile> } | undefined>(v.lock_snapshot_json, undefined);
    return snap?.fields && 'reference_asset_id' in snap.fields
      ? (snap.fields.reference_asset_id ?? null)
      : v.reference_asset_id;
  }

  /** The active consent covering this voice's reference recording, if any. */
  active(v: VoiceProfile): VoiceConsent | undefined {
    const ref = this.effectiveReferenceId(v);
    if (!ref) return undefined;
    return this.s.db.get<VoiceConsent>(
      `SELECT * FROM voice_consents WHERE voice_profile_id = ? AND reference_asset_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      v.id,
      ref,
    );
  }

  list(voiceId: string): VoiceConsent[] {
    return this.s.db.all<VoiceConsent>(
      'SELECT * FROM voice_consents WHERE voice_profile_id = ? ORDER BY created_at DESC',
      voiceId,
    );
  }

  get(id: string): VoiceConsent {
    const c = this.s.db.get<VoiceConsent>('SELECT * FROM voice_consents WHERE id = ?', id);
    if (!c) throw new AppError('NOT_FOUND', 'Consent record not found');
    return c;
  }

  /** Reference recording bytes for synthesis, only while consent is active. */
  async referenceAudio(v: VoiceProfile): Promise<{ data: Uint8Array; consent: VoiceConsent } | undefined> {
    const consent = this.active(v);
    if (!consent) return undefined;
    const ref = this.s.db.get<{ storage_key: string }>(
      'SELECT storage_key FROM reference_assets WHERE id = ?',
      consent.reference_asset_id,
    );
    if (!ref || !(await this.s.storage.exists(ref.storage_key))) return undefined;
    return { data: await this.s.storage.get(ref.storage_key), consent };
  }

  async attach(voiceId: string, wav: Uint8Array, input: unknown): Promise<VoiceConsent> {
    const voice = this.s.characters.getVoice(voiceId);
    if (voice.locked)
      throw new AppError(
        'LOCKED',
        'This voice is locked; unlock it (with a reason) to change its reference recording.',
      );
    const c = parseOrThrow(consentInput, input, 'voice consent');
    if (!c.confirm)
      throw new AppError(
        'VALIDATION_FAILED',
        "Voice cloning needs the speaker's consent: confirm that you have it (or that this is your own voice).",
      );
    if (c.relationship === 'self' && c.method !== 'self')
      throw new AppError('VALIDATION_FAILED', "For your own voice, choose the consent method 'self'.");
    if (c.relationship === 'consenting_person') {
      if (c.method === 'self')
        throw new AppError(
          'VALIDATION_FAILED',
          'Choose how the speaker consented (written, recorded statement or contract).',
        );
      if (!c.evidence.trim())
        throw new AppError(
          'VALIDATION_FAILED',
          'Record where the consent evidence is kept (e.g. "signed form in Drive/consents").',
        );
    }
    if (wav.byteLength > REFERENCE_MAX_BYTES)
      throw new AppError('VALIDATION_FAILED', 'Reference recording is larger than 10 MB');
    let seconds: number;
    try {
      const pcm = decodeWav(wav);
      seconds = pcm.samples.length / pcm.sampleRate;
    } catch {
      throw new AppError('VALIDATION_FAILED', 'The reference recording must be a WAV file');
    }
    if (seconds < REFERENCE_MIN_SEC || seconds > REFERENCE_MAX_SEC)
      throw new AppError(
        'VALIDATION_FAILED',
        `The reference recording must be ${REFERENCE_MIN_SEC}–${REFERENCE_MAX_SEC} s long (got ${seconds.toFixed(1)} s).`,
      );
    const ref = await this.s.assets.createReference(
      voice.project_id,
      'voice',
      voice.id,
      wav,
      'wav',
      'audio/wav',
      `Voice reference: ${c.speaker_name}`,
      false,
    );
    const id = newId('vcn');
    this.s.db.transaction(() => {
      this.s.db.run('UPDATE reference_assets SET approved = 1 WHERE id = ?', ref.id);
      this.s.db.insert('voice_consents', {
        id,
        project_id: voice.project_id,
        voice_profile_id: voice.id,
        reference_asset_id: ref.id,
        speaker_name: c.speaker_name,
        relationship: c.relationship,
        method: c.method,
        scope: c.scope,
        evidence: c.evidence,
        created_at: this.s.clock.now().toISOString(),
      });
      this.s.db.run(
        'UPDATE voice_profiles SET reference_asset_id = ?, updated_at = ? WHERE id = ?',
        ref.id,
        this.s.clock.now().toISOString(),
        voice.id,
      );
    });
    this.s.logger.info('voice reference attached with consent', {
      voice: voice.id,
      consent: id,
      method: c.method,
    });
    return this.get(id);
  }

  /** Revoke consent. Always allowed, including for locked voices. */
  async revoke(consentId: string, reason: string): Promise<{ detachedLines: number; unlocked: boolean }> {
    if (!reason.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required to revoke consent');
    const consent = this.get(consentId);
    if (consent.revoked_at) throw new AppError('CONFLICT', 'Consent was already revoked');
    const voice = this.s.characters.getVoice(consent.voice_profile_id);
    const now = this.s.clock.now().toISOString();
    const lockedOnIt =
      Boolean(voice.locked) && this.effectiveReferenceId(voice) === consent.reference_asset_id;
    const ref = this.s.db.get<{ storage_key: string }>(
      'SELECT storage_key FROM reference_assets WHERE id = ?',
      consent.reference_asset_id,
    );
    let detached = 0;
    this.s.db.transaction(() => {
      this.s.db.run(
        'UPDATE voice_consents SET revoked_at = ?, revoke_reason = ? WHERE id = ?',
        now,
        reason.slice(0, 500),
        consent.id,
      );
      if (voice.reference_asset_id === consent.reference_asset_id || lockedOnIt) {
        this.s.db.run(
          `UPDATE voice_profiles SET reference_asset_id = NULL, locked = ?, updated_at = ? WHERE id = ?`,
          lockedOnIt ? 0 : voice.locked,
          now,
          voice.id,
        );
      }
      const audio = `SELECT id FROM audio_assets WHERE voice_consent_id = ?`;
      detached += this.s.db.run(
        `UPDATE dialogue_lines SET audio_asset_id = NULL WHERE audio_asset_id IN (${audio})`,
        consent.id,
      ).changes;
      detached += this.s.db.run(
        `UPDATE narration_lines SET audio_asset_id = NULL WHERE audio_asset_id IN (${audio})`,
        consent.id,
      ).changes;
      this.s.db.run(
        `UPDATE generated_assets SET approval = 'rejected' WHERE id IN (SELECT generated_asset_id FROM audio_assets WHERE voice_consent_id = ?)`,
        consent.id,
      );
      // Cached audio must never be reused for this voice again.
      this.s.db.run(
        `UPDATE audio_assets SET cache_key = 'revoked:' || id WHERE voice_consent_id = ?`,
        consent.id,
      );
    });
    if (ref) await this.s.storage.delete(ref.storage_key);
    this.s.logger.warn('voice consent revoked', {
      voice: voice.id,
      consent: consent.id,
      lines: detached,
      unlocked: lockedOnIt,
    });
    return { detachedLines: detached, unlocked: lockedOnIt };
  }
}
