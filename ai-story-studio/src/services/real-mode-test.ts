import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEnv } from '../config/env.ts';
import type { Database } from '../db/database.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';
import { runTool, type FfmpegTools } from '../media/ffmpeg.ts';
import type { RunContext } from '../providers/types.ts';
import { sniffMime } from '../providers/worker/validate.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import type { StorageProvider } from '../storage/storage.ts';
import type { CloudService } from './cloud.ts';
import type { GpuPlan, GpuSupervisor } from './gpu-supervisor.ts';
import { speechText } from './hinglish.ts';
import { HINGLISH } from './localization.ts';
import type { ModelManager } from './model-manager.ts';

/**
 * The Real Mode Test (Settings → AI Engine, and Advanced → Real Mode Test): the minimal REAL vertical
 * pipeline on a rented RunPod GPU, reported step by step as PASS / FAIL / BLOCKED / NOT TESTED:
 *
 *   RUNPOD AUTH → GPU → CUDA (proven by the worker) → IMAGE (+ validation) → VIDEO (+ motion
 *   validation) → ENGLISH TTS → HINGLISH TTS → GPU TERMINATED → test_english.mp4 + test_hinglish.mp4
 *   from the SAME clip → FFPROBE → PLAYBACK → your own review of the picture, motion and both voices
 *
 * Nothing is rented until the user confirms the GPU and price. The GPU is terminated as soon as the
 * GPU work is done (and in `finally` whatever happens); combining and checking run locally with FFmpeg.
 * A clip made by the worker's non-AI still-image camera move is NOT a pass for "animated". The four
 * review steps stay NOT TESTED until a person watches/listens and records PASS or FAIL: a file that
 * exists is not proof that it looks or sounds right.
 */
export type MilestoneStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED' | 'RUNNING' | 'NEEDS IMPROVEMENT';

/** milestone1 = the Real Mode Test; consistency = the recurring-character consistency test. */
export type RealTestKind = 'milestone1' | 'consistency';

export interface MilestoneStep {
  n: number;
  name: string;
  status: MilestoneStatus;
  detail: string;
  at: string | null;
}

export interface MilestoneRecord {
  id: string;
  kind: RealTestKind;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  gpu_model: string | null;
  hourly_rate_inr: number | null;
  steps: MilestoneStep[];
  output_key: string | null;
  runtime_sec: number | null;
  cost_inr: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export const MILESTONE_STEPS = [
  'RunPod authentication',
  'AI worker available to RunPod',
  'GPU chosen (compatibility first) and price shown',
  'Your confirmation',
  'Real GPU provisioned',
  'Real worker healthy',
  'CUDA verified by the worker',
  'Real image generated (image model)',
  'Image validated (decodes, size, not blank, not black)',
  'Real image animated (AI image-to-video)',
  'Motion validated (duration, frames, moves, not black)',
  'Real English narration',
  'Real Hinglish narration (Hindi voice)',
  'GPU terminated (billing stopped)',
  'English MP4 built (test_english.mp4)',
  'Hinglish MP4 built from the same clip (test_hinglish.mp4)',
  'FFprobe: H.264/AAC, 1920×1080, 30 fps (both)',
  'Playback: full decode of both MP4s',
  'Your review: the picture',
  'Your review: the motion',
  'Your review: English voice',
  'Your review: Hinglish voice',
] as const;

/** Steps only a person can decide (watch / listen). */
export const REVIEW_STEPS = [
  'Your review: the picture',
  'Your review: the motion',
  'Your review: English voice',
  'Your review: Hinglish voice',
] as const;

const S = Object.fromEntries(MILESTONE_STEPS.map((name, i) => [name, i + 1])) as Record<
  (typeof MILESTONE_STEPS)[number],
  number
>;

/** An ORIGINAL test character (no existing franchise). */
export const TEST_CHARACTER =
  'a 12-year-old futuristic explorer with dark wavy hair, a teal and silver exploration jacket, a compact wrist scanner and white futuristic shoes, with a small glowing blue robot companion floating beside them';
const PROMPT = `${TEST_CHARACTER}, standing in a bright futuristic lab, bright premium stylized 3D children's animation, soft cinematic light, vibrant colours, full body, centred`;
const MOTION =
  'the explorer turns toward the robot, the robot floats upward, the wrist scanner glows blue, the camera slowly pushes forward';
export const ENGLISH_LINE = 'The signal is coming from somewhere beyond the portal.';
/** The same line in Roman-script Hinglish (captions); the voice gets it in mixed script. */
export const HINGLISH_LINE = 'Signal portal ke doosri side se aa raha hai. Scanner activate karo!';

/**
 * The character consistency test: one ORIGINAL character, a canonical reference, then 12 shots made
 * with the app's real reference mechanism (image-to-image from the reference at the configured
 * strength, plus the reference image for models with an image-prompt adapter), a contact sheet, and
 * the person's verdict. Steps 1–7 are the same as the Real Mode Test.
 */
export const CONSISTENCY_STEPS = [
  'RunPod authentication',
  'AI worker available to RunPod',
  'GPU chosen (compatibility first) and price shown',
  'Your confirmation',
  'Real GPU provisioned',
  'Real worker healthy',
  'CUDA verified by the worker',
  'Canonical reference generated',
  '12 shots generated from the reference',
  'Every shot validated (decodes, not blank, not black)',
  'GPU terminated (billing stopped)',
  'Contact sheet built',
  'Your review: consistency',
] as const;

const C = Object.fromEntries(CONSISTENCY_STEPS.map((name, i) => [name, i + 1])) as Record<
  (typeof CONSISTENCY_STEPS)[number],
  number
>;

/** The 12 consistency shots (spec: views, expressions, actions, settings, lighting). */
export const CONSISTENCY_SHOTS: Array<[string, string]> = [
  ['front view', 'front view, standing, facing the camera'],
  ['three-quarter view', 'three-quarter view, standing'],
  ['side view', 'side view, profile, standing'],
  ['happy', 'close-up, big happy smile'],
  ['worried', 'close-up, worried expression'],
  ['surprised', 'close-up, surprised expression, eyes wide open'],
  ['running', 'running fast, dynamic pose, full body'],
  ['using scanner', 'looking at the glowing wrist scanner, arm raised'],
  ['inside spaceship', 'inside a spaceship cockpit with glowing control panels'],
  ['alien planet', 'outdoors on a colourful alien planet with two moons'],
  ['warm lighting', 'warm golden sunset lighting'],
  ['cool lighting', 'cool blue night lighting with soft neon glow'],
];

type TestRow = Omit<MilestoneRecord, 'steps' | 'kind'> & { steps_json: string; test_kind: string };

interface Prepared {
  id: string;
  kind: RealTestKind;
  plan: GpuPlan;
  models: { image: string; video: string; tts: string };
}

export interface RealModeTestDeps {
  db: Database;
  env: AppEnv;
  gpu: GpuSupervisor;
  gpuRepo: GpuRepository;
  cloud: CloudService;
  models: ModelManager;
  storage: StorageProvider;
  ffmpeg: FfmpegTools | null;
  clock: Clock;
  logger: Logger;
  tempDir: string;
  /** Settings → Generation → Character reference strength (the app's real reference mechanism). */
  referenceStrength: () => number;
}

export class RealModeTest {
  private readonly d: RealModeTestDeps;
  private readonly prepared = new Map<string, Prepared>();
  private readonly aborts = new Map<string, AbortController>();
  running: Promise<MilestoneRecord> | null = null;

