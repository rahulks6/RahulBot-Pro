import type { AudioLayer } from '../domain/enums.ts';
import type { TimelineItem } from '../domain/types.ts';
import { dbToGain, DEFAULT_SAMPLE_RATE, gainToDb, levels, type PcmAudio } from '../media/wav.ts';
import type { AudioMixSettings } from './settings.ts';

/**
 * Preview/master audio mixer (spec §33–§34). Pure function over timeline
 * items so it is fully testable. Implements per-clip level balancing,
 * volume/fades, looping, music ducking under speech, layer gains and peak
 * protection. Phase 4 will perform the final master mix with FFmpeg filters
 * (loudnorm, sidechaincompress, alimiter) using the same timeline data.
 */
export const AUDIO_TRACKS: readonly AudioLayer[] = ['dialogue', 'narration', 'music', 'sfx', 'ambience'];

/** Target RMS per layer before the layer gain is applied (clip-level balancing). */
const LAYER_TARGET_RMS_DB: Record<AudioLayer, number> = {
  dialogue: -20,
  narration: -20,
  music: -24,
  sfx: -22,
  ambience: -28,
};

export interface MixInput {
  items: TimelineItem[];
  /** Decoded audio per asset id. Items without audio are skipped (reported as missing). */
  audio: Map<string, PcmAudio>;
  durationSec: number;
  settings: AudioMixSettings;
  /** Solo: only these layers are rendered. Defaults to all. */
  layers?: readonly AudioLayer[];
  sampleRate?: number;
}

export interface LayerStats {
  rmsDb: number;
  peakDb: number;
  activeSeconds: number;
}

export interface MixResult {
  pcm: PcmAudio;
  durationSec: number;
  layers: Partial<Record<AudioLayer, LayerStats>>;
  speechIntervals: Array<[number, number]>;
  preLimiterPeakDb: number;
  limiterGainDb: number;
  clippedSamples: number;
  missingAudioItems: string[];
  /** Music RMS during speech minus speech RMS (dB). Positive = music louder than speech. */
  musicOverSpeechDb: number | null;
}

function layerGainDb(layer: AudioLayer, s: AudioMixSettings): number {
  switch (layer) {
    case 'dialogue':
      return s.dialogueDb;
    case 'narration':
      return s.narrationDb;
    case 'music':
      return s.musicDb;
    case 'sfx':
      return s.sfxDb;
    case 'ambience':
      return s.ambienceDb;
  }
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.05) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Ducking envelope (linear gain per sample): 1 outside speech, duck gain inside, ramped by attack/release. */
export function duckingEnvelope(
  length: number,
  sampleRate: number,
  intervals: Array<[number, number]>,
  duckDb: number,
  attackSec: number,
  releaseSec: number,
): Float32Array {
  const env = new Float32Array(length).fill(1);
  const duck = dbToGain(duckDb);
  for (const [start, end] of intervals) {
    const a0 = Math.max(0, Math.round((start - attackSec) * sampleRate));
    const s0 = Math.round(start * sampleRate);
    const s1 = Math.min(length, Math.round(end * sampleRate));
    const r1 = Math.min(length, Math.round((end + releaseSec) * sampleRate));
    for (let i = a0; i < s0 && i < length; i++) {
      const t = (i - a0) / Math.max(1, s0 - a0);
      env[i] = Math.min(env[i] ?? 1, 1 + (duck - 1) * t);
    }
    for (let i = Math.max(0, s0); i < s1; i++) env[i] = Math.min(env[i] ?? 1, duck);
    for (let i = s1; i < r1; i++) {
      const t = (i - s1) / Math.max(1, r1 - s1);
      env[i] = Math.min(env[i] ?? 1, duck + (1 - duck) * t);
    }
  }
  return env;
}

/**
 * Mix one layer at a time into the master so memory stays at about two
 * buffers (master + current layer) even for long episodes at 48 kHz.
 * Sources are resampled with linear interpolation.
 */
