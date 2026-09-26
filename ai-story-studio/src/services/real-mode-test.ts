import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { ModelManager } from './model-manager.ts';

/**
 * MILESTONE 1 — the Real Mode Test (Settings → AI Engine → RUN REAL MODE TEST).
 *
 *   RUNPOD CONNECTED → REAL GPU PROVISIONED → REAL WORKER HEALTHY → CUDA → REAL IMAGE →
 *   REAL IMAGE ANIMATED → REAL NARRATION → GPU TERMINATED → AUDIO+VIDEO COMBINED →
 *   SHORT MP4 VALIDATED → PLAYS
 *
 * Every step is executed for real and reported as PASS / FAIL / BLOCKED / NOT TESTED. Nothing is
 * rented until the user confirms the GPU and price. The GPU is terminated as soon as the GPU work
 * is done (and in `finally` whatever happens); combining and checking run locally with FFmpeg.
 * A clip made by the worker's non-AI still-image camera move is NOT a pass for "animated".
 */
export type MilestoneStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT TESTED' | 'RUNNING';

export interface MilestoneStep {
  n: number;
  name: string;
  status: MilestoneStatus;
  detail: string;
  at: string | null;
}

export interface MilestoneRecord {
  id: string;
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
  'RunPod API connected',
  'AI worker available to RunPod',
  'GPU chosen (compatibility first) and price shown',
  'Your confirmation',
  'Real GPU provisioned',
  'Real worker healthy',
  'CUDA verified on the GPU',
  'Real image generated',
  'Real image animated (AI image-to-video)',
  'Real narration generated',
  'GPU terminated (billing stopped)',
  'Audio + video combined',
  'Short MP4 validated (H.264/AAC, 1920×1080, 30 fps)',
  'MP4 plays (full decode, moving picture, not black)',
] as const;

const S = Object.fromEntries(MILESTONE_STEPS.map((name, i) => [name, i + 1])) as Record<
  (typeof MILESTONE_STEPS)[number],
  number
>;

const PROMPT =
  'a friendly fox cub with orange fur and a green scarf waving hello in a sunny forest clearing, 3D animated children’s film style, soft light, vibrant colours';
const NARRATION =
  'Hello! My name is Milo. Today I am going on a big adventure in the forest. Will you come with me?';

type TestRow = Omit<MilestoneRecord, 'steps'> & { steps_json: string; test_kind: string };

