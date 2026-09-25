import { DEFAULT_SAMPLE_RATE, encodeWav } from '../../media/wav.ts';
import { prng, seedFrom, sha256 } from '../../lib/hash.ts';
import type {
  LipSyncProvider,
  LipSyncRequest,
  ModelResult,
  MusicProvider,
  MusicRequest,
  RunContext,
  SfxRequest,
  SoundEffectProvider,
  TextToSpeechProvider,
  TtsRequest,
} from '../types.ts';
import { ProviderError } from '../types.ts';
import type { MockVideoManifest } from './image.ts';
import { MOCK_VIDEO_MIME, maybeFail, mockInfo, simulatedSeconds, type MockOptions } from './common.ts';

const SR = DEFAULT_SAMPLE_RATE;
const TWO_PI = Math.PI * 2;

function wavResult(
  samples: Float32Array,
  model: string,
  generationSeconds: number,
  settings: Record<string, unknown>,
  log: string,
): ModelResult {
  const data = encodeWav({ sampleRate: SR, samples });
  return {
    file: { data, mime: 'audio/wav', ext: 'wav', durationSec: samples.length / SR },
    model,
    modelVersion: 'mock-1',
    generationSeconds,
    isNativeResolution: true,
    settings,
    logs: [log],
  };
}

/** Emotion → delivery modifiers. Emotions vary delivery only; voice identity (base pitch/timbre) is untouched. */
const EMOTION_DELIVERY: Record<
  string,
  { pitch: number; rate: number; gain: number; breath: number; vibrato: number }
> = {
  neutral: { pitch: 0, rate: 1, gain: 1, breath: 0, vibrato: 0 },
  happy: { pitch: 2, rate: 1.08, gain: 1.05, breath: 0, vibrato: 0 },
  excited: { pitch: 3, rate: 1.18, gain: 1.15, breath: 0, vibrato: 0.01 },
  sad: { pitch: -2, rate: 0.85, gain: 0.8, breath: 0.05, vibrato: 0 },
  tired: { pitch: -1.5, rate: 0.8, gain: 0.75, breath: 0.08, vibrato: 0 },
  afraid: { pitch: 1.5, rate: 1.12, gain: 0.85, breath: 0.05, vibrato: 0.04 },
  nervous: { pitch: 1, rate: 1.1, gain: 0.85, breath: 0.04, vibrato: 0.03 },
  angry: { pitch: 0.5, rate: 1.05, gain: 1.3, breath: 0, vibrato: 0 },
  whispering: { pitch: 0, rate: 0.95, gain: 0.35, breath: 0.9, vibrato: 0 },
  surprised: { pitch: 3.5, rate: 1.05, gain: 1.1, breath: 0, vibrato: 0 },
  calm: { pitch: -0.5, rate: 0.92, gain: 0.9, breath: 0, vibrato: 0 },
};

export function emotionDelivery(emotion: string): {
  pitch: number;
  rate: number;
  gain: number;
  breath: number;
  vibrato: number;
} {
  return EMOTION_DELIVERY[emotion.toLowerCase()] ?? EMOTION_DELIVERY['neutral']!;
}