  constructor(d: RealModeTestDeps) {
    this.d = d;
  }

  get(id: string): MilestoneRecord {
    const r = this.d.db.get<TestRow>('SELECT * FROM cloud_tests WHERE id = ?', id);
    if (!r || (r.test_kind !== 'milestone1' && r.test_kind !== 'consistency'))
      throw new AppError('NOT_FOUND', 'Real Mode Test not found');
    const { steps_json, test_kind, ...rest } = r;
    return { ...rest, kind: test_kind as RealTestKind, steps: parseJson<MilestoneStep[]>(steps_json, []) };
  }

  latest(kind: RealTestKind = 'milestone1'): MilestoneRecord | null {
    const row = this.d.db.get<{ id: string }>(
      'SELECT id FROM cloud_tests WHERE test_kind = ? ORDER BY started_at DESC LIMIT 1',
      kind,
    );
    return row ? this.get(row.id) : null;
  }

  private set(id: string, n: number, status: MilestoneStatus, detail: string): void {
    const rec = this.get(id);
    const step = rec.steps.find((x) => x.n === n);
    if (step) Object.assign(step, { status, detail, at: this.d.clock.now().toISOString() });
    this.d.db.update('cloud_tests', id, { steps_json: JSON.stringify(rec.steps) });
    this.d.logger.info('real mode test step', { test: id, step: n, status, detail: detail.slice(0, 300) });
  }

  private finish(
    id: string,
    status: MilestoneRecord['status'],
    extra: Record<string, string | number | null>,
  ): MilestoneRecord {
    // Steps never reached were not executed: NOT TESTED, never PASS.
    const rec = this.get(id);
    for (const st of rec.steps) if (st.status === 'RUNNING') st.status = 'FAIL';
    this.d.db.update('cloud_tests', id, {
      status,
      steps_json: JSON.stringify(rec.steps),
      finished_at: this.d.clock.now().toISOString(),
      ...extra,
    });
    return this.get(id);
  }

  /** Steps 1–3: key, worker image, GPU choice and price. Read-only RunPod calls: nothing is rented. */
  async prepare(kind: RealTestKind = 'milestone1'): Promise<{ record: MilestoneRecord; ready: boolean }> {
    const id = newId('ctest');
    const names: readonly string[] = kind === 'consistency' ? CONSISTENCY_STEPS : MILESTONE_STEPS;
    const steps: MilestoneStep[] = names.map((name, i) => ({
      n: i + 1,
      name,
      status: 'NOT TESTED',
      detail: '',
      at: null,
    }));
    this.d.db.insert('cloud_tests', {
      id,
      provider: this.d.cloud.provider.id,
      status: 'running',
      test_kind: kind,
      steps_json: JSON.stringify(steps),
      started_at: this.d.clock.now().toISOString(),
    });
    try {
      try {
        this.d.cloud.assertCanProvision();
      } catch (err) {
        this.set(id, S['RunPod authentication'], 'BLOCKED', toAppError(err).message);
        return {
          record: this.finish(id, 'failed', { error_message: toAppError(err).message }),
          ready: false,
        };
      }
      if (this.d.gpu.currentProvider !== this.d.cloud.provider) this.d.cloud.refresh();
      const conn = await this.d.cloud.testConnection();
      if (!conn.ok) {
        this.set(id, S['RunPod authentication'], 'FAIL', conn.detail);
        return { record: this.finish(id, 'failed', { error_message: conn.detail }), ready: false };
      }
      this.set(id, S['RunPod authentication'], 'PASS', conn.detail);
      const image = await this.d.cloud.checkImage(this.d.cloud.workerImage());
      if (!image.ok) {
        this.set(id, S['AI worker available to RunPod'], 'BLOCKED', image.detail);
        return { record: this.finish(id, 'failed', { error_message: image.detail }), ready: false };
      }
      this.set(id, S['AI worker available to RunPod'], 'PASS', image.detail);
      const pick = (k: 'image' | 'video' | 'tts') => {
        const m = this.d.models.selected(k);
        if (!m)
          throw new AppError(
            'PRECONDITION_FAILED',
            `No ${k} model is enabled for the cloud (Advanced → Cloud GPU → Models).`,
          );
        return m;
      };
      const img = pick('image');
      // The consistency test only draws pictures: it does not need the video and voice models.
      const vid = kind === 'consistency' ? img : pick('video');
      const tts = kind === 'consistency' ? img : pick('tts');
      const plan = await this.d.gpu.plan(
        Math.max(img.minVramGb, vid.minVramGb, tts.minVramGb),
        kind === 'consistency' ? 1200 : 1500,
        { recommendedVramGb: Math.max(img.recommendedVramGb, vid.recommendedVramGb, tts.recommendedVramGb) },
      );
      this.set(
        id,
        S['GPU chosen (compatibility first) and price shown'],
        'PASS',
        `${plan.offer.gpuModel} (${plan.offer.vramGb} GB) at ₹${plan.offer.hourlyRateInr}/h — ${plan.reasons.join('; ')}. Estimated ₹${plan.estimatedCostInr.toFixed(2)} (worst case ₹${plan.estimatedMaxCostInr.toFixed(2)}). Models: ${kind === 'consistency' ? img.name : `${img.name}, ${vid.name}, ${tts.name}`}.${plan.alternatives.length ? ` Fallbacks: ${plan.alternatives.map((a) => a.gpuModel).join(', ')}.` : ''}`,
      );
      this.set(id, S['Your confirmation'], 'RUNNING', 'waiting for you — nothing has been rented yet');
      this.d.db.update('cloud_tests', id, {
        gpu_model: plan.offer.gpuModel,
        hourly_rate_inr: plan.offer.hourlyRateInr,
      });
      this.prepared.set(id, { id, kind, plan, models: { image: img.id, video: vid.id, tts: tts.id } });
      return { record: this.get(id), ready: true };
    } catch (err) {
      const e = toAppError(err);
      const cur = this.get(id).steps.find((x) => x.status === 'NOT TESTED' || x.status === 'RUNNING');
      if (cur) this.set(id, cur.n, 'FAIL', e.message);
      return { record: this.finish(id, 'failed', { error_message: e.message }), ready: false };
    }
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort();
    if (this.prepared.delete(id)) {
      this.set(id, S['Your confirmation'], 'NOT TESTED', 'cancelled before anything was rented');
      this.finish(id, 'cancelled', { error_message: 'cancelled before anything was rented' });
    }
  }

