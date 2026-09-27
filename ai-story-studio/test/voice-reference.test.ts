import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { encodeWav } from '../src/media/wav.ts';
import { createMockProviders } from '../src/providers/registry.ts';
import type { TtsRequest } from '../src/providers/types.ts';
import { exportProject, importProject } from '../src/services/backup.ts';
import { LocalStorageProvider } from '../src/storage/storage.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

const tone = (seconds: number) =>
  encodeWav({
    sampleRate: 16000,
    samples: Float32Array.from(
      { length: seconds * 16000 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000),
    ),
  });

const consent = {
  speaker_name: 'Asha',
  relationship: 'consenting_person',
  method: 'written',
  scope: 'Animated stories on my channel',
  evidence: 'Signed form, consents/asha-2026-09.pdf',
  confirm: 'true',
};

describe('Voice reference with recorded consent', () => {
  let s: TestStudio;
  const seen: TtsRequest[] = [];
  beforeEach(() => {
    seen.length = 0;
    // Spy on the TTS provider to see exactly what reaches the model.
    s = testStudio({
      providers: (() => {
        const p = createMockProviders(new LocalStorageProvider('/tmp/unused-ais'), 0);
        const tts = p.tts;
        p.tts = {
          info: tts.info,
          synthesize: (req, ctx) => {
            seen.push(req);
            return tts.synthesize(req, ctx);
          },
        };
        return p;
      })(),
    });
  });
  afterEach(() => s.cleanup());

  it('refuses a reference without consent, evidence or a valid recording', async () => {
    const { ari } = seedSmall(s);
    const voice = ari.voice_profile_id!;
    const reject = async (wav: Buffer, input: Record<string, unknown>, pattern: RegExp) =>
      assert.rejects(s.voiceRefs.attach(voice, wav, input), (e: AppError) => pattern.test(e.message));
    await reject(tone(5), { ...consent, confirm: 'false' }, /consent/);
    await reject(tone(5), { ...consent, evidence: '' }, /evidence/);
    await reject(tone(5), { ...consent, relationship: 'self' }, /method 'self'/);
    await reject(tone(5), { ...consent, method: 'self' }, /how the speaker consented/);
    await reject(Buffer.from('not audio'), consent, /WAV/);
    await reject(tone(1), consent, /3–60 s/);
    s.characters.lockVoice(voice);
    await assert.rejects(s.voiceRefs.attach(voice, tone(5), consent), (e: AppError) => e.code === 'LOCKED');
    assert.equal(s.voiceRefs.list(voice).length, 0);
  });

  it('sends the recording to TTS only while consent is active, and revoking detaches derived lines', async () => {
    const { ari, story } = seedSmall(s);
    const voiceId = ari.voice_profile_id!;
    const line = s.stories
      .listStoryShots(story.id)
      .flatMap((sh) => s.stories.listDialogue(sh.id))
      .find((d) => d.character_id === ari.id)!;

    await s.audio.dialogue(line, { attemptKey: 'a' });
    assert.equal(seen.at(-1)!.voice.referenceAudio === undefined, true);
    const plainAudio = s.stories.getDialogue(line.id).audio_asset_id!;

    const c = await s.voiceRefs.attach(voiceId, tone(5), consent);
    const voice = s.characters.getVoice(voiceId);
    assert.equal(voice.reference_asset_id, c.reference_asset_id);
    assert.equal(s.voiceRefs.active(voice)?.id, c.id);

    const cloned = await s.audio.dialogue(s.stories.getDialogue(line.id), { attemptKey: 'b' });
    assert.equal(cloned.reused, false, 'a new reference changes the voice cache key');
    assert.equal(seen.at(-1)!.voice.referenceAudio !== undefined, true, 'reference sent to the model');
    assert.equal(cloned.audio.voice_consent_id, c.id);
    assert.notEqual(cloned.audio.id, plainAudio);

    // Voice Lock freezes the reference too; revocation still overrides it.
    s.characters.lockVoice(voiceId);
    await assert.rejects(s.voiceRefs.revoke(c.id, ''), /reason/);
    const refKey = s.db.get<{ storage_key: string }>(
      'SELECT storage_key FROM reference_assets WHERE id = ?',
      c.reference_asset_id,
    )!.storage_key;
    assert.ok(await s.storage.exists(refKey));
    const r = await s.voiceRefs.revoke(c.id, 'Speaker withdrew consent');
    assert.deepEqual(r, { detachedLines: 1, unlocked: true });
    assert.equal(await s.storage.exists(refKey), false, 'recording deleted');
    const after = s.characters.getVoice(voiceId);
    assert.equal(after.reference_asset_id, null);
    assert.equal(after.locked, 0);
    assert.equal(s.voiceRefs.active(after), undefined);
    assert.equal(s.stories.getDialogue(line.id).audio_asset_id, null, 'line detached for regeneration');
    assert.equal(s.assets.get(cloned.audio.generated_asset_id).approval, 'rejected');
    await assert.rejects(s.voiceRefs.revoke(c.id, 'again'), (e: AppError) => e.code === 'CONFLICT');

    const calls = seen.length;
    const regenerated = await s.audio.dialogue(s.stories.getDialogue(line.id), { attemptKey: 'c' });
    assert.notEqual(regenerated.audio.id, cloned.audio.id, 'revoked audio is never reused');
    assert.equal(regenerated.audio.id, plainAudio, 'the consent-free original is still valid and reused');
    assert.equal(seen.length, calls);
  });

  it('keeps consent records in project backups', async () => {
    const { project, ari } = seedSmall(s);
    await s.voiceRefs.attach(ari.voice_profile_id!, tone(4), {
      ...consent,
      relationship: 'self',
      method: 'self',
      evidence: '',
    });
    const pkg = await exportProject(s, project.id, { includeMedia: true });
    const restored = await importProject(s, pkg);
    const voices = s.characters.listVoices(restored.projectId);
    const withRef = voices.find((v) => v.reference_asset_id);
    assert.ok(withRef, 'restored voice keeps its reference');
    const active = s.voiceRefs.active(withRef);
    assert.equal(active?.speaker_name, 'Asha');
    assert.equal(active?.relationship, 'self');
  });
});