function syllables(text: string): number {
  return Math.max(1, (text.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
}

/** Estimated spoken duration used by the mock TTS and by timeline planning. */
export function estimateSpeechSeconds(text: string, speed: number, emotion = 'neutral'): number {
  const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
  const rate = 2.6 * Math.max(0.5, Math.min(2, speed)) * emotionDelivery(emotion).rate;
  return Math.round((words / rate + 0.35) * 100) / 100;
}

/**
 * MockTextToSpeechProvider — produces a "voice-like" tone pattern: one glided
 * tone per syllable, base frequency from the voice profile (presentation +
 * pitch), deterministic per voice identity so a locked voice always sounds the
 * same. Obviously not speech; it lets timing, ducking and mixing be tested.
 */
export class MockTextToSpeechProvider implements TextToSpeechProvider {
  readonly info = mockInfo('mock-tts', 'Mock text-to-speech', 'local_cpu');
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async synthesize(req: TtsRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'TTS_FAILED');
    if (!req.text.trim()) throw new ProviderError('TTS_FAILED', 'Empty text');
    const d = emotionDelivery(req.emotion);
    const duration = estimateSpeechSeconds(req.text, req.speed * req.voice.speed, req.emotion);
    const n = Math.round(duration * SR);
    const samples = new Float32Array(n);
    const base = { male: 118, female: 205, neutral: 162 }[req.voice.presentation] ?? 162;
    // Voice identity controls timbre (harmonic mix) deterministically.
    const timbre = prng(seedFrom(`${req.voice.voiceModel}|${req.voice.voiceIdentity}`));
    const h2 = 0.2 + timbre() * 0.4;
    const h3 = 0.05 + timbre() * 0.2;
    const freq = base * Math.pow(2, (req.voice.pitch + d.pitch) / 12);
    const count = syllables(req.text);
    const syl = (n - 0.2 * SR) / count;
    const rand = prng(seedFrom(req.text));
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / syl);
      const within = (i % syl) / syl;
      const inSyllable = k < count && within < 0.82;
      const env = inSyllable ? Math.sin(Math.PI * (within / 0.82)) : 0;
      const glide = 1 + 0.06 * Math.sin(TWO_PI * (k * 0.37 + within * 0.5));
      const vib = 1 + d.vibrato * Math.sin(TWO_PI * 6 * (i / SR));
      phase += (TWO_PI * freq * glide * vib) / SR;
      const voiced = Math.sin(phase) + h2 * Math.sin(2 * phase) + h3 * Math.sin(3 * phase);
      const breath = (rand() * 2 - 1) * d.breath;
      samples[i] = 0.32 * d.gain * env * ((1 - Math.min(d.breath, 0.9)) * voiced * 0.6 + breath);
    }
    return wavResult(
      samples,
      this.info.id,
      simulatedSeconds(duration * 0.3, ctx.attemptKey),
      { emotion: req.emotion, speed: req.speed, language: req.language, baseHz: Math.round(freq) },
      `mock tts ${duration}s "${req.text.slice(0, 40)}"`,
    );
  }
}

const MOOD_SCALES: Record<string, number[]> = {
  happy: [0, 4, 7, 12],
  adventure: [0, 4, 7, 11],
  magical: [0, 4, 7, 11, 14],
  celebration: [0, 4, 7, 12],
  bedtime: [0, 3, 7, 10],
  gentle: [0, 4, 7, 9],
  suspense: [0, 3, 6, 10],
  sad: [0, 3, 7, 10],
  mysterious: [0, 3, 6, 9],
};

function moodIntervals(mood: string): number[] {
  const m = mood.toLowerCase();
  for (const [key, scale] of Object.entries(MOOD_SCALES)) if (m.includes(key)) return scale;
  return [0, 4, 7];
}

/** MockMusicProvider — soft chord pad + arpeggio in a mood-dependent scale. */
export class MockMusicProvider implements MusicProvider {
  readonly info = mockInfo('mock-music', 'Mock music generator', 'local_cpu');
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async compose(req: MusicRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'MUSIC_FAILED');
    const duration = Math.max(1, Math.min(600, req.durationSec));
    const n = Math.round(duration * SR);
    const samples = new Float32Array(n);
    const intervals = moodIntervals(req.mood);
    const tempo = req.energy === 'high' ? 132 : req.energy === 'low' ? 72 : 100;
    const beat = (60 / tempo) * SR;
    const root = 196 * Math.pow(2, (seedFrom(req.mood + req.genre) % 5) / 12);
    const amp = req.energy === 'high' ? 0.22 : 0.16;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let pad = 0;
      for (const iv of intervals.slice(0, 3)) pad += Math.sin(TWO_PI * root * 0.5 * Math.pow(2, iv / 12) * t);
      const step = Math.floor(i / beat);
      const noteIv = intervals[step % intervals.length] ?? 0;
      const within = (i % beat) / beat;
      const pluck = Math.exp(-within * 5) * Math.sin(TWO_PI * root * Math.pow(2, noteIv / 12) * t);
      samples[i] = amp * (0.35 * (pad / 3) + 0.65 * pluck);
    }
    applyEdgeFades(samples, 0.5, 0.8);
    return wavResult(
      samples,
      this.info.id,
      simulatedSeconds(duration * 0.5, ctx.attemptKey),
      { mood: req.mood, genre: req.genre, energy: req.energy, tempo },
      `mock music ${duration}s mood=${req.mood}`,
    );
  }
}

