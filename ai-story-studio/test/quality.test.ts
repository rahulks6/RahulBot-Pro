import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Finding } from '../src/domain/types.ts';
import { validateExport, findPlaceholder } from '../src/services/quality/checks.ts';
import { compareEpisodes, type EpisodeFingerprint } from '../src/services/quality/similarity.ts';
import { containment, sequenceSimilarity, textContainment } from '../src/services/quality/text-similarity.ts';
import { DEFAULT_SETTINGS } from '../src/services/settings.ts';
import type { ProbeResult } from '../src/providers/types.ts';
import { produceShots, seedSmall, testStudio, type TestStudio } from './helpers.ts';

const q = DEFAULT_SETTINGS.quality;
const fp = (over: Partial<EpisodeFingerprint>): EpisodeFingerprint => ({
  storyId: 'sto_a',
  title: 'A',
  label: 'Episode 12',
  storyText: '',
  dialogue: [],
  narration: [],
  prompts: [],
  shotPlan: [],
  sceneStructure: [],
  clipChecksums: [],
  audioChecksums: [],
  ...over,
});

describe('similarity calculations', () => {
  it('measures containment and sequence similarity', () => {
    assert.equal(textContainment('the cat sat on the mat', 'the cat sat on the mat today'), 1);
    assert.equal(textContainment('a b c d', 'w x y z'), 0);
    assert.equal(containment(new Set(), new Set(['a'])), 0);
    assert.equal(sequenceSimilarity(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), 0.75);
  });

  it('produces explainable warnings, never monetisation predictions', () => {
    const shared =
      'the little boat sailed across the silver river while the moon watched quietly from above the hills';
    const { rows, findings } = compareEpisodes(
      fp({
        narration: [shared, 'a brand new ending line with other words entirely here'],
        title: 'Moon River',
      }),
      [fp({ storyId: 'sto_b', label: 'Episode 7', narration: [shared], title: 'moon river' })],
      new Set(),
      q,
    );
    assert.equal(rows.length, 1);
    const msg = findings.find((f) => f.code === 'narration_similarity')!.message;
    assert.match(msg, /^Episode 12 shares \d+% of its narration with Episode 7\.$/);
    assert.ok(findings.some((f) => f.code === 'duplicate_title'));
    assert.ok(findings.some((f) => f.code === 'repeated_line'));
    for (const f of findings) assert.ok(!/demoneti|monetis|will be/i.test(f.message), f.message);
  });

  it('ignores recurring character names and tolerates catchphrases and continuity assets', () => {
    const cur = fp({
      dialogue: ['Pip and Luma go home', 'Onward, friends!'],
      clipChecksums: ['c1', 'c2', 'c3'],
    });
    const prev = fp({
      storyId: 'sto_b',
      label: 'Episode 1',
      dialogue: ['Pip and Luma go home', 'Onward, friends!'],
      clipChecksums: ['zzz'],
    });
    const { findings } = compareEpisodes(cur, [prev], new Set(['pip', 'luma']), q);
    assert.ok(findings.some((f) => f.code === 'catchphrase' && f.severity === 'info'));
    assert.ok(!findings.some((f) => f.code === 'clip_reuse'));
  });

  it('flags excessive identical clip reuse', () => {
    const { findings } = compareEpisodes(
      fp({ clipChecksums: ['a', 'b', 'c'] }),
      [fp({ storyId: 'x', label: 'Episode 2', clipChecksums: ['a', 'b'] })],
      new Set(),
      q,
    );
    assert.ok(findings.some((f) => f.code === 'clip_reuse' && f.message.includes('2 of 3')));
  });
});

describe('export validation', () => {
  const good: ProbeResult = {
    exists: true,
    readable: true,
    decodes: true,
    container: 'mp4',
    durationSec: 30,
    isMock: false,
    notes: [],
    video: { codec: 'h264', width: 1920, height: 1080, fps: 24 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, peakDb: -1, clippedSamples: 0 },
  };
  const exp = {
    width: 1920,
    height: 1080,
    fps: 24,
    durationSec: 30,
    sceneIds: ['s1'],
    scenesWithClips: new Set(['s1']),
  };
  const fails = (fs: Finding[]) =>
    fs
      .filter((f) => f.severity === 'fail')
      .map((f) => f.code)
      .sort();

  it('passes a correct master', () => {
    assert.deepEqual(fails(validateExport(good, exp, [])), []);
  });

  it('fails on every required condition', () => {
    assert.deepEqual(fails(validateExport({ ...good, exists: false }, exp, [])), ['file_missing']);
    const { audio: _a, ...noAudio } = good;
    assert.deepEqual(fails(validateExport(noAudio, exp, [])), ['no_audio_stream']);
    assert.deepEqual(
      fails(
        validateExport({ ...good, video: { codec: 'h264', width: 1280, height: 720, fps: 24 } }, exp, []),
      ),
      ['resolution'],
    );
    assert.deepEqual(
      fails(
        validateExport({ ...good, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 } }, exp, []),
      ),
      ['frame_rate'],
    );
    assert.deepEqual(fails(validateExport({ ...good, durationSec: 20 }, exp, [])), ['duration']);
    assert.deepEqual(fails(validateExport(good, { ...exp, scenesWithClips: new Set() }, [])), [
      'missing_scene',
    ]);
    assert.deepEqual(fails(validateExport({ ...good, decodes: false }, exp, [])), ['decode']);
    assert.deepEqual(
      fails(validateExport({ ...good, audio: { ...good.audio!, clippedSamples: 3 } }, exp, [])),
      ['clipping'],
    );
    assert.deepEqual(
      fails(validateExport(good, exp, [{ code: 'missing_dialogue', severity: 'fail', message: 'x' }])),
      ['missing_dialogue'],
    );
  });

  it('detects placeholder text', () => {
    assert.equal(findPlaceholder('Pip says TODO here'), 'TODO');
    assert.equal(findPlaceholder('Insert name here please'), 'Insert name here');
    assert.equal(findPlaceholder('A normal line of dialogue.'), undefined);
  });
});