interface Prepared {
  id: string;
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
    if (!r || r.test_kind !== 'milestone1') throw new AppError('NOT_FOUND', 'Real Mode Test not found');
    const { steps_json, test_kind: _k, ...rest } = r;
    return { ...rest, steps: parseJson<MilestoneStep[]>(steps_json, []) };
  }

  latest(): MilestoneRecord | null {
    const row = this.d.db.get<{ id: string }>(
      "SELECT id FROM cloud_tests WHERE test_kind = 'milestone1' ORDER BY started_at DESC LIMIT 1",
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
  async prepare(): Promise<{ record: MilestoneRecord; ready: boolean }> {
    const id = newId('ctest');
    const steps: MilestoneStep[] = MILESTONE_STEPS.map((name, i) => ({
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
      test_kind: 'milestone1',
      steps_json: JSON.stringify(steps),
      started_at: this.d.clock.now().toISOString(),
    });
    try {
      try {
        this.d.cloud.assertCanProvision();
      } catch (err) {
        this.set(id, S['RunPod API connected'], 'BLOCKED', toAppError(err).message);
        return {
          record: this.finish(id, 'failed', { error_message: toAppError(err).message }),
          ready: false,
        };
      }
      if (this.d.gpu.currentProvider !== this.d.cloud.provider) this.d.cloud.refresh();
      const conn = await this.d.cloud.testConnection();
      if (!conn.ok) {
        this.set(id, S['RunPod API connected'], 'FAIL', conn.detail);
        return { record: this.finish(id, 'failed', { error_message: conn.detail }), ready: false };
      }
      this.set(id, S['RunPod API connected'], 'PASS', conn.detail);
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
      const vid = pick('video');
      const tts = pick('tts');
      const plan = await this.d.gpu.plan(Math.max(img.minVramGb, vid.minVramGb, tts.minVramGb), 1500, {
        recommendedVramGb: Math.max(img.recommendedVramGb, vid.recommendedVramGb, tts.recommendedVramGb),
      });
      this.set(
        id,
        S['GPU chosen (compatibility first) and price shown'],
        'PASS',
        `${plan.offer.gpuModel} (${plan.offer.vramGb} GB) at ₹${plan.offer.hourlyRateInr}/h — ${plan.reasons.join('; ')}. Estimated ₹${plan.estimatedCostInr.toFixed(2)} (worst case ₹${plan.estimatedMaxCostInr.toFixed(2)}). Models: ${img.name}, ${vid.name}, ${tts.name}.${plan.alternatives.length ? ` Fallbacks: ${plan.alternatives.map((a) => a.gpuModel).join(', ')}.` : ''}`,
      );
      this.set(id, S['Your confirmation'], 'RUNNING', 'waiting for you — nothing has been rented yet');
      this.d.db.update('cloud_tests', id, {
        gpu_model: plan.offer.gpuModel,
        hourly_rate_inr: plan.offer.hourlyRateInr,
      });
      this.prepared.set(id, { id, plan, models: { image: img.id, video: vid.id, tts: tts.id } });
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
    this.running = this.execute(p, abort.signal).finally(() => {
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
    const files: { image?: Buffer; clip?: Buffer; audio?: Buffer } = {};
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
      this.set(id, current, 'PASS', `worker ${system.worker_version} · ${health.status}`);
      current = S['CUDA verified on the GPU'];
      const g = system.gpu.gpus[0];
      if (!system.gpu.available || !system.torch?.cuda_available)
        throw new AppError(
          'CUDA_FAILURE',
          `The worker cannot use CUDA (${system.gpu.reason ?? (system.torch?.error || 'PyTorch reports no CUDA')}).`,
        );
      this.set(
        id,
        current,
        'PASS',
        `${g?.name ?? 'GPU'} · ${g ? Math.round(g.vram_total_mb / 1024) : '?'} GB VRAM · CUDA ${system.gpu.cuda_version ?? '?'} · PyTorch ${system.torch?.version ?? '?'}`,
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

      current = S['Real image generated'];
      this.set(id, current, 'RUNNING', `drawing with ${p.models.image}`);
      const img = await providers.image.generate(
        {
          mode: 'text_to_image',
          prompt: PROMPT,
          negativePrompt: 'text, watermark, blurry, deformed',
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
      const imgKey = `real-tests/${id}/image.${img.file.ext}`;
      await this.d.storage.put(imgKey, files.image);
      this.set(
        id,
        current,
        'PASS',
        `${img.model} · ${img.file.width ?? '?'}×${img.file.height ?? '?'} · ${img.generationSeconds.toFixed(1)} s`,
      );

      current = S['Real image animated (AI image-to-video)'];
      this.set(id, current, 'RUNNING', `animating with ${p.models.video}`);
      const clip = await providers.video.animate(
        {
          image: files.image,
          imageStorageKey: imgKey,
          motionPrompt: 'the fox cub waves and smiles, leaves drift in the breeze, gentle camera push-in',
          negativePrompt: 'static, frozen, distorted',
          seed: 7,
          durationSec: 4,
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
      this.set(
        id,
        current,
        'PASS',
        `${clip.model} · ${clip.file.durationSec ?? '?'} s · ${clip.generationSeconds.toFixed(1)} s to make`,
      );

      current = S['Real narration generated'];
      this.set(id, current, 'RUNNING', `speaking with ${p.models.tts}`);
      const voice = await providers.tts.synthesize(
        {
          text: NARRATION,
          language: 'en',
          emotion: 'happy',
          speed: 1,
          voice: {
            voiceModel: p.models.tts,
            voiceIdentity: '',
            presentation: 'female',
            pitch: 0,
            speed: 1,
            speakingStyle: 'warm storyteller',
          },
          seed: 7,
        },
        ctx(current),
      );
      files.audio = Buffer.from(voice.file.data);
      this.set(
        id,
        current,
        'PASS',
        `${voice.model} · ${voice.file.durationSec?.toFixed(1) ?? '?'} s of speech`,
      );
    } catch (err) {
      const e = toAppError(err);
      error = e.message;
      this.set(id, current, e.code === 'CANCELLED' ? 'NOT TESTED' : 'FAIL', e.message);
    } finally {
      // --- terminate as soon as the GPU work is done -------------------------------------------
      const t = S['GPU terminated (billing stopped)'];
      if (instanceId) {
        const ok = await this.d.gpu.terminate(instanceId, error ? 'test_cleanup' : 'test_complete');
        this.set(
          id,
          t,
          ok ? 'PASS' : 'FAIL',
          ok ? 'terminated' : 'termination failed: the watchdog keeps retrying; use EMERGENCY STOP GPU',
        );
      } else this.set(id, t, 'NOT TESTED', 'no GPU was running');
    }

    // --- local part: combine, validate, play ------------------------------------------------------
    if (!error && files.clip && files.audio) {
      const ff = this.d.ffmpeg;
      const combine = S['Audio + video combined'];
      if (!ff) {
        this.set(id, combine, 'BLOCKED', 'FFmpeg is not installed on this computer (System Health).');
        error = 'FFmpeg missing';
      } else {
        try {
          outputKey = await this.combineAndCheck(id, ff, work, files.clip, files.audio);
        } catch (err) {
          error = toAppError(err).message;
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
    const allPass = this.get(id).steps.every((x) => x.status === 'PASS');
    this.d.logger.info('real mode test finished', { test: id, pass: allPass, runtime, cost });
    return this.finish(id, signal.aborted ? 'cancelled' : allPass ? 'success' : 'failed', {
      output_key: outputKey,
      runtime_sec: runtime,
      cost_inr: cost,
      error_message: error,
    });
  }

  /** FFmpeg: loop the clip under the narration, encode 1080p30 H.264/AAC, then check it for real. */
  private async combineAndCheck(
    id: string,
    ff: FfmpegTools,
    work: string,
    clip: Buffer,
    audio: Buffer,
  ): Promise<string> {
    const clipPath = join(work, 'clip.mp4');
    const audioPath = join(work, 'narration.wav');
    const out = join(work, 'milestone-short.mp4');
    writeFileSync(clipPath, clip);
    writeFileSync(audioPath, audio);
    let step = S['Audio + video combined'];
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
    try {
      const clipSec = await duration(clipPath);
      const voiceSec = await duration(audioPath);
      if (!(clipSec > 0.5))
        throw new AppError('VALIDATION_FAILED', `The clip is not a playable video (${clipSec} s).`);
      if (!(voiceSec > 0.5))
        throw new AppError('VALIDATION_FAILED', `The narration is not playable audio (${voiceSec} s).`);
      const total = Math.max(clipSec, voiceSec + 0.5);
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
      this.set(
        id,
        step,
        'PASS',
        `${total.toFixed(1)} s (clip ${clipSec.toFixed(1)} s looped under ${voiceSec.toFixed(1)} s of narration)`,
      );

      step = S['Short MP4 validated (H.264/AAC, 1920×1080, 30 fps)'];
      const probe = JSON.parse(
        (await runTool(ff.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]))
          .stdout,
      ) as { streams: Array<Record<string, string | number>>; format: { duration: string } };
      const v = probe.streams.find((x) => x['codec_type'] === 'video');
      const a = probe.streams.find((x) => x['codec_type'] === 'audio');
      const problems: string[] = [];
      if (v?.['codec_name'] !== 'h264') problems.push(`video codec ${v?.['codec_name'] ?? 'missing'}`);
      if (a?.['codec_name'] !== 'aac') problems.push(`audio codec ${a?.['codec_name'] ?? 'missing'}`);
      if (v?.['width'] !== 1920 || v?.['height'] !== 1080)
        problems.push(`size ${v?.['width']}×${v?.['height']}`);
      if (v?.['avg_frame_rate'] !== '30/1') problems.push(`frame rate ${v?.['avg_frame_rate']}`);
      if (Math.abs(Number(probe.format.duration) - total) > 0.4)
        problems.push(`duration ${probe.format.duration} s`);
      if (problems.length)
        throw new AppError('VALIDATION_FAILED', `The MP4 is not right: ${problems.join(', ')}.`);
      this.set(
        id,
        step,
        'PASS',
        `h264 1920×1080 30 fps + aac · ${Number(probe.format.duration).toFixed(1)} s`,
      );

      step = S['MP4 plays (full decode, moving picture, not black)'];
      const decode = await runTool(ff.ffmpeg, ['-v', 'error', '-i', out, '-f', 'null', '-']);
      if (decode.stderr.trim())
        throw new AppError(
          'VALIDATION_FAILED',
          `Decoding reported errors: ${decode.stderr.trim().slice(0, 300)}`,
        );
      // Movement: a freeze covering the whole AI clip means the "animation" does not move.
      const freeze = await runTool(ff.ffmpeg, [
        '-v',
        'info',
        '-t',
        clipSec.toFixed(2),
        '-i',
        clipPath,
        '-vf',
        `freezedetect=n=0.003:d=${Math.max(0.5, clipSec - 0.3).toFixed(2)}`,
        '-f',
        'null',
        '-',
      ]);
      if (/freeze_start/.test(freeze.stderr))
        throw new AppError('VALIDATION_FAILED', 'The animated clip does not move (frozen picture).');
      const black = await runTool(ff.ffmpeg, [
        '-v',
        'info',
        '-i',
        out,
        '-vf',
        'blackdetect=d=0.5:pic_th=0.98',
        '-an',
        '-f',
        'null',
        '-',
      ]);
      const blackSec = [...black.stderr.matchAll(/black_duration:([\d.]+)/g)].reduce(
        (t, m) => t + Number(m[1]),
        0,
      );
      if (blackSec > total * 0.5)
        throw new AppError('VALIDATION_FAILED', `The video is mostly black (${blackSec.toFixed(1)} s).`);
      const key = `real-tests/${id}/milestone-short.mp4`;
      await this.d.storage.put(key, readFileSync(out));
      this.set(
        id,
        step,
        'PASS',
        `decoded without errors; the picture moves; ${blackSec.toFixed(1)} s black · saved to ${this.d.storage.localPath(key)}`,
      );
      return key;
    } catch (err) {
      const e = toAppError(err);
      this.set(id, step, 'FAIL', e.message);
      throw e;
    }
  }
}