type SfxSynth = (i: number, t: number, rand: () => number, dur: number) => number;

const SFX_SYNTHS: Array<{ match: RegExp; synth: SfxSynth }> = [
  {
    match: /rain|water|river|stream|ocean|wave|shower/,
    synth: (_i, t, r) => (r() * 2 - 1) * (0.25 + 0.1 * Math.sin(t * 0.7)),
  },
  {
    match: /thunder/,
    synth: (_i, t, r) => (r() * 2 - 1) * 0.9 * Math.exp(-t * 1.2) * (0.6 + 0.4 * Math.sin(TWO_PI * 30 * t)),
  },
  {
    match: /foot|step|walk/,
    synth: (_i, t, r) => {
      const within = t % 0.5;
      return within < 0.06 ? (r() * 2 - 1) * 0.7 * (1 - within / 0.06) : 0;
    },
  },
  {
    match: /bird|chirp/,
    synth: (_i, t) => {
      const within = t % 0.9;
      return within < 0.12 ? 0.4 * Math.sin(TWO_PI * (2400 + 9000 * within) * within) : 0;
    },
  },
  {
    match: /door|knock|thud/,
    synth: (_i, t, r) => (t < 0.25 ? (r() * 0.6 + Math.sin(TWO_PI * 80 * t)) * 0.6 * Math.exp(-t * 14) : 0),
  },
  {
    match: /magic|sparkle|twinkle|chime/,
    synth: (_i, t) =>
      0.3 * Math.exp(-((t % 0.3) * 8)) * Math.sin(TWO_PI * (1800 + 600 * Math.floor(t / 0.3)) * t),
  },
  { match: /wind|breeze/, synth: (_i, t, r) => (r() * 2 - 1) * 0.3 * (0.5 + 0.5 * Math.sin(t * 1.3)) },
  {
    match: /dog|bark|animal|cat|meow|roar/,
    synth: (_i, t) => {
      const within = t % 0.7;
      return within < 0.18 ? 0.5 * Math.sin(TWO_PI * 420 * within) * Math.sin(TWO_PI * 3 * within) : 0;
    },
  },
  {
    match: /car|vehicle|engine|truck|train|spaceship|hum/,
    synth: (_i, t) => 0.3 * (Math.sin(TWO_PI * 55 * t) + 0.5 * Math.sin(TWO_PI * 110 * t)) * 0.6,
  },
  {
    match: /crowd|people|classroom|city|market/,
    synth: (_i, t, r) => (r() * 2 - 1) * 0.18 * (0.7 + 0.3 * Math.sin(t * 5)),
  },
  {
    match: /insect|cricket|night/,
    synth: (_i, t) => (Math.sin(TWO_PI * 18 * t) > 0.6 ? 0.2 * Math.sin(TWO_PI * 4200 * t) : 0),
  },
  {
    match: /forest|jungle|park/,
    synth: (_i, t, r) => (r() * 2 - 1) * 0.08 + 0.12 * Math.sin(TWO_PI * 3000 * t) * (t % 1.7 < 0.1 ? 1 : 0),
  },
];

/**
 * MockSoundEffectProvider — rule-based synthesised placeholders for common
 * SFX and ambience tags. Loopable beds get a tail→head crossfade so they
 * loop without a click.
 */