describe('quality service and BUILD FINAL', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('story check finds placeholders, missing shots and duplicates', () => {
    const { story, scenes } = seedSmall(s);
    s.stories.createScene(story.id, { title: 'Empty scene' });
    s.stories.addNarration(scenes[0]!.id, { text: 'Ari had always dreamed of flying.' });
    s.stories.update(story.id, { synopsis: 'TBD' });
    const codes = s.quality.storyFindings(story.id).map((f) => `${f.severity}:${f.code}`);
    assert.ok(codes.includes('fail:missing_shot'));
    assert.ok(codes.includes('fail:placeholder'));
    assert.ok(codes.includes('warn:duplicate_line'));
  });

  it('BUILD FINAL refuses unapproved shots and does not mark the export complete', async () => {
    const { story } = seedSmall(s);
    const exp = await s.exports.buildFinal(story.id);
    assert.equal(exp.status, 'failed');
    assert.match(exp.error_message ?? '', /no approved clip/);
  });

  it('BUILD FINAL generates missing audio, lip-syncs visible speakers, mixes and validates', async () => {
    const { story, shots } = seedSmall(s);
    await produceShots(s, story.id);
    const exp = await s.exports.buildFinal(story.id);
    assert.equal(exp.status, 'complete', exp.error_message ?? '');
    const steps = JSON.parse(exp.steps_json) as Array<{ step: string; status: string }>;
    assert.deepEqual(
      steps.map((x) => x.step),
      [
        'validate_story',
        'generate_speech',
        'generate_music_sfx_ambience',
        'lip_sync',
        'arrange_timeline',
        'mix_audio',
        'encode',
        'validate_output',
      ],
    );
    assert.ok(s.stories.getShot(shots[0]!.id).lipsync_video_asset_id, 'mouth visible → lip-synced');
    assert.equal(
      s.stories.getShot(shots[1]!.id).lipsync_video_asset_id,
      null,
      'mouth not visible → no lip sync',
    );
    const lip = s.assets.get(s.stories.getShot(shots[0]!.id).lipsync_video_asset_id!);
    assert.equal(
      lip.source_asset_id,
      s.stories.getShot(shots[0]!.id).approved_video_asset_id,
      'original clip preserved',
    );
    assert.equal(s.reports.getExport(exp.id).width, 1920);
    assert.equal(await s.gpu.liveStudioInstances(), 0);
    // Partial rebuild: a second build reuses all audio.
    const again = await s.exports.buildFinal(story.id);
    const steps2 = JSON.parse(again.steps_json) as Array<{ step: string; status: string }>;
    assert.equal(steps2.find((x) => x.step === 'generate_speech')!.status, 'skipped');
    assert.equal(steps2.find((x) => x.step === 'lip_sync')!.status, 'skipped');
    // Changing one line regenerates only that line (+ its lip sync), never the clips.
    const clipsBefore = s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE kind = 'video'");
    const line = s.stories.listDialogue(shots[1]!.id)[0]!;
    s.stories.updateDialogue(line.id, { text: 'Welcome aboard, brave little fox.' });
    const third = await s.exports.buildFinal(story.id);
    assert.equal(third.status, 'complete');
    assert.match(JSON.parse(third.steps_json)[1].detail, /^1 job/);
    assert.equal(
      s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE kind = 'video'"),
      clipsBefore,
    );
  });

  it('a vertical Shorts export reuses the episode footage at 1080×1920', async () => {
    const { story } = seedSmall(s);
    await produceShots(s, story.id);
    const clipsBefore = s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE kind = 'video'");
    const exp = await s.exports.buildFinal(story.id, 'vertical');
    assert.equal(exp.status, 'complete', exp.error_message ?? '');
    assert.equal(exp.width, 1080);
    assert.equal(exp.height, 1920);
    assert.equal(
      s.db.scalar<number>("SELECT COUNT(*) FROM generation_attempts WHERE kind = 'video'"),
      clipsBefore,
    );
  });

  it('runAll stores story/visual/audio/youtube reports with the disclaimer and review gate', async () => {
    const { story } = seedSmall(s);
    const reports = await s.quality.runAll(story.id);
    assert.deepEqual(reports.map((r) => r.kind).sort(), ['audio', 'story', 'visual', 'youtube']);
    const yt = JSON.parse(reports.find((r) => r.kind === 'youtube')!.findings_json) as Finding[];
    assert.equal(yt[0]!.code, 'disclaimer');
    assert.ok(yt.some((f) => f.code === 'human_review' && f.severity === 'warn'));
    assert.equal(reports.find((r) => r.kind === 'visual')!.status, 'fail', 'missing clips fail');
    for (const item of s.reports.checklist(story.id))
      s.reports.setChecklistItem(story.id, item.item_key, true);
    assert.equal(s.reports.checklistComplete(story.id), true);
  });
});
