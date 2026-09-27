import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError, type MusicProvider, type SoundEffectProvider } from '../src/providers/types.ts';
import { produceShots, seedSmall, testStudio } from './helpers.ts';

/**
 * Music, ambience and optional SFX are optional: when they cannot be generated, BUILD FINAL still
 * produces the episode (without them) and says so. Speech and REQUIRED sound effects still block.
 */
describe('optional tracks do not block BUILD FINAL', () => {
  it('failed music and ambience are left out with a warning; the export completes', async () => {
    const s = testStudio();
    try {
      const { story } = seedSmall(s);
      await produceShots(s, story.id);
      const failingMusic: MusicProvider = {
        info: { ...s.providers.music.info, id: 'broken-music' },
        compose: async () => {
          throw new ProviderError('MUSIC_FAILED', 'music model crashed');
        },
      };
      const realSfx = s.providers.sfx;
      const failingBeds: SoundEffectProvider = {
        info: realSfx.info,
        create: async (req, ctx) => {
          if (req.loopable) throw new ProviderError('SFX_FAILED', 'ambience model crashed');
          return realSfx.create(req, ctx);
        },
      };
      s.providers.music = failingMusic;
      s.providers.sfx = failingBeds;
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'complete', exp.error_message ?? '');
      const steps = JSON.parse(exp.steps_json) as Array<{ step: string; status: string; detail: string }>;
      const beds = steps.find((x) => x.step === 'generate_music_sfx_ambience')!;
      assert.equal(beds.status, 'warn');
      assert.match(beds.detail, /optional track\(s\) could not be generated and are left out/);
      assert.match(beds.detail, /music \(music model crashed\)/);
      assert.match(beds.detail, /ambience \(ambience model crashed\)/);
    } finally {
      s.cleanup();
    }
  });

  it('a REQUIRED sound effect that fails still stops the build with a clear reason', async () => {
    const s = testStudio();
    try {
      const { story, shots } = seedSmall(s); // seedSmall adds a required "footsteps" cue
      for (const cue of s.stories.listShotSfx(shots[0]!.id)) s.stories.setShotSfxApproval(cue.id, true);
      await produceShots(s, story.id);
      s.providers.sfx = {
        info: s.providers.sfx.info,
        create: async () => {
          throw new ProviderError('SFX_FAILED', 'sfx model crashed');
        },
      };
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'failed');
      assert.match(exp.error_message ?? '', /Some audio could not be generated/);
      const steps = JSON.parse(exp.steps_json) as Array<{ step: string; status: string }>;
      assert.equal(steps.find((x) => x.step === 'generate_music_sfx_ambience')!.status, 'failed');
    } finally {
      s.cleanup();
    }
  });
});
