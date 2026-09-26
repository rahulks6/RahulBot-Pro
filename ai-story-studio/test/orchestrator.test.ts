import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * The Auto Production Orchestrator end to end in DEVELOPER TEST MODE: every AI model is the
 * labelled mock (no GPU), FFmpeg builds a real MP4 from the placeholders. This proves the chain,
 * the stages, the retry rounds and "needs attention" — not the quality of real AI.
 */
const ff = findFfmpeg();

describe(
  'Auto Production Orchestrator (developer test mode)',
  { skip: !ff && 'FFmpeg not installed' },
  () => {
    let s: TestStudio;
    after(() => s?.cleanup());

    it('idea → story → looks → pictures → clips → final video → quality check → READY FOR REVIEW', async () => {
      s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
      const v = s.orchestrator.create({
        idea: 'Milo the fox cub helps a lost baby turtle find its way home to the river.',
        length: 'custom',
        customMinutes: 0.8,
        styleId: '3d_kids',
        makeEpisode: true,
        makeShorts: true,
        shortsCount: 1,
        language: 'en',
        narrator: 'female',
        musicMood: 'auto',
        reviewPlan: false,
      });
      await s.orchestrator.start(v.id);
      const done = s.videos.get(v.id);
      const stages = s.videos.stages(done);
      assert.equal(
        done.status,
        'ready',
        JSON.stringify({ stages, attention: done.attention_json, err: done.error_message }, null, 1),
      );
      assert.ok(
        stages.every((x) => ['done', 'warn'].includes(x.status)),
        JSON.stringify(stages),
      );
      assert.match(stages[0]!.detail, /placeholder script: developer test mode/, 'mock writing is labelled');
      const exp = s.reports.getExport(done.episode_export_id!);
      assert.equal(exp.status, 'complete');
      assert.equal(exp.width, 1920);
      assert.equal(exp.is_mock, 1, 'placeholders are never presented as real AI');
      const shots = s.stories.listStoryShots(done.story_id!);
      assert.ok(
        shots.length >= 3 && shots.every((sh) => sh.approved_image_asset_id && sh.approved_video_asset_id),
      );
      assert.ok(s.gpuRepo.active().length === 0, 'no GPU left running');
      // Captions, Shorts (drawn in 9:16), thumbnails and metadata.
      assert.ok(done.captions_srt_key && done.captions_vtt_key);
      assert.match((await s.storage.get(done.captions_srt_key)).toString(), /^1\n00:00:\d\d,\d{3} --> /);
      const shorts = s.videos.shorts(v.id);
      assert.equal(shorts.length, 1);
      const short = shorts[0]!;
      assert.equal(short.status, 'ready', short.error_message ?? '');
      assert.equal(short.framing, 'native');
      assert.equal(s.stories.get(short.story_id!).format, 'vertical');
      const size = (key: string) =>
        execFileSync(ff!.ffprobe, [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          s.storage.localPath(key),
        ])
          .toString()
          .trim();
      assert.equal(size(short.video_key!), '1080,1920');
      const thumbs = JSON.parse(done.thumbnails_json) as string[];
      assert.ok(thumbs.length >= 1 && done.thumbnail_key === thumbs[0]);
      assert.equal(size(done.thumbnail_key!), '1280,720');
      const meta = JSON.parse(done.metadata_json) as {
        madeForKids: unknown;
        containsSyntheticMedia: boolean;
      };
      assert.equal(meta.madeForKids, null, 'the audience is left for the person to choose');
      assert.equal(meta.containsSyntheticMedia, true);
      assert.match((JSON.parse(short.metadata_json) as { title: string }).title, /#Shorts$/);
    });

    it('a shot that keeps failing: 3 attempts, then "needs attention" with Skip, then CONTINUE finishes', async () => {
      s?.cleanup();
      s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
      const v = s.orchestrator.create({
        idea: 'Nia the owl learns to read the stars with her friend Milo.',
        length: 'custom',
        customMinutes: 0.4,
        styleId: 'storybook',
        makeEpisode: true,
        makeShorts: false,
        shortsCount: 1,
        language: 'hinglish',
        narrator: 'male',
        musicMood: 'calm',
        reviewPlan: true,
      });
      await s.orchestrator.start(v.id);
      assert.equal(s.videos.get(v.id).status, 'plan_review', 'paused for the plan review');
      // Make one shot fail every attempt.
      const shots = s.stories.listStoryShots(s.videos.get(v.id).story_id!);
      const bad = shots[1]!;
      s.stories.updateShot(bad.id, { title: bad.title });
      const orig = s.generation.queueImage.bind(s.generation);
      s.generation.queueImage = (id, opts = {}) =>
        orig(
          id,
          id === bad.id
            ? { ...opts, params: { ...(opts.params ?? {}), mockForceFailure: 'IMAGE_GENERATION_FAILED' } }
            : opts,
        );
      await s.orchestrator.approvePlan(v.id);
      let now = s.videos.get(v.id);
      assert.equal(now.status, 'needs_attention', JSON.stringify(s.videos.stages(now)));
      const items = s.videos.attention(now);
      assert.equal(items.length, 1);
      assert.equal(items[0]!.shot_id, bad.id);
      assert.match(items[0]!.message, /needs attention: .*tried 3 times/);
      const attempts = s.jobs.attemptsForShot(bad.id, 'image');
      assert.ok(attempts.length >= 3, `${attempts.length} attempts`);
      s.orchestrator.skipShot(v.id, bad.id);
      s.generation.queueImage = orig;
      s.videos.setStage(v.id, 'images', 'pending', '');
      await s.orchestrator.start(v.id);
      now = s.videos.get(v.id);
      assert.equal(now.status, 'ready', JSON.stringify(s.videos.stages(now)));
      assert.equal(s.stories.get(now.story_id!).language, 'hi-Latn');
    });

    it('cancel stops the run and leaves nothing running', async () => {
      s?.cleanup();
      s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
      const v = s.orchestrator.create({
        idea: 'A tiny robot learns to paint a rainbow.',
        length: 'short',
        styleId: '2d_cartoon',
        makeEpisode: true,
        makeShorts: false,
        shortsCount: 1,
        language: 'en',
        narrator: 'female',
        musicMood: 'auto',
        reviewPlan: false,
      });
      const run = s.orchestrator.start(v.id);
      s.orchestrator.cancel(v.id);
      await run;
      assert.equal(s.videos.get(v.id).status, 'cancelled');
      assert.equal(s.gpuRepo.active().length, 0);
      assert.equal(s.orchestrator.runningVideoId(), null);
    });

    it('after a restart, an interrupted video waits for CONTINUE', () => {
      const v = s.orchestrator.create({
        idea: 'Two friends build a treehouse together.',
        length: 'short',
        styleId: '3d_kids',
        makeEpisode: true,
        makeShorts: false,
        shortsCount: 1,
        language: 'en',
        narrator: 'female',
        musicMood: 'auto',
        reviewPlan: false,
      });
      s.videos.update(v.id, { status: 'generating' });
      assert.equal(s.orchestrator.recoverAfterRestart(), 1);
      const now = s.videos.get(v.id);
      assert.equal(now.status, 'needs_attention');
      assert.match(s.videos.attention(now)[0]!.message, /press CONTINUE/i);
    });
  },
);