export function mixTimeline(input: MixInput): MixResult {
  const sr = input.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const n = Math.max(1, Math.round(input.durationSec * sr));
  const s = input.settings;
  const active = new Set(input.layers ?? AUDIO_TRACKS);
  const missing: string[] = [];

  const speech: Array<[number, number]> = [];
  for (const item of input.items) {
    if (
      (item.track === 'dialogue' || item.track === 'narration') &&
      item.asset_id &&
      input.audio.has(item.asset_id)
    ) {
      speech.push([item.start_sec, item.start_sec + item.duration_sec]);
    }
  }
  const speechIntervals = mergeIntervals(speech);
  const speechRanges = speechIntervals.map(
    ([a, b]) => [Math.round(a * sr), Math.min(n, Math.round(b * sr))] as const,
  );
  for (const item of input.items) {
    if (AUDIO_TRACKS.includes(item.track as AudioLayer) && !(item.asset_id && input.audio.has(item.asset_id)))
      missing.push(item.id);
  }

  const layerStats: Partial<Record<AudioLayer, LayerStats>> = {};
  const speechEnergy: Partial<Record<AudioLayer, number>> = {};
  let speechSamples = 0;
  for (const [a, b] of speechRanges) speechSamples += Math.max(0, b - a);
  const master = new Float32Array(n);

  for (const layer of AUDIO_TRACKS) {
    if (!active.has(layer)) continue;
    const items = input.items.filter((i) => i.track === layer && i.asset_id && input.audio.has(i.asset_id));
    if (items.length === 0) continue;
    const buf = new Float32Array(n);
    let activeSec = 0;
    for (const item of items) {
      const src = input.audio.get(item.asset_id!)!;
      activeSec += item.duration_sec;
      renderItem(buf, item, src, sr, LAYER_TARGET_RMS_DB[layer], layerGainDb(layer, s));
    }
    // Music ducking under narration/dialogue; ambience ducks by half as much.
    if (s.duckingEnabled && speechIntervals.length > 0 && (layer === 'music' || layer === 'ambience')) {
      const env = duckingEnvelope(
        n,
        sr,
        speechIntervals,
        layer === 'music' ? s.duckDb : s.duckDb / 2,
        s.duckAttackSec,
        s.duckReleaseSec,
      );
      for (let i = 0; i < n; i++) buf[i] = (buf[i] ?? 0) * (env[i] ?? 1);
    }
    const lv = levels(buf);
    layerStats[layer] = {
      rmsDb: round1(lv.rmsDb),
      peakDb: round1(lv.peakDb),
      activeSeconds: round1(activeSec),
    };
    let e = 0;
    for (const [a, b] of speechRanges) for (let i = a; i < b; i++) e += (buf[i] ?? 0) ** 2;
    speechEnergy[layer] = e;
    for (let i = 0; i < n; i++) master[i] = (master[i] ?? 0) + (buf[i] ?? 0);
  }

  // Music vs speech during speech (is the music overpowering dialogue?).
  // Speech power is approximated as dialogue + narration power (they rarely overlap).
  let musicOverSpeechDb: number | null = null;
  const sp = (speechEnergy.dialogue ?? 0) + (speechEnergy.narration ?? 0);
  if (speechEnergy.music !== undefined && speechSamples > 0 && sp > 0) {
    musicOverSpeechDb = round1(10 * Math.log10((speechEnergy.music + 1e-12 * speechSamples) / sp));
  }

  // Peak protection: normalise so the peak sits at the ceiling (never above).
  const pre = levels(master);
  const ceiling = dbToGain(s.peakCeilingDb);
  let limiterGain = 1;
  if (pre.peak > ceiling) {
    limiterGain = ceiling / pre.peak;
    for (let i = 0; i < n; i++) master[i] = (master[i] ?? 0) * limiterGain;
  }
  const post = levels(master);

  return {
    pcm: { sampleRate: sr, samples: master },
    durationSec: n / sr,
    layers: layerStats,
    speechIntervals,
    preLimiterPeakDb: round1(pre.peakDb),
    limiterGainDb: round1(gainToDb(limiterGain)),
    clippedSamples: post.clippedSamples,
    missingAudioItems: [...new Set(missing)],
    musicOverSpeechDb,
  };
}

/** Add one timeline item to a layer buffer: level balancing, gain, trim, loop, fades, linear-interpolated resampling. */
function renderItem(
  buf: Float32Array,
  item: TimelineItem,
  src: PcmAudio,
  sr: number,
  targetRmsDb: number,
  layerDb: number,
): void {
  const n = buf.length;
  const srcLevels = levels(src.samples);
  const normalizeDb = srcLevels.rms > 1e-6 ? targetRmsDb - srcLevels.rmsDb : 0;
  const gain = dbToGain(normalizeDb + item.volume_db + layerDb);
  const start = Math.round(item.start_sec * sr);
  const len = Math.round(item.duration_sec * sr);
  const trim = item.trim_in_sec * src.sampleRate;
  const fi = Math.round(item.fade_in_sec * sr);
  const fo = Math.round(item.fade_out_sec * sr);
  const ratio = src.sampleRate / sr;
  const srcLen = src.samples.length;
  if (srcLen === 0) return;
  for (let i = 0; i < len; i++) {
    const out = start + i;
    if (out < 0 || out >= n) continue;
    let pos = trim + i * ratio;
    if (pos >= srcLen) {
      if (!item.loop) break;
      pos = pos % srcLen;
    }
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src.samples[i0] ?? 0;
    const b = src.samples[i0 + 1 < srcLen ? i0 + 1 : item.loop ? 0 : i0] ?? a;
    let g = gain;
    if (fi > 0 && i < fi) g *= i / fi;
    if (fo > 0 && i > len - fo) g *= Math.max(0, (len - i) / fo);
    buf[out] = (buf[out] ?? 0) + (a + (b - a) * frac) * g;
  }
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}