  confirm(id: string): Promise<MilestoneRecord> {
    const p = this.prepared.get(id);
    if (!p)
      throw new AppError(
        'PRECONDITION_FAILED',
        'This test was not prepared (or already ran). Start a new test.',
      );
    if (this.running) throw new AppError('CONFLICT', 'A GPU test is already running.');
    this.prepared.delete(id);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    this.set(id, S['Your confirmation'], 'PASS', 'confirmed by you');
    this.running = (
      p.kind === 'consistency' ? this.executeConsistency(p, abort.signal) : this.execute(p, abort.signal)
    ).finally(() => {
      this.running = null;
      this.aborts.delete(id);
    });
    return this.running;
  }

  private async execute(p: Prepared, signal: AbortSignal): Promise<MilestoneRecord> {
    const { id } = p;
    let instanceId: string | null = null;
    let error: string | null = null;
    let outputKey: string | null = null;
    let current = S['Real GPU provisioned'];
    mkdirSync(this.d.tempDir, { recursive: true });
    const work = mkdtempSync(join(this.d.tempDir, 'real-test-'));
    const files: { image?: Buffer; clip?: Buffer; audio?: Buffer; audioHi?: Buffer } = {};
    const ff = this.d.ffmpeg;
    const save = async (name: string, data: Buffer): Promise<string> => {
      const key = `real-tests/${id}/${name}`;
      await this.d.storage.put(key, data);
      return key;
    };
    try {
      // --- GPU part ------------------------------------------------------------------------
      this.set(id, current, 'RUNNING', `renting ${p.plan.offer.gpuModel}`);
      const session = await this.d.gpu.start(p.plan, {
        purpose: 'test',
        signal,
        onFallback: (from, to, reason) =>
          this.set(
            id,
            current,
            'RUNNING',
            `${from.gpuModel} could not be used (${reason}); trying ${to.gpuModel}`,
          ),
      });
      instanceId = session.id;
      this.d.db.update('cloud_tests', id, {
        gpu_instance_id: instanceId,
        gpu_model: session.instance.gpu_model,
      });
      const inst = this.d.gpuRepo.get(instanceId);
      this.set(id, current, 'PASS', `${inst.gpu_model} · pod ${inst.provider_instance_id}`);
      current = S['Real worker healthy'];
      const client = this.d.cloud.bridge.client;
      if (!client) throw new AppError('WORKER_UNAVAILABLE', 'The worker was not bound after start-up.');
      const health = await client.health();
      const system = await client.system();
      this.set(
        id,
        current,
        'PASS',
        `worker ${system.worker_version} · ${health.status}${system.python ? ` · Python ${system.python}` : ''}`,
      );
      current = S['CUDA verified by the worker'];
      const g = system.gpu.gpus[0];
      if (!system.gpu.available || !system.torch?.cuda_available)
        throw new AppError(
          'CUDA_FAILURE',
          `The worker cannot use CUDA (${system.gpu.reason ?? (system.torch?.error || 'PyTorch reports no CUDA')}).`,
        );
      // The exact libraries on the pod, kept with the test (non-secret) so the run documents them.
      const pkgs = system.installed_packages ?? [];
      const pkgKey = pkgs.length
        ? await save('installed-packages.txt', Buffer.from(`${pkgs.join('\n')}\n`))
        : null;
      const pick = (n: string) => pkgs.find((x) => x.toLowerCase().startsWith(`${n}==`))?.split('==')[1];
      const libs = ['diffusers', 'transformers', 'accelerate', 'kokoro', 'misaki']
        .map((n) => (pick(n) ? `${n} ${pick(n)}` : ''))
        .filter(Boolean)
        .join(', ');
      this.set(
        id,
        current,
        'PASS',
        `${g?.name ?? 'GPU'} · ${g ? Math.round(g.vram_total_mb / 1024) : '?'} GB VRAM · CUDA ${system.gpu.cuda_version ?? '?'} · PyTorch ${system.torch?.version ?? '?'} (CUDA runtime ${system.torch?.cuda_runtime ?? '?'}) · torch.cuda device: ${system.torch?.device ?? '?'}${libs ? ` · ${libs}` : ''}${pkgKey ? ` · ${pkgs.length} libraries recorded (${pkgKey})` : ''}`,
      );
      session.setState('GENERATING', 'Real Mode Test');
      const providers = this.d.cloud.bridge.providers();
      const ctx = (step: number): RunContext => ({
        attemptKey: `realtest:${id}:${step}`,
        signal,
        onProgress: (x) => {
          if (x.status === 'loading_model')
            this.set(id, step, 'RUNNING', `loading the model (first run downloads it) ${x.message}`);
        },
      });

      current = S['Real image generated (image model)'];
      if (providers.image.info.isMock || providers.video.info.isMock || providers.tts.info.isMock)
        throw new AppError('VALIDATION_FAILED', 'The worker offers placeholder models, not real ones.');
      this.set(id, current, 'RUNNING', `drawing with ${p.models.image}`);
      const img = await providers.image.generate(
        {
          mode: 'text_to_image',
          prompt: PROMPT,
          negativePrompt: 'text, watermark, logo, blurry, deformed, extra limbs, photorealistic',
          seed: 7,
          width: 1280,
          height: 720,
          quality: 'optimized',
          references: [],
          settings: {},
        },
        ctx(current),
      );
      if (sniffMime(img.file.data) !== 'image/png' && sniffMime(img.file.data) !== 'image/jpeg')
        throw new AppError('VALIDATION_FAILED', 'The image is not a valid PNG/JPEG.');
      files.image = Buffer.from(img.file.data);
      const imgKey = await save(`test_image.${img.file.ext}`, files.image);
      this.set(id, current, 'PASS', `${img.model} · ${img.generationSeconds.toFixed(1)} s · ${imgKey}`);

      current = S['Image validated (decodes, size, not blank, not black)'];
      if (!ff) this.set(id, current, 'BLOCKED', 'FFmpeg is not installed on this computer (System Health).');
      else this.set(id, current, 'PASS', await this.checkImage(ff, work, files.image, img.file.ext));

      current = S['Real image animated (AI image-to-video)'];
      this.set(id, current, 'RUNNING', `animating with ${p.models.video}`);
      const clip = await providers.video.animate(
        {
          image: files.image,
          imageStorageKey: imgKey,
          motionPrompt: MOTION,
          negativePrompt: 'static, frozen, distorted, flicker',
          seed: 7,
          durationSec: 5,
          fps: 30,
          width: 1280,
          height: 720,
          quality: 'optimized',
          references: [],
          motionStrength: 0.6,
          cameraMovement: 'slow push-in',
          settings: {},
        },
        ctx(current),
      );
      const worker = clip.settings['worker'] as Record<string, unknown> | undefined;
      if (worker?.['still_motion'] === true)
        throw new AppError(
          'VALIDATION_FAILED',
          'The clip was made by the still-image camera move (not AI animation), so this step does not pass.',
        );
      files.clip = Buffer.from(clip.file.data);
      const clipKey = await save('test_clip.mp4', files.clip);
      this.set(
        id,
        current,
        'PASS',
        `${clip.model} · ${clip.file.durationSec ?? '?'} s · ${clip.generationSeconds.toFixed(1)} s to make · ${clipKey}`,
      );

      current = S['Motion validated (duration, frames, moves, not black)'];
      if (!ff) this.set(id, current, 'BLOCKED', 'FFmpeg is not installed on this computer (System Health).');
      else {
        // A frozen or black "animation" fails here, but the voices are still tested (their result
        // is independent and the GPU is already paid for).
        const motion = await this.checkMotion(ff, work, files.clip).then(
          (d) => ({ ok: true, d }),
          (e: unknown) => ({ ok: false, d: toAppError(e).message }),
        );
        this.set(id, current, motion.ok ? 'PASS' : 'FAIL', motion.d);
        if (!motion.ok) error = motion.d;
      }

      current = S['Real English narration'];
      this.set(id, current, 'RUNNING', `speaking with ${p.models.tts}`);
      const voice = await providers.tts.synthesize(
        {
          text: ENGLISH_LINE,
          language: 'en',
          emotion: 'curious',
          speed: 1,
          voice: {
            voiceModel: p.models.tts,
            voiceIdentity: '',
            presentation: 'female',
            pitch: 0,
            speed: 1,
            speakingStyle: 'young explorer, curious',
          },
          seed: 7,
        },
        ctx(current),
      );
      files.audio = Buffer.from(voice.file.data);
      const enKey = await save(`test_english_voice.${voice.file.ext}`, files.audio);
      this.set(
        id,
        current,
        'PASS',
        `${voice.model} · ${voice.file.durationSec?.toFixed(1) ?? '?'} s · "${ENGLISH_LINE}" · ${enKey}`,
      );

      // Hinglish: a Hindi voice reading Roman Hinglish, sent in mixed script (Hindi words in
      // Devanagari → the Hindi phonemizer; English words stay English). Its failure does not stop
      // the English result.
      const hiStep = S['Real Hinglish narration (Hindi voice)'];
      this.set(id, hiStep, 'RUNNING', `speaking Hinglish with ${p.models.tts}`);
      const spoken = speechText(HINGLISH_LINE);
      try {
        const hi = await providers.tts.synthesize(
          {
            text: spoken,
            language: HINGLISH,
            emotion: 'curious',
            speed: 1,
            voice: {
              voiceModel: p.models.tts,
              voiceIdentity: 'kokoro:hf_alpha',
              presentation: 'female',
              pitch: 0,
              speed: 1,
              speakingStyle: 'young explorer, curious',
            },
            seed: 7,
          },
          ctx(hiStep),
        );
        files.audioHi = Buffer.from(hi.file.data);
        const hiKey = await save(`test_hinglish_voice.${hi.file.ext}`, files.audioHi);
        this.set(
          id,
          hiStep,
          'PASS',
          `${hi.model} · hf_alpha · ${hi.file.durationSec?.toFixed(1) ?? '?'} s · captions "${HINGLISH_LINE}" · spoken as "${spoken}" · ${hiKey}`,
        );
      } catch (err) {
        const e = toAppError(err);
        if (e.code === 'CANCELLED' || signal.aborted) throw e;
        this.set(id, hiStep, 'FAIL', e.message);
        error = error ?? e.message;
      }
      // The exact model commits the worker used (non-secret), so this run documents them.
      const revs = await this.d.cloud.bridge.client
        ?.system()
        .then((x) => x.model_revisions ?? {})
        .catch(() => ({}));
      if (revs && Object.keys(revs).length) {
        const key = await save(
          'model-revisions.txt',
          Buffer.from(
            `${Object.entries(revs)
              .map(([k, v]) => `${k} ${v}`)
              .join('\n')}\n`,
          ),
        );
        const cuda = this.get(id).steps.find((x) => x.n === S['CUDA verified by the worker'])!;
        this.set(id, cuda.n, cuda.status, `${cuda.detail} · model commits recorded (${key})`);
      }
    } catch (err) {
      const e = toAppError(err);
      const cancelled = signal.aborted || e.code === 'CANCELLED';
      error = cancelled ? 'cancelled by you' : e.message;
      this.set(id, current, cancelled ? 'NOT TESTED' : 'FAIL', cancelled ? 'cancelled by you' : e.message);
    } finally {
      // --- terminate as soon as the GPU work is done (success, failure, cancel or timeout) -------
      await this.reportCleanup(id, instanceId, error, S['GPU terminated (billing stopped)']);
    }

    // --- local part: both MP4s from the SAME clip, then ffprobe and a full decode -----------------
    if (files.clip && files.audio) {
      if (!ff) {
        this.set(
          id,
          S['English MP4 built (test_english.mp4)'],
          'BLOCKED',
          'FFmpeg is not installed on this computer (System Health).',
        );
        error = error ?? 'FFmpeg missing';
      } else {
        try {
          outputKey = await this.buildAndCheck(id, ff, work, files.clip, files.audio, files.audioHi ?? null);
        } catch (err) {
          error = error ?? toAppError(err).message;
        }
      }
    }
    rmSync(work, { recursive: true, force: true });
    const inst = instanceId ? this.d.gpuRepo.get(instanceId) : null;
    const runtime = inst
      ? Math.round(
          (new Date(inst.terminated_at ?? this.d.clock.now().toISOString()).getTime() -
            new Date(inst.created_at).getTime()) /
            1000,
        )
      : 0;
    const cost = inst ? Math.round(this.d.gpu.sessionSpendInr(inst) * 100) / 100 : 0;
    const automated = this.get(id).steps.filter((x) => !(REVIEW_STEPS as readonly string[]).includes(x.name));
    const allPass = automated.every((x) => x.status === 'PASS');
    this.d.logger.info('real mode test finished', { test: id, pass: allPass, runtime, cost });
    return this.finish(id, signal.aborted ? 'cancelled' : allPass ? 'success' : 'failed', {
      output_key: outputKey,
      runtime_sec: runtime,
      cost_inr: cost,
      error_message: error,
    });
  }

