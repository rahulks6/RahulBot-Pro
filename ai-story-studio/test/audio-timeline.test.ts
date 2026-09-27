import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TimelineItem } from '../src/domain/types.ts';
import { readPngInfo } from '../src/media/png.ts';
import { decodeWav, levels } from '../src/media/wav.ts';
import {
  MockSoundEffectProvider,
  MockTextToSpeechProvider,
  makeLoopable,
} from '../src/providers/mock/audio.ts';
import { MockImageModel } from '../src/providers/mock/image.ts';
import { DEFAULT_SETTINGS } from '../src/services/settings.ts';
import { duckingEnvelope, mixTimeline } from '../src/services/mixer.ts';
import { produceShots, seedSmall, testStudio, type TestStudio } from './helpers.ts';

const voice = {
  voiceModel: 'mock-tts',
  voiceIdentity: 'v1',
  presentation: 'female' as const,
  pitch: 0,
  speed: 1,
  speakingStyle: '',
};

describe('mock providers', () => {
  it('image model writes a real PNG at the mode-dependent resolution', async () => {
    const res = await new MockImageModel().generate(
      {
        mode: 'text_to_image',
        prompt: 'x',
        negativePrompt: '',
        seed: 1,
        width: 1920,
        height: 1080,
        quality: 'fast_preview',
        references: [],
        settings: {},
      },
      { attemptKey: 'k' },
    );
    assert.deepEqual(readPngInfo(res.file.data), { width: 480, height: 270 });
    assert.equal(res.isNativeResolution, false);
  });

  it('TTS is deterministic for a voice; emotion changes delivery, not identity', async () => {
    const tts = new MockTextToSpeechProvider();
    const req = { text: 'Hello there my friend', language: 'en', emotion: 'neutral', speed: 1, voice };
    const a = await tts.synthesize(req, { attemptKey: 'a' });
    const b = await tts.synthesize(req, { attemptKey: 'b' });
    assert.deepEqual(Buffer.from(a.file.data), Buffer.from(b.file.data));
    const whisper = await tts.synthesize({ ...req, emotion: 'whispering' }, { attemptKey: 'c' });
    assert.ok(levels(decodeWav(whisper.file.data).samples).rms < levels(decodeWav(a.file.data).samples).rms);
    assert.equal(a.settings['baseHz'], whisper.settings['baseHz'], 'whispering keeps the same base voice');
    const slow = await tts.synthesize({ ...req, speed: 0.6 }, { attemptKey: 'd' });
    assert.ok((slow.file.durationSec ?? 0) > (a.file.durationSec ?? 0));
  });

  it('ambience loops cleanly (end flows into start)', async () => {
    const res = await new MockSoundEffectProvider().create(
      { tag: 'rain', durationSec: 4, loopable: true, description: '' },
      { attemptKey: 'x' },
    );
    const pcm = decodeWav(res.file.data);
    assert.ok(Math.abs(pcm.samples.length / pcm.sampleRate - 4) < 0.05);
    const loop = makeLoopable(Float32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), 4 / 22050);
    assert.equal(loop.length, 4);
    assert.equal(loop[0], 1, 'head starts from the tail value');
  });
});

