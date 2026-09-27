import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { mergeNegatives } from '../src/services/prompt-builder.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

describe('Character / Location / Prop / Voice Lock', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('Character Lock freezes canonical fields but allows name-level edits and variants', async () => {
    const { ari } = seedSmall(s);
    s.generation.queueReference({ type: 'character', id: ari.id }, { slot_type: 'view', slot: 'front' });
    await s.generation.processQueue();
    const ref = s.characters.listReferences(ari.id)[0]!;
    s.characters.setReferenceApproval(ref.id, true);
    s.characters.lock(ari.id);
    assert.throws(
      () => s.characters.update(ari.id, { clothing: 'red cape' }),
      (e: AppError) => e.code === 'LOCKED' && e.message.includes('clothing'),
    );
    assert.throws(
      () => s.characters.update(ari.id, { prompt: 'different fox' }),
      (e: AppError) => e.code === 'LOCKED',
    );
    assert.equal(s.characters.update(ari.id, { personality: 'brave' }).personality, 'brave');
    // Variants are allowed without touching canonical identity.
    const winter = s.characters.createVariant(ari.id, {
      name: 'Winter clothes',
      clothing_override: 'wool coat',
    });
    assert.equal(winter.character_id, ari.id);
    // Canonical references are frozen; variant references are not.
    assert.throws(
      () => s.characters.setReferenceApproval(ref.id, false),
      (e: AppError) => e.code === 'LOCKED',
    );
    const snap = s.characters.lockSnapshot(s.characters.get(ari.id))!;
    assert.deepEqual(snap.referenceIds, [ref.reference_asset_id]);
    assert.equal(snap.fields['prompt'], 'orange fox with blue scarf');
    // Unlock needs a reason.
    assert.throws(
      () => s.characters.unlock(ari.id, '  '),
      (e: AppError) => e.code === 'VALIDATION_FAILED',
    );
    s.characters.unlock(ari.id, 'redesign approved by director');
    assert.equal(s.characters.update(ari.id, { clothing: 'red cape' }).clothing, 'red cape');
  });

  it('variant references attach to the variant even when the character is locked', async () => {
    const { ari } = seedSmall(s);
    s.characters.lock(ari.id);
    const v = s.characters.createVariant(ari.id, { name: 'Wet version', prompt_additions: 'soaked fur' });
    s.generation.queueReference(
      { type: 'character', id: ari.id },
      { slot_type: 'view', slot: 'front', variant_id: v.id },
    );
    await s.generation.processQueue();
    const refs = s.characters.listReferences(ari.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.variant_id, v.id);
  });

  it('Location Lock and Prop Lock freeze descriptive fields', () => {
    const { project, loc } = seedSmall(s);
    s.characters.lockLocation(loc.id);
    assert.throws(
      () => s.characters.updateLocation(loc.id, { weather: 'storm' }),
      (e: AppError) => e.code === 'LOCKED',
    );
    const prop = s.characters.createProp(project.id, { name: 'Compass', colors: 'brass' });
    s.characters.lockProp(prop.id);
    assert.throws(
      () => s.characters.updateProp(prop.id, { colors: 'silver' }),
      (e: AppError) => e.code === 'LOCKED',
    );
    s.characters.unlockProp(prop.id, 'colour change');
    assert.equal(s.characters.updateProp(prop.id, { colors: 'silver' }).colors, 'silver');
  });

  it('Voice Lock freezes identity; emotions change delivery only', () => {
    const { ari } = seedSmall(s);
    const voiceId = ari.voice_profile_id!;
    s.characters.lockVoice(voiceId);
    assert.throws(
      () => s.characters.updateVoice(voiceId, { pitch: -5 }),
      (e: AppError) => e.code === 'LOCKED',
    );
    assert.throws(
      () => s.characters.deleteVoice(voiceId),
      (e: AppError) => e.code === 'LOCKED',
    );
    assert.equal(s.characters.updateVoice(voiceId, { name: 'Ari (main)' }).name, 'Ari (main)');
    const vs = s.audio.voiceSettings(s.characters.getVoice(voiceId));
    assert.equal(vs.pitch, 3);
  });
});

describe('Prompt Builder', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('combines style, character, variant, location, scene, action, camera and negatives', () => {
    const { project, ari, shots } = seedSmall(s);
    const style = s.projects.listStyles().find((x) => x.name === 'Storybook')!;
    s.projects.update(project.id, { default_style_id: style.id });
    const v = s.characters.createVariant(ari.id, {
      name: 'Pilot',
      clothing_override: 'leather flying jacket',
      negative_additions: 'sunglasses',
    });
    s.stories.setShotCharacters(shots[0]!.id, [{ character_id: ari.id, variant_id: v.id }]);
    s.stories.updateShot(shots[0]!.id, {
      framing: 'close-up',
      camera_angle: 'low',
      camera_movement: 'dolly in',
      emotion: 'excited',
    });
    const p = s.generation.promptFor(shots[0]!.id);
    const img = p.final.image;
    for (const part of [
      'illustrated storybook',
      'Ari (fox)',
      'leather flying jacket',
      'floating harbour',
      'Ari arrives at the dock',
      'Ari walks onto the dock',
      'close-up',
      'low angle',
    ]) {
      assert.ok(img.includes(part), `missing "${part}" in ${img}`);
    }
    assert.ok(!img.includes('blue scarf wearing'), 'variant clothing replaces canonical clothing');
    assert.ok(p.final.motion.includes('dolly in'));
    for (const neg of ['realistic', 'extra tails', 'sunglasses', 'city'])
      assert.ok(p.final.negative.includes(neg), neg);
    assert.deepEqual(p.sections.map((x) => x.label).slice(0, 3), ['Style', 'Character (Pilot)', 'Location']);
  });

  it('uses the lock snapshot for locked characters', () => {
    const { ari, shots } = seedSmall(s);
    s.characters.lock(ari.id);
    // Simulate drift in the live row (e.g. direct DB edit) — the builder must use the snapshot.
    s.db.run("UPDATE characters SET prompt = 'purple dragon' WHERE id = ?", ari.id);
    const img = s.generation.promptFor(shots[0]!.id).final.image;
    assert.ok(img.includes('orange fox with blue scarf'));
    assert.ok(!img.includes('purple dragon'));
  });

  it('never overwrites a manually locked prompt', () => {
    const { shots } = seedSmall(s);
    const id = shots[0]!.id;
    s.stories.updateShot(id, { image_prompt: 'my hand-written prompt', image_prompt_locked: true });
    assert.throws(
      () => s.stories.applyBuiltPrompt(id, 'image_prompt', 'auto text'),
      (e: AppError) => e.code === 'LOCKED',
    );
    const p = s.generation.promptFor(id);
    assert.equal(p.final.image, 'my hand-written prompt');
    assert.ok(p.built.image.length > 0 && p.built.image !== p.final.image);
    assert.equal(p.manual.image, true);
    // Unlocked: the builder may write it.
    s.stories.updateShot(id, { image_prompt_locked: false });
    assert.equal(s.stories.applyBuiltPrompt(id, 'image_prompt', 'auto text').image_prompt, 'auto text');
  });

  it('merges negative prompts without duplicates', () => {
    assert.equal(mergeNegatives('blurry, text', 'Text, watermark', '', null), 'blurry, text, watermark');
  });
});