  /** The consistency test: canonical reference → 12 reference-conditioned shots → contact sheet. */
  private async executeConsistency(p: Prepared, signal: AbortSignal): Promise<MilestoneRecord> {
    const { id } = p;
    let instanceId: string | null = null;
    let error: string | null = null;
    let current = C['Real GPU provisioned'];
    mkdirSync(this.d.tempDir, { recursive: true });
    const work = mkdtempSync(join(this.d.tempDir, 'consistency-'));
    const ff = this.d.ffmpeg;
    const made: Array<{ label: string; key: string; file: string }> = [];
    const strength = this.d.referenceStrength();
    try {
      this.set(id, current, 'RUNNING', `renting ${p.plan.offer.gpuModel}`);
      const session = await this.d.gpu.start(p.plan, { purpose: 'test', signal });
      instanceId = session.id;
      this.d.db.update('cloud_tests', id, {
        gpu_instance_id: instanceId,
        gpu_model: session.instance.gpu_model,
      });
      const inst = this.d.gpuRepo.get(instanceId);
      this.set(id, current, 'PASS', `${inst.gpu_model} · pod ${inst.provider_instance_id}`);
      current = C['Real worker healthy'];
      const client = this.d.cloud.bridge.client;
      if (!client) throw new AppError('WORKER_UNAVAILABLE', 'The worker was not bound after start-up.');
      const health = await client.health();
      const system = await client.system();
      this.set(id, current, 'PASS', `worker ${system.worker_version} · ${health.status}`);
      current = C['CUDA verified by the worker'];
      if (!system.gpu.available || !system.torch?.cuda_available)
        throw new AppError(
          'CUDA_FAILURE',
          `The worker cannot use CUDA (${system.gpu.reason ?? 'PyTorch reports no CUDA'}).`,
        );
      const g = system.gpu.gpus[0];
      this.set(
        id,
        current,
        'PASS',
        `${g?.name ?? 'GPU'} · ${g ? Math.round(g.vram_total_mb / 1024) : '?'} GB VRAM · PyTorch ${system.torch?.version ?? '?'}`,
      );
      session.setState('GENERATING', 'Character consistency test');
      const image = this.d.cloud.bridge.providers().image;
      if (image.info.isMock)
        throw new AppError('VALIDATION_FAILED', 'The worker offers a placeholder image model.');
      const ctx = (step: number, k: string): RunContext => ({
        attemptKey: `consistency:${id}:${k}`,
        signal,
        onProgress: (x) => {
          if (x.status === 'loading_model')
            this.set(id, step, 'RUNNING', `loading the model (first run downloads it) ${x.message}`);
        },
      });
      const style =
        "bright premium stylized 3D children's animation, consistent character design, vibrant colours";
      const negative =
        'text, watermark, logo, blurry, deformed, extra limbs, different character, photorealistic';

      current = C['Canonical reference generated'];
      this.set(id, current, 'RUNNING', `drawing the reference with ${p.models.image}`);
      const ref = await image.generate(
        {
          mode: 'text_to_image',
          prompt: `${TEST_CHARACTER}, character reference, front view, full body, neutral pose, plain light grey background, ${style}`,
          negativePrompt: negative,
          seed: 11,
          width: 1024,
          height: 1024,
          quality: 'optimized',
          references: [],
          settings: {},
        },
        ctx(current, 'ref'),
      );
      const refData = Buffer.from(ref.file.data);
      const refKey = `real-tests/${id}/reference.${ref.file.ext}`;
      await this.d.storage.put(refKey, refData);
      const refFile = join(work, `00_reference.${ref.file.ext}`);
      writeFileSync(refFile, refData);
      made.push({ label: 'canonical reference', key: refKey, file: refFile });
      this.set(id, current, 'PASS', `${ref.model} · ${ref.generationSeconds.toFixed(1)} s · ${refKey}`);

      current = C['12 shots generated from the reference'];
      for (const [i, [label, shot]] of CONSISTENCY_SHOTS.entries()) {
        this.set(id, current, 'RUNNING', `${i}/${CONSISTENCY_SHOTS.length} done · now: ${label}`);
        const res = await image.generate(
          {
            mode: strength > 0 ? 'image_to_image' : 'text_to_image',
            ...(strength > 0 ? { initImage: refData, strength } : {}),
            referenceImages: [refData],
            prompt: `${TEST_CHARACTER}, ${shot}, ${style}`,
            negativePrompt: negative,
            seed: 100 + i,
            width: 1024,
            height: 1024,
            quality: 'optimized',
            references: [],
            settings: {},
          },
          ctx(current, `shot${i}`),
        );
        const n = String(i + 1).padStart(2, '0');
        const key = `real-tests/${id}/shot_${n}.${res.file.ext}`;
        const data = Buffer.from(res.file.data);
        await this.d.storage.put(key, data);
        const file = join(work, `${n}_shot.${res.file.ext}`);
        writeFileSync(file, data);
        made.push({ label, key, file });
      }
      this.set(
        id,
        current,
        'PASS',
        `${CONSISTENCY_SHOTS.length} shots · image-to-image from the reference at strength ${strength} (Settings → Generation) + the reference as an image prompt where the model supports one`,
      );

      current = C['Every shot validated (decodes, not blank, not black)'];
      if (!ff) this.set(id, current, 'BLOCKED', 'FFmpeg is not installed on this computer (System Health).');
      else {
        const bad: string[] = [];
        for (const m of made) {
          const data = readFileSync(m.file);
          await this.checkImage(ff, work, data, m.file.split('.').pop() ?? 'png').catch((e: unknown) => {
            bad.push(`${m.label}: ${toAppError(e).message}`);
          });
        }
        this.set(
          id,
          current,
          bad.length ? 'FAIL' : 'PASS',
          bad.length ? bad.join(' | ') : `${made.length} pictures decode, none blank or black`,
        );
        if (bad.length) error = bad[0]!;
      }
    } catch (err) {
      const e = toAppError(err);
      const cancelled = signal.aborted || e.code === 'CANCELLED';
      error = cancelled ? 'cancelled by you' : e.message;
      this.set(id, current, cancelled ? 'NOT TESTED' : 'FAIL', cancelled ? 'cancelled by you' : e.message);
    } finally {
      await this.reportCleanup(id, instanceId, error, C['GPU terminated (billing stopped)']);
    }

    if (made.length === CONSISTENCY_SHOTS.length + 1) {
      const step = C['Contact sheet built'];
      if (!ff) this.set(id, step, 'BLOCKED', 'FFmpeg is not installed on this computer (System Health).');
      else {
        try {
          // Same-size tiles in order (reference first), 5 × 3, white gaps: one picture to compare.
          for (const [i, m] of made.entries())
            await runTool(ff.ffmpeg, [
              '-y',
              '-v',
              'error',
              '-i',
              m.file,
              '-vf',
              'scale=384:384:force_original_aspect_ratio=decrease,pad=384:384:(ow-iw)/2:(oh-ih)/2:color=white',
              '-frames:v',
              '1',
              join(work, `tile_${String(i).padStart(2, '0')}.png`),
            ]);
          const sheet = join(work, 'contact_sheet.png');
          await runTool(ff.ffmpeg, [
            '-y',
            '-v',
            'error',
            '-framerate',
            '1',
            '-i',
            join(work, 'tile_%02d.png'),
            '-vf',
            'tile=5x3:padding=8:margin=8:color=white',
            '-frames:v',
            '1',
            sheet,
          ]);
          const key = `real-tests/${id}/contact_sheet.png`;
          await this.d.storage.put(key, readFileSync(sheet));
          this.set(
            id,
            step,
            'PASS',
            `reference + ${CONSISTENCY_SHOTS.length} shots · ${this.d.storage.localPath(key)}`,
          );
        } catch (err) {
          this.set(id, step, 'FAIL', toAppError(err).message);
          error = error ?? toAppError(err).message;
        }
      }
    }
    rmSync(work, { recursive: true, force: true });
    const inst = instanceId ? this.d.gpuRepo.get(instanceId) : null;
    const cost = inst ? Math.round(this.d.gpu.sessionSpendInr(inst) * 100) / 100 : 0;
    const runtime = inst
      ? Math.round(
          (new Date(inst.terminated_at ?? this.d.clock.now().toISOString()).getTime() -
            new Date(inst.created_at).getTime()) /
            1000,
        )
      : 0;
    const automated = this.get(id).steps.filter((x) => !x.name.startsWith('Your review'));
    const allPass = automated.every((x) => x.status === 'PASS');
    this.d.logger.info('consistency test finished', { test: id, pass: allPass, runtime, cost });
    return this.finish(id, signal.aborted ? 'cancelled' : allPass ? 'success' : 'failed', {
      output_key: made.length === CONSISTENCY_SHOTS.length + 1 ? `real-tests/${id}/contact_sheet.png` : null,
      runtime_sec: runtime,
      cost_inr: cost,
      error_message: error,
    });
  }