describe('audio pipeline, timeline and mix', () => {
  let s: TestStudio;
  beforeEach(() => {
    s = testStudio();
  });
  afterEach(() => s.cleanup());

  it('reuses identical audio instead of regenerating it', async () => {
    const { shots } = seedSmall(s);
    const line = s.stories.listDialogue(shots[0]!.id)[0]!;
    const first = await s.audio.dialogue(line, { attemptKey: '1' });
    assert.equal(first.reused, false);
    const again = await s.audio.dialogue(s.stories.getDialogue(line.id), { attemptKey: '2' });
    assert.equal(again.reused, true);
    assert.equal(again.audio.id, first.audio.id);
    // Changing the emotion produces new audio; the video is untouched.
    const changed = s.stories.updateDialogue(line.id, { emotion: 'sad' });
    assert.equal(changed.audio_asset_id, null);
    assert.equal((await s.audio.dialogue(changed, { attemptKey: '3' })).reused, false);
  });

  it('places speech sequentially without overlaps and preserves manual edits on rebuild', async () => {
    const { story } = seedSmall(s);
    const v = s.timeline.build(story.id);
    const speech = v.items
      .filter((i) => i.track === 'dialogue' || i.track === 'narration')
      .sort((a, b) => a.start_sec - b.start_sec);
    for (let i = 1; i < speech.length; i++)
      assert.ok(speech[i]!.start_sec >= speech[i - 1]!.start_sec + speech[i - 1]!.duration_sec - 1e-6);
    const video = v.items.filter((i) => i.track === 'video');
    assert.equal(video.length, 3);
    assert.equal(video[0]!.start_sec, 0);
    assert.equal(video[1]!.start_sec, video[0]!.duration_sec);
    assert.ok(
      v.items.some((i) => i.track === 'music') && v.items.some((i) => i.track === 'ambience' && i.loop === 1),
    );
    // Manual edit survives an automatic rebuild.
    const music = v.items.find((i) => i.track === 'music')!;
    s.timelines.updateItem(music.id, { volume_db: -6 });
    const rebuilt = s.timeline.build(story.id);
    const kept = rebuilt.items.filter((i) => i.track === 'music' && i.source_id === music.source_id);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.volume_db, -6);
    assert.equal(kept[0]!.manual, 1);
  });

  it('extends a shot (holds the last frame) when its speech is longer than the clip', () => {
    const { story, shots } = seedSmall(s);
    s.stories.updateShot(shots[1]!.id, { duration_sec: 1 });
    const v = s.timeline.build(story.id);
    assert.ok(v.warnings.some((w) => w.includes('held')));
    const item = v.items.find((i) => i.track === 'video' && i.source_id === shots[1]!.id)!;
    assert.ok(item.duration_sec > 1);
  });

  it('ducks music under speech and restores it afterwards', () => {
    const env = duckingEnvelope(22050 * 4, 22050, [[1, 2]], -12, 0.1, 0.5);
    assert.equal(env[Math.round(0.5 * 22050)], 1);
    assert.ok(Math.abs((env[Math.round(1.5 * 22050)] ?? 0) - 0.251) < 0.01);
    assert.equal(env[Math.round(3 * 22050)], 1);
  });

  it('mixes layers with ducking, fades, looping and peak protection', () => {
    const sr = 22050;
    const tone = (sec: number, amp: number) => ({
      sampleRate: sr,
      samples: Float32Array.from({ length: sr * sec }, (_, i) => amp * Math.sin(i / 5)),
    });
    const item = (
      id: string,
      track: TimelineItem['track'],
      start: number,
      dur: number,
      extra: Partial<TimelineItem> = {},
    ): TimelineItem => ({
      id,
      timeline_id: 't',
      track,
      position: 0,
      asset_id: id,
      source_type: '',
      source_id: id,
      label: id,
      start_sec: start,
      duration_sec: dur,
      trim_in_sec: 0,
      volume_db: 0,
      fade_in_sec: 0,
      fade_out_sec: 0,
      transition: 'cut',
      loop: 0,
      manual: 0,
      created_at: '',
      updated_at: '',
      ...extra,
    });
    const audio = new Map([
      ['speech', tone(1, 0.9)],
      ['music', tone(1, 0.9)],
    ]);
    const items = [item('speech', 'dialogue', 1, 1), item('music', 'music', 0, 4, { loop: 1 })];
    const ducked = mixTimeline({ items, audio, durationSec: 4, settings: DEFAULT_SETTINGS.audioMix });
    const noDuck = mixTimeline({
      items,
      audio,
      durationSec: 4,
      settings: { ...DEFAULT_SETTINGS.audioMix, duckingEnabled: false },
    });
    assert.ok((ducked.musicOverSpeechDb ?? 0) < (noDuck.musicOverSpeechDb ?? 0) - 6);
    assert.ok(
      ducked.pcm.samples.slice(3 * sr).some((x) => Math.abs(x) > 0.01),
      'music loops to fill the item',
    );
    assert.ok(levels(ducked.pcm.samples).peakDb <= DEFAULT_SETTINGS.audioMix.peakCeilingDb + 0.01);
    assert.equal(ducked.clippedSamples, 0);
    const solo = mixTimeline({
      items,
      audio,
      durationSec: 4,
      settings: DEFAULT_SETTINGS.audioMix,
      layers: ['music'],
    });
    assert.deepEqual(Object.keys(solo.layers), ['music']);
    const missing = mixTimeline({
      items: [item('gone', 'sfx', 0, 1)],
      audio,
      durationSec: 1,
      settings: DEFAULT_SETTINGS.audioMix,
    });
    assert.deepEqual(missing.missingAudioItems, ['gone']);
  });

  it('renders solo and full previews from the story timeline without touching video', async () => {
    const { story } = seedSmall(s);
    await produceShots(s, story.id);
    const assetsBefore = s.db.scalar<number>(
      "SELECT COUNT(*) FROM generated_assets WHERE kind IN ('video','upscaled_video','image')",
    );
    for (const l of s.stories.listStoryShots(story.id).flatMap((sh) => s.stories.listDialogue(sh.id)))
      await s.audio.dialogue(l, { attemptKey: l.id });
    s.timeline.build(story.id);
    const { key, mix } = await s.timeline.writePreview(story.id, ['dialogue']);
    assert.ok(await s.storage.exists(key));
    assert.ok(mix.layers.dialogue);
    assert.equal(
      s.db.scalar<number>(
        "SELECT COUNT(*) FROM generated_assets WHERE kind IN ('video','upscaled_video','image')",
      ),
      assetsBefore,
    );
  });
});