export class MockSoundEffectProvider implements SoundEffectProvider {
  readonly info = mockInfo('mock-sfx', 'Mock SFX / ambience generator', 'local_cpu');
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async create(req: SfxRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'SFX_FAILED');
    const duration = Math.max(0.2, Math.min(120, req.durationSec));
    const crossfade = req.loopable ? Math.min(0.5, duration / 4) : 0;
    const n = Math.round((duration + crossfade) * SR);
    let samples: Float32Array = new Float32Array(n);
    const tag = req.tag.toLowerCase();
    const synth =
      SFX_SYNTHS.find((s) => s.match.test(tag))?.synth ??
      ((_i, t, r) => (r() * 2 - 1) * 0.2 * Math.exp(-t * 3));
    const rand = prng(seedFrom(tag));
    for (let i = 0; i < n; i++) samples[i] = synth(i, i / SR, rand, duration);
    if (req.loopable) samples = makeLoopable(samples, crossfade);
    else applyEdgeFades(samples, 0.005, 0.05);
    return wavResult(
      samples,
      this.info.id,
      simulatedSeconds(duration * 0.2, ctx.attemptKey),
      { tag: req.tag, loopable: req.loopable },
      `mock sfx "${req.tag}" ${duration}s${req.loopable ? ' (loop)' : ''}`,
    );
  }
}

/**
 * MockLipSyncProvider — returns a new mock-clip manifest that references the
 * original clip and the dialogue audio. The original clip is never modified.
 */
export class MockLipSyncProvider implements LipSyncProvider {
  readonly info = mockInfo('mock-lipsync', 'Mock lip-sync', 'cloud_gpu', 16);
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async sync(req: LipSyncRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'LIPSYNC_FAILED');
    if (req.videoMime !== MOCK_VIDEO_MIME)
      throw new ProviderError('LIPSYNC_FAILED', 'Unsupported video format');
    const original = JSON.parse(Buffer.from(req.video).toString('utf8')) as MockVideoManifest;
    const synced: MockVideoManifest = {
      ...original,
      note: 'MOCK LIP-SYNC CLIP — placeholder manifest',
      lipSync: { audioChecksum: sha256(req.audio) },
    };
    return {
      file: {
        data: Buffer.from(JSON.stringify(synced, null, 2)),
        mime: MOCK_VIDEO_MIME,
        ext: 'json',
        width: original.width,
        height: original.height,
        durationSec: original.durationSec,
        fps: original.fps,
      },
      model: this.info.id,
      modelVersion: this.info.modelVersion,
      generationSeconds: simulatedSeconds(req.durationSec * 4, ctx.attemptKey),
      isNativeResolution: true,
      settings: {},
      logs: ['mock lip-sync (manifest only)'],
    };
  }
}

export function applyEdgeFades(samples: Float32Array, fadeInSec: number, fadeOutSec: number): void {
  const fi = Math.min(samples.length, Math.round(fadeInSec * SR));
  const fo = Math.min(samples.length, Math.round(fadeOutSec * SR));
  for (let i = 0; i < fi; i++) samples[i] = (samples[i] ?? 0) * (i / fi);
  for (let i = 0; i < fo; i++) {
    const idx = samples.length - 1 - i;
    samples[idx] = (samples[idx] ?? 0) * (i / fo);
  }
}

/**
 * Crossfade the tail into the head so the buffer loops seamlessly. Returns a
 * buffer shorter by the crossfade length whose end flows into its start.
 */
export function makeLoopable(samples: Float32Array, crossfadeSec: number): Float32Array {
  const n = samples.length;
  const xf = Math.min(Math.floor(n / 2), Math.round(crossfadeSec * SR));
  const out = samples.slice(0, n - xf);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    out[i] = (samples[i] ?? 0) * a + (samples[n - xf + i] ?? 0) * (1 - a);
  }
  return out;
}