  /** The files of a consistency run, in order: the reference, then the 12 shots. */
  consistencyImages(id: string): Array<{ label: string; key: string }> {
    const find = (base: string) =>
      ['png', 'jpg']
        .map((e) => `real-tests/${id}/${base}.${e}`)
        .find((k) => existsSync(this.d.storage.localPath(k)));
    const out: Array<{ label: string; key: string }> = [];
    const ref = find('reference');
    if (ref) out.push({ label: 'canonical reference', key: ref });
    CONSISTENCY_SHOTS.forEach(([label], i) => {
      const k = find(`shot_${String(i + 1).padStart(2, '0')}`);
      if (k) out.push({ label, key: k });
    });
    return out;
  }

  /** GPU clean-up, reported honestly also when the start failed and the supervisor cleaned up. */
  private async reportCleanup(
    id: string,
    instanceId: string | null,
    error: string | null,
    step: number,
  ): Promise<void> {
    if (instanceId) {
      const ok = await this.d.gpu.terminate(instanceId, error ? 'test_cleanup' : 'test_complete');
      this.set(
        id,
        step,
        ok ? 'PASS' : 'FAIL',
        ok ? 'terminated' : 'termination failed: the watchdog keeps retrying; use EMERGENCY STOP GPU',
      );
      return;
    }
    // The start failed (e.g. the worker never became healthy): the supervisor terminates what it
    // rented itself. Report that honestly instead of "nothing ran".
    const since = this.get(id).started_at;
    const rented = this.d.gpuRepo.list(20).filter((g) => g.created_at >= since);
    const left = rented.filter((g) => g.status !== 'terminated');
    if (!rented.length) this.set(id, step, 'NOT TESTED', 'no GPU was rented');
    else
      this.set(
        id,
        step,
        left.length ? 'FAIL' : 'PASS',
        left.length
          ? `${left.length} GPU(s) still ${left.map((g) => g.status).join(', ')}: the watchdog keeps retrying; use EMERGENCY STOP GPU`
          : `${rented.length} GPU(s) rented during start-up, all terminated (${rented.map((g) => g.termination_reason ?? 'terminated').join(', ')})`,
      );
  }

