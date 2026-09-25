import { decodeWav, levels } from '../../media/wav.ts';
import type { StorageProvider } from '../../storage/storage.ts';
import type { MediaProbe, ProbeResult } from '../types.ts';

export interface MockMasterManifest {
  format: 'ai-story-studio/mock-master';
  version: 1;
  note: string;
  container: 'mp4';
  durationSec: number;
  video: { codec: 'h264'; width: number; height: number; fps: number };
  audio: { codec: 'aac'; mixKey: string };
  clips: Array<{ shotId: string; storageKey: string; startSec: number; durationSec: number }>;
}

const EMPTY: ProbeResult = {
  exists: false,
  readable: false,
  decodes: false,
  container: '',
  durationSec: 0,
  isMock: true,
  notes: [],
};

/**
 * MockMediaProbe — "ffprobe" for Phase 1 mock outputs. Reads the mock master
 * manifest, verifies every referenced clip exists and decodes the mixed WAV
 * to measure real audio levels. Real MP4s are probed by FfprobeMediaProbe.
 */
export class MockMediaProbe implements MediaProbe {
  readonly id = 'mock-probe';
  private readonly storage: StorageProvider;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  async probe(storageKey: string): Promise<ProbeResult> {
    if (!(await this.storage.exists(storageKey))) return { ...EMPTY, notes: ['file does not exist'] };
    const notes: string[] = [];
    let manifest: MockMasterManifest;
    try {
      manifest = JSON.parse((await this.storage.get(storageKey)).toString('utf8')) as MockMasterManifest;
      if (manifest.format !== 'ai-story-studio/mock-master') throw new Error('not a mock master');
    } catch (err) {
      return { ...EMPTY, exists: true, notes: [`unreadable: ${(err as Error).message}`] };
    }
    let decodes = true;
    for (const clip of manifest.clips) {
      if (!(await this.storage.exists(clip.storageKey))) {
        decodes = false;
        notes.push(`missing clip ${clip.storageKey}`);
      }
    }
    let audio: ProbeResult['audio'];
    let audioDuration = 0;
    try {
      const pcm = decodeWav(await this.storage.get(manifest.audio.mixKey));
      const lv = levels(pcm.samples);
      audioDuration = pcm.samples.length / pcm.sampleRate;
      audio = {
        codec: manifest.audio.codec,
        sampleRate: pcm.sampleRate,
        channels: 1,
        peakDb: lv.peakDb,
        clippedSamples: lv.clippedSamples,
      };
    } catch (err) {
      decodes = false;
      notes.push(`audio mix unreadable: ${(err as Error).message}`);
    }
    if (audio && Math.abs(audioDuration - manifest.durationSec) > 0.25) {
      notes.push(
        `audio duration ${audioDuration.toFixed(2)}s differs from video ${manifest.durationSec.toFixed(2)}s`,
      );
    }
    notes.push('mock master: manifest + WAV mix, no MP4 encoded in Phase 1');
    return {
      exists: true,
      readable: true,
      decodes,
      container: manifest.container,
      durationSec: manifest.durationSec,
      video: { ...manifest.video },
      ...(audio ? { audio } : {}),
      isMock: true,
      notes,
    };
  }
}
