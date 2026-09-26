import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio, type Studio, type StudioOptions } from '../src/app/studio.ts';
import { ManualClock } from '../src/lib/clock.ts';
import type { MockGPUProvider } from '../src/providers/mock/gpu.ts';
import { createMockProviders } from '../src/providers/registry.ts';
import { HardwareService, type NvidiaReport } from '../src/services/hardware.ts';
import { LocalStorageProvider } from '../src/storage/storage.ts';

export interface TestStudio extends Studio {
  clockCtl: ManualClock;
  mockGpu: MockGPUProvider;
  cleanup(): void;
}

/** Isolated studio: in-memory SQLite, temp storage, manual clock, mock providers, no log output. */
export function testStudio(
  opts: Omit<StudioOptions, 'dbPath' | 'clock' | 'logSinks'> & { failureRate?: number } = {},
): TestStudio {
  const dir = mkdtempSync(join(tmpdir(), 'ais-test-'));
  const clock = new ManualClock('2026-03-15T09:00:00.000Z');
  const storage = new LocalStorageProvider(join(dir, 'storage'));
  const providers = opts.providers ?? createMockProviders(storage, opts.failureRate ?? 0);
  const studio = createStudio({
    env: {
      mockGeneration: true,
      enableCloudGpu: false,
      dataDir: dir,
      logLevel: 'error',
      mockFailureRate: 0,
      assemblyMode: 'mock',
      ...opts.env,
    },
    dbPath: ':memory:',
    clock,
    providers,
    logSinks: [],
    ...(opts.ffmpeg !== undefined ? { ffmpeg: opts.ffmpeg } : {}),
    ...(opts.cloud ? { cloud: opts.cloud } : {}),
    // Never let a real RUNPOD_API_KEY from the developer's environment reach tests.
    secretEnv: opts.secretEnv ?? {},
    // Tests never depend on the GPU of the machine running them.
    hardware: opts.hardware ?? fakeHardware(null),
  });
  return Object.assign(studio, {
    clockCtl: clock,
    mockGpu: providers.gpu as MockGPUProvider,
    cleanup: () => {
      studio.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

/** Small project with two characters (with voices), a narrator, a location and a 2-scene story. */
export function seedSmall(s: Studio) {
  const project = s.projects.create({ name: 'Test Project', genre: 'Fantasy' });
  const narrator = s.characters.createVoice(project.id, {
    name: 'Narrator',
    role: 'narrator',
    presentation: 'female',
  });
  s.projects.update(project.id, { narrator_voice_id: narrator.id });
  const v1 = s.characters.createVoice(project.id, { name: 'Ari voice', pitch: 3 });
  const v2 = s.characters.createVoice(project.id, { name: 'Bo voice', presentation: 'male' });
  const ari = s.characters.create(project.id, {
    name: 'Ari',
    species: 'fox',
    prompt: 'orange fox with blue scarf',
    negative_prompt: 'realistic, extra tails',
    voice_profile_id: v1.id,
  });
  const bo = s.characters.create(project.id, {
    name: 'Bo',
    species: 'robot',
    prompt: 'small round robot',
    voice_profile_id: v2.id,
  });
  const loc = s.characters.createLocation(project.id, {
    name: 'Cloud Harbour',
    prompt: 'floating harbour in the clouds',
    negative_prompt: 'city',
  });
  const story = s.stories.create(project.id, {
    title: 'Sky Boats',
    synopsis: 'Ari wants to fly.',
    target_duration_sec: 20,
  });
  const sc1 = s.stories.createScene(story.id, {
    title: 'Dock',
    summary: 'Ari arrives at the dock.',
    location_id: loc.id,
    music_mood: 'happy adventure',
    ambience: 'wind',
  });
  const sc2 = s.stories.createScene(story.id, {
    title: 'Launch',
    summary: 'They launch the boat and fly home.',
    location_id: loc.id,
    music_mood: 'celebration',
  });
  const sh1 = s.stories.createShot(sc1.id, {
    title: 'Arrive',
    action: 'Ari walks onto the dock',
    duration_sec: 4,
    mouth_visible: true,
  });
  const sh2 = s.stories.createShot(sc1.id, { title: 'Meet', action: 'Bo waves', duration_sec: 3 });
  const sh3 = s.stories.createShot(sc2.id, { title: 'Fly', action: 'the boat lifts off', duration_sec: 4 });
  s.stories.setShotCharacters(sh1.id, [{ character_id: ari.id }]);
  s.stories.setShotCharacters(sh2.id, [{ character_id: ari.id }, { character_id: bo.id }]);
  s.stories.addDialogue(sh1.id, {
    character_id: ari.id,
    text: 'Is this the sky harbour?',
    emotion: 'excited',
  });
  s.stories.addDialogue(sh2.id, {
    character_id: bo.id,
    text: 'Welcome aboard, little fox.',
    emotion: 'happy',
  });
  s.stories.addNarration(sc1.id, { text: 'Ari had always dreamed of flying.' });
  s.stories.addNarration(sc2.id, { shot_id: sh3.id, text: 'And up they went, into the golden sky.' });
  s.stories.addShotSfx(sh1.id, 'footsteps', { required: true });
  return { project, narrator, ari, bo, loc, story, scenes: [sc1, sc2], shots: [sh1, sh2, sh3] };
}

/** Generate + approve images and clips for every shot of a story (mock). */
export async function produceShots(s: Studio, storyId: string): Promise<void> {
  const shots = s.stories.listStoryShots(storyId);
  for (const sh of shots) s.generation.queueImage(sh.id);
  await s.generation.processQueue();
  for (const sh of shots) {
    const a = s.jobs.attemptsForShot(sh.id, 'image').find((x) => x.status === 'succeeded')!;
    s.generation.approveAttempt(a.id);
  }
  for (const sh of shots) s.generation.queueVideo(sh.id);
  await s.generation.processQueue();
  for (const sh of shots) {
    const a = s.jobs.attemptsForShot(sh.id, 'video').find((x) => x.status === 'succeeded')!;
    s.generation.approveAttempt(a.id);
  }
}

/** Hardware detection replaying a fixed nvidia-smi result (null = no NVIDIA GPU). */
export function fakeHardware(
  gpu: { name: string; totalMb: number; usedMb?: number; util?: number; cuda?: string } | null,
): HardwareService {
  const report: NvidiaReport = gpu
    ? {
        found: true,
        smiPath: 'nvidia-smi',
        driverVersion: '566.14',
        cudaDriverVersion: gpu.cuda ?? '12.7',
        gpus: [
          {
            index: 0,
            name: gpu.name,
            uuid: 'GPU-test',
            driverVersion: '566.14',
            vramTotalMb: gpu.totalMb,
            vramUsedMb: gpu.usedMb ?? 500,
            vramFreeMb: gpu.totalMb - (gpu.usedMb ?? 500),
            utilizationPct: gpu.util ?? 3,
            temperatureC: 40,
            computeCapability: '8.9',
          },
        ],
        error: null,
        checkedAt: '2026-03-15T09:00:00.000Z',
      }
    : {
        found: false,
        smiPath: null,
        driverVersion: null,
        cudaDriverVersion: null,
        gpus: [],
        error: 'nvidia-smi was not found (no NVIDIA driver installed, or no NVIDIA GPU).',
        checkedAt: '2026-03-15T09:00:00.000Z',
      };
  return new HardwareService({ detect: async () => report });
}