  /** A person's verdict after watching / listening (review steps only, after the run). */
  review(
    id: string,
    step: number,
    verdict: 'PASS' | 'FAIL' | 'NEEDS IMPROVEMENT',
    note: string,
  ): MilestoneRecord {
    const rec = this.get(id);
    const st = rec.steps.find((x) => x.n === step);
    if (!st || !st.name.startsWith('Your review'))
      throw new AppError('VALIDATION_FAILED', 'Only the review steps are decided by you.');
    if (verdict === 'NEEDS IMPROVEMENT' && rec.kind !== 'consistency')
      throw new AppError('VALIDATION_FAILED', 'Choose PASS or FAIL.');
    if (rec.status === 'running') throw new AppError('CONFLICT', 'Wait for the test to finish.');
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, 300);
    this.set(id, step, verdict, `reviewed by you${clean ? `: ${clean}` : ''}`);
    return this.get(id);
  }

  /** REAL-AI VERIFIED: every automated step and every review step passed. */
  verified(rec: MilestoneRecord): boolean {
    return rec.status === 'success' && rec.steps.every((x) => x.status === 'PASS');
  }

  private async ffprobeJson(ff: FfmpegTools, file: string, extra: string[] = []): Promise<FfprobeResult> {
    return JSON.parse(
      (
        await runTool(ff.ffprobe, [
          '-v',
          'error',
          ...extra,
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          file,
        ])
      ).stdout,
    ) as FfprobeResult;
  }

  /** Luma statistics of the first frame: blank (one flat colour) and black pictures are rejected. */
  private async lumaStats(
    ff: FfmpegTools,
    file: string,
    seek?: number,
  ): Promise<{ min: number; max: number; avg: number }> {
    const out = await runTool(ff.ffmpeg, [
      '-v',
      'info',
      ...(seek !== undefined ? ['-ss', seek.toFixed(2)] : []),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'signalstats,metadata=mode=print',
      '-f',
      'null',
      '-',
    ]);
    const v = (k: string) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(out.stderr)?.[1] ?? NaN);
    return { min: v('YMIN'), max: v('YMAX'), avg: v('YAVG') };
  }

  private async checkImage(ff: FfmpegTools, work: string, data: Buffer, ext: string): Promise<string> {
    const file = join(work, `image.${ext}`);
    writeFileSync(file, data);
    const probe = await this.ffprobeJson(ff, file);
    const v = probe.streams.find((x) => x['codec_type'] === 'video');
    const w = Number(v?.['width']);
    const h = Number(v?.['height']);
    if (!v || !(w >= 256 && h >= 256))
      throw new AppError('VALIDATION_FAILED', `The image does not decode to a usable picture (${w}×${h}).`);
    const y = await this.lumaStats(ff, file);
    if (!Number.isFinite(y.avg)) throw new AppError('VALIDATION_FAILED', 'The image could not be analysed.');
    if (y.avg < 20)
      throw new AppError('VALIDATION_FAILED', `The image is black (average brightness ${y.avg}).`);
    if (y.max - y.min < 24)
      throw new AppError(
        'VALIDATION_FAILED',
        `The image is blank: one flat colour (brightness ${y.min}–${y.max}).`,
      );
    return `${v['codec_name']} ${w}×${h}${w !== 1280 || h !== 720 ? ' (asked for 1280×720)' : ''} · ${data.length} bytes · brightness ${y.min}–${y.max}, average ${y.avg.toFixed(0)}`;
  }

  private async checkMotion(ff: FfmpegTools, work: string, data: Buffer): Promise<string> {
    const file = join(work, 'clip.mp4');
    writeFileSync(file, data);
    const probe = await this.ffprobeJson(ff, file, ['-count_frames']);
    const v = probe.streams.find((x) => x['codec_type'] === 'video');
    const frames = Number(v?.['nb_read_frames']);
    const dur = Number(probe.format.duration);
    if (!v || !(frames > 1)) throw new AppError('VALIDATION_FAILED', 'The clip has no video frames.');
    if (!(dur >= 2)) throw new AppError('VALIDATION_FAILED', `The clip is too short (${dur} s).`);
    const decode = await runTool(ff.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    if (decode.stderr.trim())
      throw new AppError(
        'VALIDATION_FAILED',
        `The clip does not decode cleanly: ${decode.stderr.trim().slice(0, 200)}`,
      );
    // Movement: a freeze covering (almost) the whole clip means the "animation" does not move.
    const freeze = await runTool(ff.ffmpeg, [
      '-v',
      'info',
      '-i',
      file,
      '-vf',
      `freezedetect=n=0.003:d=${Math.max(0.5, dur - 0.3).toFixed(2)}`,
      '-f',
      'null',
      '-',
    ]);
    if (/freeze_start/.test(freeze.stderr))
      throw new AppError('VALIDATION_FAILED', 'The animated clip does not move (frozen picture).');
    const y = await this.lumaStats(ff, file, dur / 2);
    if (y.avg < 20) throw new AppError('VALIDATION_FAILED', 'The animated clip is black.');
    return `${v['codec_name']} ${v['width']}×${v['height']} · ${frames} frames · ${dur.toFixed(2)} s · ${v['avg_frame_rate']} fps · moves (no full-length freeze) · mid-frame brightness ${y.avg.toFixed(0)}`;
  }

  /** FFmpeg: the SAME clip under each narration → test_english.mp4 / test_hinglish.mp4, then check both. */
  private async buildAndCheck(
    id: string,
    ff: FfmpegTools,
    work: string,
    clip: Buffer,
    en: Buffer,
    hi: Buffer | null,
  ): Promise<string> {
    const clipPath = join(work, 'clip.mp4');
    writeFileSync(clipPath, clip);
    const duration = async (file: string): Promise<number> =>
      Number(
        (
          await runTool(ff.ffprobe, [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            file,
          ])
        ).stdout.trim(),
      );
    const clipSec = await duration(clipPath);
    const build = async (name: string, audio: Buffer): Promise<{ file: string; total: number }> => {
      const audioPath = join(work, `${name}.wav`);
      writeFileSync(audioPath, audio);
      const voiceSec = await duration(audioPath);
      if (!(clipSec > 0.5))
        throw new AppError('VALIDATION_FAILED', `The clip is not a playable video (${clipSec} s).`);
      if (!(voiceSec > 0.5))
        throw new AppError('VALIDATION_FAILED', `The narration is not playable audio (${voiceSec} s).`);
      const total = Math.max(clipSec, voiceSec + 0.5);
      const out = join(work, `${name}.mp4`);
      await runTool(ff.ffmpeg, [
        '-y',
        '-v',
        'error',
        '-stream_loop',
        '-1',
        '-i',
        clipPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p',
        '-af',
        'apad,aresample=48000',
        '-t',
        total.toFixed(2),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        out,
      ]);
      return { file: out, total };
    };
    const outputs: Array<{ name: string; file: string; total: number; key: string }> = [];
    for (const [name, audio, step] of [
      ['test_english', en, S['English MP4 built (test_english.mp4)']],
      ['test_hinglish', hi, S['Hinglish MP4 built from the same clip (test_hinglish.mp4)']],
    ] as const) {
      if (!audio) {
        this.set(id, step, 'NOT TESTED', 'no Hinglish narration to combine');
        continue;
      }
      try {
        const r = await build(name, audio);
        const key = `real-tests/${id}/${name}.mp4`;
        await this.d.storage.put(key, readFileSync(r.file));
        outputs.push({ name, ...r, key });
        this.set(
          id,
          step,
          'PASS',
          `${r.total.toFixed(1)} s · the same clip (${clipSec.toFixed(1)} s, looped if needed) · ${this.d.storage.localPath(key)}`,
        );
      } catch (err) {
        this.set(id, step, 'FAIL', toAppError(err).message);
        throw err;
      }
    }
    let step = S['FFprobe: H.264/AAC, 1920×1080, 30 fps (both)'];
    try {
      const details: string[] = [];
      for (const o of outputs) {
        const probe = await this.ffprobeJson(ff, o.file);
        const v = probe.streams.find((x) => x['codec_type'] === 'video');
        const a = probe.streams.find((x) => x['codec_type'] === 'audio');
        const problems: string[] = [];
        if (v?.['codec_name'] !== 'h264') problems.push(`video codec ${v?.['codec_name'] ?? 'missing'}`);
        if (a?.['codec_name'] !== 'aac') problems.push(`audio codec ${a?.['codec_name'] ?? 'missing'}`);
        if (v?.['width'] !== 1920 || v?.['height'] !== 1080)
          problems.push(`size ${v?.['width']}×${v?.['height']}`);
        if (v?.['avg_frame_rate'] !== '30/1') problems.push(`frame rate ${v?.['avg_frame_rate']}`);
        if (Math.abs(Number(probe.format.duration) - o.total) > 0.4)
          problems.push(`duration ${probe.format.duration} s`);
        if (problems.length)
          throw new AppError('VALIDATION_FAILED', `${o.name}.mp4 is not right: ${problems.join(', ')}.`);
        details.push(
          `${o.name}.mp4: h264 1920×1080 30 fps + aac ${a?.['sample_rate']} Hz · ${Number(probe.format.duration).toFixed(2)} s`,
        );
      }
      this.set(
        id,
        step,
        outputs.length === 2 ? 'PASS' : 'FAIL',
        `${details.join(' | ')}${outputs.length < 2 ? ' | test_hinglish.mp4 missing' : ''}`,
      );
      step = S['Playback: full decode of both MP4s'];
      for (const o of outputs) {
        const decode = await runTool(ff.ffmpeg, ['-v', 'error', '-i', o.file, '-f', 'null', '-']);
        if (decode.stderr.trim())
          throw new AppError(
            'VALIDATION_FAILED',
            `${o.name}.mp4 reported decode errors: ${decode.stderr.trim().slice(0, 300)}`,
          );
      }
      this.set(
        id,
        step,
        outputs.length === 2 ? 'PASS' : 'FAIL',
        `${outputs.map((o) => `${o.name}.mp4`).join(' and ')} decoded end to end without errors${outputs.length < 2 ? '; the Hinglish MP4 is missing' : ''}`,
      );
      return outputs[0]!.key;
    } catch (err) {
      const e = toAppError(err);
      this.set(id, step, 'FAIL', e.message);
      throw e;
    }
  }
}

interface FfprobeResult {
  streams: Array<Record<string, string | number>>;
  format: { duration: string };
}
