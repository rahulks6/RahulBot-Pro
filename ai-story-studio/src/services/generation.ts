import { NARRATOR_VOICE_NEEDED } from './audio-messages.ts';
import type { StudioCore } from '../app/studio.ts';
import type { JobKind, JobStatus, QualityMode } from '../domain/enums.ts';
import type { GeneratedAsset, GenerationAttempt, GenerationJob, Shot } from '../domain/types.ts';
import { AppError, RETRYABLE_CODES, toAppError, type ErrorCode } from '../lib/errors.ts';
import { seedFrom } from '../lib/hash.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { assertGenerationAllowed } from '../providers/registry.ts';
import type { ModelResult, ProviderInfo, ReferenceInput, RunContext } from '../providers/types.ts';
import { costFor } from '../repositories/gpu.ts';
import { shouldUpscale } from './settings.ts';
import type { AudioOutcome, AudioPipeline } from './audio-pipeline.ts';
import type { GpuSession } from './gpu-supervisor.ts';
import { buildPrompt, type BuiltPrompt, type CastMember } from './prompt-builder.ts';

export interface QueueOptions {
  mode?: QualityMode;
  seed?: number | 'new';
  /** Explicit user request to regenerate an already approved shot/asset. */
  explicit?: boolean;
  params?: Record<string, unknown>;
}

export interface BatchResult {
  batchId: string;
  processed: number;
  completed: number;
  failed: number;
  cancelled: number;
  gpuSessions: number;
  simulatedCostInr: number;
  messages: string[];
}

/** Simulated model-load seconds per model, recorded once per model per GPU session. */
const MODEL_LOAD_SECONDS: Record<string, number> = { image: 25, video: 45, upscale: 12, lipsync: 20 };

const GPU_KINDS: ReadonlySet<JobKind> = new Set(['image', 'video', 'upscale', 'lipsync', 'reference']);

/**
 * Generation queue + runner (spec §18, §35, §36, §39, §69).
 *
 * - Image-first: video jobs require an approved image; a failed video never
 *   triggers image regeneration.
 * - Every attempt (success or failure) is stored; nothing is overwritten.
 * - GPU work is batched: one session per batch, each model loaded once, and
 *   the GPU is terminated in `finally` (completion, failure or cancellation).
 * - Retries are bounded, only for retryable failures, and re-check budget.
 * - Approved assets are never regenerated unless the user explicitly asks.
 */
export { NARRATOR_VOICE_NEEDED };

export class GenerationService {
  private readonly s: StudioCore;
  private readonly audio: AudioPipeline;
  private running = false;
  /** Set by the composition root: the ExecutionRouter's readiness check (restarts a crashed local worker). */
  router: { ensureReady(): Promise<void> } | null = null;

  constructor(core: StudioCore & { audio: AudioPipeline }) {
    this.s = core;
    this.audio = core.audio;
  }

  // ---------------------------------------------------------------------------
  // Prompt context
  // ---------------------------------------------------------------------------

  promptFor(shotId: string): BuiltPrompt {
    const shot = this.s.stories.getShot(shotId);
    const scene = this.s.stories.getScene(shot.scene_id);
    const story = this.s.stories.get(scene.story_id);
    const project = this.s.projects.get(story.project_id);
    const styleId = shot.style_id ?? project.default_style_id;
    const locationId = shot.location_id ?? scene.location_id;
    const location = locationId ? this.s.characters.getLocation(locationId) : null;
    const cast: CastMember[] = this.s.stories.shotCharacters(shot.id).map((sc) => ({
      character: this.s.characters.get(sc.character_id),
      variant: sc.variant_id ? this.s.characters.getVariant(sc.variant_id) : null,
      references: this.s.characters.approvedReferenceKeys(sc.character_id, sc.variant_id),
    }));
    const shots = this.s.stories.listShots(scene.id);
    const idx = shots.findIndex((x) => x.id === shot.id);
    return buildPrompt({
      project,
      scene,
      shot,
      style: styleId ? this.s.projects.getStyle(styleId) : null,
      location,
      cast,
      props: this.s.stories.shotPropIds(shot.id).map((id) => this.s.characters.getProp(id)),
      locationReferences: location
        ? this.s.assets
            .listReferences('location', location.id)
            .filter((r) => r.approved)
            .map((r) => ({ storage_key: r.storage_key, label: `${location.name} ${r.label}` }))
        : [],
      previousShot: idx > 0 ? (shots[idx - 1] ?? null) : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Queueing
  // ---------------------------------------------------------------------------

  private enqueue(
    kind: JobKind,
    target: { type: string; id: string },
    ctx: { projectId: string; storyId?: string | null; shotId?: string | null },
    opts: QueueOptions,
  ): GenerationJob {
    const active = this.s.jobs.findActive(kind, target.id);
    if (active) return active;
    const params: Record<string, unknown> = { ...(opts.params ?? {}) };
    if (opts.seed !== undefined) params['seed'] = opts.seed;
    if (opts.explicit) params['explicit'] = true;
    const job = this.s.jobs.create({
      projectId: ctx.projectId,
      storyId: ctx.storyId ?? null,
      shotId: ctx.shotId ?? null,
      kind,
      targetType: target.type,
      targetId: target.id,
      mode: opts.mode ?? 'optimized',
      params,
      maxAttempts: this.s.settings.get('generation').maxAttempts,
    });
    this.s.logger.info('job queued', {
      job: job.id,
      kind,
      target: target.id,
      project: ctx.projectId,
      shot: ctx.shotId,
    });
    return job;
  }

  private shotContext(shot: Shot): { projectId: string; storyId: string; shotId: string } {
    const storyId = this.s.stories.storyIdForShot(shot.id);
    return { projectId: this.s.stories.projectIdForStory(storyId), storyId, shotId: shot.id };
  }

  queueImage(shotId: string, opts: QueueOptions = {}): GenerationJob {
    const shot = this.s.stories.getShot(shotId);
    if (shot.approved_image_asset_id && !opts.explicit) {
      throw new AppError(
        'CONFLICT',
        'This shot already has an approved image. Approved assets are not regenerated automatically; use Regenerate to ask explicitly.',
      );
    }
    return this.enqueue('image', { type: 'shot', id: shotId }, this.shotContext(shot), {
      mode: shot.generation_mode,
      ...opts,
    });
  }

  queueVideo(shotId: string, opts: QueueOptions = {}): GenerationJob {
    const shot = this.s.stories.getShot(shotId);
    if (!shot.approved_image_asset_id) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Image-first workflow: approve an image for this shot before animating it.',
      );
    }
    if (shot.approved_video_asset_id && !opts.explicit) {
      throw new AppError(
        'CONFLICT',
        'This shot already has an approved clip. Use Regenerate to ask explicitly.',
      );
    }
    return this.enqueue('video', { type: 'shot', id: shotId }, this.shotContext(shot), {
      mode: shot.generation_mode,
      ...opts,
    });
  }

  queueUpscale(assetId: string, opts: QueueOptions = {}): GenerationJob {
    const asset = this.s.assets.get(assetId);
    if (asset.kind !== 'image' && asset.kind !== 'video')
      throw new AppError('VALIDATION_FAILED', 'Only images and clips can be upscaled');
    return this.enqueue('upscale', { type: 'asset', id: assetId }, { projectId: asset.project_id }, opts);
  }

  queueLipsync(shotId: string, opts: QueueOptions = {}): GenerationJob {
    const shot = this.s.stories.getShot(shotId);
    return this.enqueue('lipsync', { type: 'shot', id: shotId }, this.shotContext(shot), opts);
  }

  queueDialogueAudio(lineId: string, opts: QueueOptions = {}): GenerationJob {
    const line = this.s.stories.getDialogue(lineId);
    const shot = this.s.stories.getShot(line.shot_id);
    // Refuse up front (instead of queueing a job that can only fail later in the batch).
    if (!line.character_id)
      throw new AppError(
        'PRECONDITION_FAILED',
        'This dialogue line has no speaking character. Choose one first.',
      );
    const character = this.s.characters.get(line.character_id);
    if (!character.voice_profile_id)
      throw new AppError(
        'PRECONDITION_FAILED',
        `Character "${character.name}" has no voice yet. Create one under Characters → Voices and assign it to ${character.name}.`,
      );
    return this.enqueue('tts', { type: 'dialogue', id: lineId }, this.shotContext(shot), opts);
  }

  queueNarrationAudio(lineId: string, opts: QueueOptions = {}): GenerationJob {
    const line = this.s.stories.getNarration(lineId);
    const scene = this.s.stories.getScene(line.scene_id);
    const project = this.s.projects.get(this.s.stories.projectIdForStory(scene.story_id));
    if (!project.narrator_voice_id) throw new AppError('PRECONDITION_FAILED', NARRATOR_VOICE_NEEDED);
    return this.enqueue(
      'tts',
      { type: 'narration', id: lineId },
      {
        projectId: this.s.stories.projectIdForStory(scene.story_id),
        storyId: scene.story_id,
        shotId: line.shot_id,
      },
      opts,
    );
  }

  queueSceneAudio(sceneId: string, kind: 'music' | 'ambience', opts: QueueOptions = {}): GenerationJob {
    const scene = this.s.stories.getScene(sceneId);
    return this.enqueue(
      kind,
      { type: 'scene', id: sceneId },
      { projectId: this.s.stories.projectIdForStory(scene.story_id), storyId: scene.story_id },
      opts,
    );
  }

  queueSfx(cueId: string, opts: QueueOptions = {}): GenerationJob {
    const cue = this.s.db.get<{ shot_id: string }>('SELECT shot_id FROM shot_sfx WHERE id = ?', cueId);
    if (!cue) throw new AppError('NOT_FOUND', `SFX cue not found: ${cueId}`);
    const shot = this.s.stories.getShot(cue.shot_id);
    return this.enqueue('sfx', { type: 'shot_sfx', id: cueId }, this.shotContext(shot), opts);
  }

  queueReference(
    owner: { type: 'character' | 'location'; id: string },
    slot: { slot_type: string; slot: string; variant_id?: string | null },
    opts: QueueOptions = {},
  ): GenerationJob {
    const projectId =
      owner.type === 'character'
        ? this.s.characters.get(owner.id).project_id
        : this.s.characters.getLocation(owner.id).project_id;
    return this.enqueue(
      'reference',
      { type: owner.type, id: `${owner.id}:${slot.slot_type}:${slot.slot}:${slot.variant_id ?? ''}` },
      { projectId },
      {
        ...opts,
        params: { ...(opts.params ?? {}), ownerType: owner.type, ownerId: owner.id, ...slot },
      },
    );
  }

  cancel(jobId: string): GenerationJob {
    const job = this.s.jobs.cancel(jobId);
    this.s.logger.info('job cancelled', { job: jobId });
    return job;
  }

  // ---------------------------------------------------------------------------
  // Batch runner
  // ---------------------------------------------------------------------------

  /** Process every waiting job: local jobs directly, GPU jobs in ONE batched session. */
  async processQueue(opts: { signal?: AbortSignal } = {}): Promise<BatchResult> {
    if (this.running) throw new AppError('CONFLICT', 'The generation queue is already running');
    this.running = true;
    const batchId = newId('bat');
    const result: BatchResult = {
      batchId,
      processed: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      gpuSessions: 0,
      simulatedCostInr: 0,
      messages: [],
    };
    try {
      if (this.s.jobs.waiting().length > 0) await this.router?.ensureReady();
      assertGenerationAllowed(this.s.env, this.s.providers);
      const waiting = this.s.jobs.waiting();
      if (waiting.length === 0) return result;
      this.s.jobs.assignBatch(
        waiting.map((j) => j.id),
        batchId,
      );
      const gpuJobs = waiting.filter((j) => this.isGpuJob(j));
      const localJobs = waiting.filter((j) => !this.isGpuJob(j));

      for (const job of localJobs) await this.runJob(job, null, result, opts.signal);

      if (gpuJobs.length > 0) {
        // Speech/music/SFX join the GPU batch in REAL CLOUD mode (their models run on the cloud worker).
        const order: JobKind[] = [
          'reference',
          'image',
          'video',
          'upscale',
          'tts',
          'music',
          'sfx',
          'ambience',
          'lipsync',
        ];
        gpuJobs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
        const minVram = Math.max(...gpuJobs.map((j) => this.providerFor(j.kind).minVramGb));
        const estimate = this.estimateGpuSeconds(gpuJobs);
        let plan;
        try {
          plan = await this.s.gpu.plan(minVram, estimate);
        } catch (err) {
          const e = toAppError(err);
          for (const job of gpuJobs) this.failJob(job, e.code, e.message, result);
          result.messages.push(`GPU batch not started: ${e.message}`);
          return result;
        }
        for (const job of gpuJobs)
          this.s.jobs.setStatus(
            job.id,
            'provisioning_gpu',
            `${plan.offer.gpuModel} ₹${plan.offer.hourlyRateInr}/h`,
          );
        let sessionId: string | undefined;
        try {
          await this.s.gpu.withSession(plan, async (session) => {
            sessionId = session.id;
            result.gpuSessions++;
            for (const job of gpuJobs)
              this.s.jobs.setStatus(job.id, 'starting_worker', `session ${session.id}`);
            const loaded = new Set<string>();
            for (const job of gpuJobs) {
              if (this.s.jobs.get(job.id).status === 'cancelled') {
                result.cancelled++;
                continue;
              }
              const modelKey = job.kind === 'reference' ? 'image' : job.kind;
              if (!loaded.has(modelKey)) {
                this.s.jobs.setStatus(job.id, 'loading_model', `loading ${this.providerFor(job.kind).id}`);
                session.recordUsage('model_load', MODEL_LOAD_SECONDS[modelKey] ?? 20, {
                  model: this.providerFor(job.kind).id,
                });
                loaded.add(modelKey);
              }
              // Paid sessions: never start the next job once the session budget is used up.
              await session.assertWithinBudget();
              if (this.s.gpu.currentProvider.paid) session.setState('GENERATING', `${job.kind} ${job.id}`);
              await this.runJob(job, session, result, opts.signal);
            }
          });
        } catch (err) {
          const e = toAppError(err);
          for (const job of gpuJobs) {
            const current = this.s.jobs.get(job.id);
            if (!['complete', 'failed', 'cancelled'].includes(current.status))
              this.failJob(current, e.code, e.message, result);
          }
          result.messages.push(`GPU batch error: ${e.message}`);
        }
        if (sessionId) result.simulatedCostInr += this.s.gpuRepo.sessionCost(sessionId);
      }
      result.simulatedCostInr = Math.round(result.simulatedCostInr * 100) / 100;
      this.s.logger.info('batch finished', { batch: batchId, ...result, messages: undefined });
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Character consistency with REAL image models (local GPU or cloud): the approved references
   * of the shot's characters go with the request. Models with an IP-Adapter use them as identity
   * references; others start image-to-image from the first one. Mock providers are unchanged.
   */
  private async characterReferences(refs: ReferenceInput[]): Promise<{
    init?: { data: Uint8Array; strength: number };
    images: Uint8Array[];
    used: string[];
  }> {
    const info = this.s.providers.image.info;
    const strength = this.s.settings.get('generation').characterReferenceStrength;
    if (info.isMock) return { images: [], used: [] };
    // Identity is best described by face / front views, then other views; poses and expressions last.
    const rank = (r: ReferenceInput): number =>
      /face|front/.test(r.label)
        ? 0
        : /three_quarter|full_body/.test(r.label)
          ? 1
          : /view:/.test(r.label)
            ? 2
            : 3;
    const chosen = refs
      .filter((r) => r.role === 'character')
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 3);
    const images: Uint8Array[] = [];
    const used: string[] = [];
    for (const r of chosen) {
      if (!(await this.s.storage.exists(r.storageKey))) continue;
      images.push(await this.s.storage.get(r.storageKey));
      used.push(r.label);
    }
    return {
      images,
      used,
      ...(images[0] && strength > 0 ? { init: { data: images[0], strength } } : {}),
    };
  }

  /** GPU memory policy for real models (Settings → Execution & GPU). */
  memoryPolicy(): Record<string, unknown> {
    const ex = this.s.settings.get('execution');
    return {
      max_vram_percent: ex.maxVramPercent,
      cpu_offload: ex.cpuOffload,
      vae_tiling: ex.vaeTiling,
      attention: ex.attentionOptimization,
      auto_unload: ex.autoUnloadModels,
      allow_quality_reduction: ex.allowQualityReduction,
    };
  }

  private isGpuJob(job: GenerationJob): boolean {
    const info = this.providerFor(job.kind);
    // Anything running on a paid cloud worker must go through a supervised GPU session.
    if (info.computeLocation === 'cloud_gpu' && info.requiresPaidResources) return true;
    return GPU_KINDS.has(job.kind) && info.computeLocation !== 'local_cpu';
  }

  providerFor(kind: JobKind): ProviderInfo {
    const p = this.s.providers;
    switch (kind) {
      case 'image':
      case 'reference':
        return p.image.info;
      case 'video':
        return p.video.info;
      case 'upscale':
        return p.upscaler.info;
      case 'lipsync':
        return p.lipsync.info;
      case 'tts':
        return p.tts.info;
      case 'music':
        return p.music.info;
      case 'sfx':
      case 'ambience':
        return p.sfx.info;
    }
  }

  estimateGpuSeconds(jobs: GenerationJob[]): number {
    let total = 90; // startup
    const models = new Set<string>();
    for (const j of jobs) {
      models.add(j.kind);
      const shot = j.shot_id
        ? this.s.db.get<{ duration_sec: number }>('SELECT duration_sec FROM shots WHERE id = ?', j.shot_id)
        : undefined;
      const dur = shot?.duration_sec ?? 5;
      total +=
        j.kind === 'video' ? 15 * dur : j.kind === 'lipsync' ? 4 * dur : j.kind === 'upscale' ? 20 : 12;
    }
    for (const m of models) total += MODEL_LOAD_SECONDS[m] ?? 20;
    return total;
  }

  private failJob(job: GenerationJob, code: ErrorCode, message: string, result: BatchResult): void {
    this.s.jobs.setStatus(job.id, 'failed', message, { error_code: code, error_message: message });
    result.failed++;
    result.processed++;
    this.s.logger.warn('job failed', {
      job: job.id,
      kind: job.kind,
      code,
      error: message,
      shot: job.shot_id,
    });
  }

  private async runJob(
    job: GenerationJob,
    session: GpuSession | null,
    result: BatchResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.s.jobs.get(job.id).status === 'cancelled') {
      result.cancelled++;
      return;
    }
    for (;;) {
      const attemptNumber = this.s.jobs.incrementAttempts(job.id);
      const started = this.s.clock.now().toISOString();
      try {
        if (signal?.aborted) throw new AppError('CANCELLED', 'Batch cancelled');
        if (session && !session.isAlive())
          throw new AppError('WORKER_UNAVAILABLE', 'GPU session is no longer running');
        const outcome = await this.execute(this.s.jobs.get(job.id), attemptNumber, session, started, signal);
        this.s.jobs.setStatus(job.id, 'complete', outcome);
        if (job.remote_job_id || this.s.jobs.get(job.id).remote_job_id) this.s.jobs.clearRemote(job.id);
        result.completed++;
        result.processed++;
        return;
      } catch (err) {
        const e = toAppError(err);
        const code: ErrorCode = (err as { code?: ErrorCode }).code ?? e.code;
        this.recordFailedAttempt(job, attemptNumber, started, code, e.message, session);
        if (code === 'CANCELLED') {
          this.s.jobs.setStatus(job.id, 'cancelled', e.message, {
            error_code: code,
            error_message: e.message,
          });
          result.cancelled++;
          result.processed++;
          return;
        }
        const retryable = RETRYABLE_CODES.has(code) && attemptNumber < job.max_attempts;
        const budgetOk = !session || this.s.budget.status(session.instance.is_mock === 1).level !== 'blocked';
        if (!retryable || !budgetOk) {
          const why = !budgetOk ? ' (retry skipped: budget blocked)' : '';
          this.failJob(this.s.jobs.get(job.id), code, `${e.message}${why}`, result);
          return;
        }
        this.s.jobs.setStatus(job.id, 'waiting', `attempt ${attemptNumber} failed (${code}); retrying`);
      }
    }
  }

  private recordFailedAttempt(
    job: GenerationJob,
    attemptNumber: number,
    started: string,
    code: ErrorCode,
    message: string,
    session: GpuSession | null,
  ): void {
    const info = this.providerFor(job.kind);
    this.s.jobs.createAttempt({
      job_id: job.id,
      project_id: job.project_id,
      shot_id: job.shot_id,
      kind: job.kind,
      attempt_number: attemptNumber,
      prompt: '',
      negative_prompt: '',
      model: info.id,
      model_version: info.modelVersion,
      seed: null,
      references_json: '[]',
      width: null,
      height: null,
      fps: null,
      duration_sec: null,
      settings_json: JSON.stringify({ mode: job.mode }),
      provider: session ? session.instance.provider : 'local',
      gpu_model: session?.instance.gpu_model ?? null,
      gpu_instance_id: session?.id ?? null,
      started_at: started,
      finished_at: this.s.clock.now().toISOString(),
      generation_seconds: 0,
      gpu_seconds: 0,
      estimated_cost_inr: 0,
      status: code === 'CANCELLED' ? 'cancelled' : 'failed',
      error_code: code,
      error_message: message,
      output_asset_id: null,
      is_mock: info.isMock,
    });
  }

  /** Record a successful attempt + usage, returning the attempt. */
  private recordSuccess(
    job: GenerationJob,
    attemptNumber: number,
    started: string,
    session: GpuSession | null,
    info: ProviderInfo,
    res: ModelResult,
    asset: GeneratedAsset | null,
    extra: {
      prompt?: string;
      negative?: string;
      seed?: number | null;
      references?: unknown[];
      width?: number;
      height?: number;
      fps?: number;
      durationSec?: number;
    },
  ): GenerationAttempt {
    let cost = 0;
    const category =
      job.kind === 'upscale'
        ? 'upscale'
        : job.kind === 'lipsync'
          ? 'lipsync'
          : ['tts', 'music', 'sfx', 'ambience'].includes(job.kind)
            ? 'audio'
            : 'generation';
    if (session) {
      cost = costFor(res.generationSeconds, session.instance.hourly_rate_inr);
    }
    const attempt = this.s.jobs.createAttempt({
      job_id: job.id,
      project_id: job.project_id,
      shot_id: job.shot_id,
      kind: job.kind,
      attempt_number: attemptNumber,
      prompt: extra.prompt ?? '',
      negative_prompt: extra.negative ?? '',
      model: res.model,
      model_version: res.modelVersion,
      seed: extra.seed ?? null,
      references_json: JSON.stringify(extra.references ?? []),
      width: extra.width ?? res.file.width ?? null,
      height: extra.height ?? res.file.height ?? null,
      fps: extra.fps ?? res.file.fps ?? null,
      duration_sec: extra.durationSec ?? res.file.durationSec ?? null,
      settings_json: JSON.stringify({
        ...res.settings,
        mode: job.mode,
        native: res.isNativeResolution,
        logs: res.logs,
      }),
      provider: session ? session.instance.provider : 'local',
      gpu_model: session?.instance.gpu_model ?? null,
      gpu_instance_id: session?.id ?? null,
      started_at: started,
      finished_at: this.s.clock.now().toISOString(),
      generation_seconds: res.generationSeconds,
      gpu_seconds: session ? res.generationSeconds : 0,
      estimated_cost_inr: cost,
      status: 'succeeded',
      error_code: null,
      error_message: null,
      output_asset_id: asset?.id ?? null,
      is_mock: info.isMock,
    });
    if (session) {
      session.recordUsage(category, res.generationSeconds, {
        jobId: job.id,
        attemptId: attempt.id,
        projectId: job.project_id,
        storyId: job.story_id,
        shotId: job.shot_id,
        model: res.model,
      });
    }
    this.s.logger.info('attempt succeeded', {
      job: job.id,
      attempt: attempt.id,
      kind: job.kind,
      shot: job.shot_id,
      model: res.model,
      gpu: session?.instance.gpu_model,
      cost,
      mock: info.isMock,
    });
    return attempt;
  }

  private seedFor(job: GenerationJob, shot: Shot | null, attemptNumber: number): number {
    const params = parseJson<Record<string, unknown>>(job.params_json, {});
    if (typeof params['seed'] === 'number') return params['seed'];
    if (params['seed'] !== 'new' && shot?.seed !== null && shot?.seed !== undefined && attemptNumber === 1)
      return shot.seed;
    return seedFrom(`${job.id}:${attemptNumber}`) % 2 ** 31;
  }

  private setStatus(job: GenerationJob, status: JobStatus, msg = ''): void {
    this.s.jobs.setStatus(job.id, status, msg);
  }

  /** Execute one attempt of a job. Returns a short outcome message. */
  private async execute(
    job: GenerationJob,
    attemptNumber: number,
    session: GpuSession | null,
    started: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const sameSession = session && job.remote_job_id && job.gpu_instance_id === session.id;
    const ctx: RunContext = {
      attemptKey: `${job.id}:${attemptNumber}`,
      attemptNumber,
      ...(signal ? { signal } : {}),
      ...(session
        ? {
            remote: {
              // After a restart, re-poll the job already submitted to this same GPU instead of paying again.
              ...(sameSession ? { resumeJobId: job.remote_job_id! } : {}),
              onSubmitted: (remoteJobId: string) =>
                this.s.jobs.setRemote(job.id, {
                  remoteJobId,
                  gpuInstanceId: session.id,
                  at: this.s.clock.now().toISOString(),
                }),
              onDownloading: () => {
                if (this.s.gpu.currentProvider.paid) session.setState('DOWNLOADING');
              },
              isCancelled: () => this.s.jobs.get(job.id).status === 'cancelled',
            },
          }
        : {}),
    };
    const params = parseJson<Record<string, unknown>>(job.params_json, {});
    const settings = { ...params, memory: this.memoryPolicy() };
    const project = this.s.projects.get(job.project_id);

    switch (job.kind) {
      case 'image': {
        const shot = this.s.stories.getShot(job.target_id);
        const prompt = this.promptFor(shot.id);
        const seed = this.seedFor(job, shot, attemptNumber);
        this.setStatus(job, 'generating_image', `seed ${seed}`);
        const refs = await this.characterReferences(prompt.references);
        const reference = refs.init;
        const res = await this.s.providers.image.generate(
          {
            mode: reference ? 'image_to_image' : 'text_to_image',
            ...(reference ? { initImage: reference.data, strength: reference.strength } : {}),
            ...(refs.images.length ? { referenceImages: refs.images } : {}),
            prompt: prompt.final.image,
            negativePrompt: prompt.final.negative,
            seed,
            width: project.width,
            height: project.height,
            quality: job.mode,
            references: prompt.references,
            settings,
          },
          ctx,
        );
        this.setStatus(job, 'downloading', 'storing result locally');
        const asset = await this.s.assets.create({
          projectId: project.id,
          kind: 'image',
          data: res.file.data,
          ext: res.file.ext,
          mime: res.file.mime,
          width: res.file.width ?? null,
          height: res.file.height ?? null,
          isNativeResolution: res.isNativeResolution,
          isMock: this.s.providers.image.info.isMock,
          label: `${shot.title || 'Shot'} — image`,
        });
        this.recordSuccess(job, attemptNumber, started, session, this.s.providers.image.info, res, asset, {
          prompt: prompt.final.image,
          negative: prompt.final.negative,
          seed,
          references: prompt.references,
        });
        if (!shot.approved_image_asset_id)
          this.s.stories.setShotState(shot.id, { approval_state: 'image_review' });
        return `image ${asset.id}`;
      }

      case 'video': {
        const shot = this.s.stories.getShot(job.target_id);
        if (!shot.approved_image_asset_id) {
          // Image-first: never fall back to regenerating the image.
          throw new AppError('PRECONDITION_FAILED', 'No approved image for this shot');
        }
        const image = this.s.assets.get(shot.approved_image_asset_id);
        const prompt = this.promptFor(shot.id);
        const seed = this.seedFor(job, shot, attemptNumber);
        this.setStatus(job, 'generating_video', `seed ${seed}`);
        const res = await this.s.providers.video.animate(
          {
            image: await this.s.assets.read(image.id),
            imageStorageKey: image.storage_key,
            motionPrompt: prompt.final.motion,
            negativePrompt: prompt.final.negative,
            seed,
            durationSec: shot.duration_sec,
            fps: shot.fps,
            width: project.width,
            height: project.height,
            quality: job.mode,
            references: prompt.references,
            motionStrength: typeof params['motionStrength'] === 'number' ? params['motionStrength'] : 0.5,
            cameraMovement: shot.camera_movement,
            settings,
          },
          ctx,
        );
        this.setStatus(job, 'downloading', 'storing clip locally');
        const clip = await this.s.assets.create({
          projectId: project.id,
          kind: 'video',
          data: res.file.data,
          ext: res.file.ext,
          mime: res.file.mime,
          width: res.file.width ?? null,
          height: res.file.height ?? null,
          durationSec: res.file.durationSec ?? shot.duration_sec,
          fps: res.file.fps ?? shot.fps,
          sourceAssetId: image.id,
          isNativeResolution: res.isNativeResolution,
          isMock: this.s.providers.video.info.isMock,
          label: `${shot.title || 'Shot'} — clip`,
        });
        let output = clip;
        const gen = this.s.settings.get('generation');
        if (
          gen.upscaleOptimizedOutput &&
          shouldUpscale(gen.upscaleMode, clip, { width: project.width, height: project.height })
        ) {
          // OPTIMIZED: generate at an efficient resolution, then upscale. The
          // original clip is kept; the upscaled copy is flagged non-native.
          this.setStatus(
            job,
            'upscaling',
            `${clip.width}x${clip.height} → ${project.width}x${project.height}`,
          );
          const up = await this.s.providers.upscaler.upscale(
            {
              kind: 'video',
              source: await this.s.assets.read(clip.id),
              sourceMime: clip.mime,
              sourceWidth: clip.width ?? 0,
              sourceHeight: clip.height ?? 0,
              targetWidth: project.width,
              targetHeight: project.height,
            },
            ctx,
          );
          output = await this.s.assets.create({
            projectId: project.id,
            kind: 'upscaled_video',
            data: up.file.data,
            ext: up.file.ext,
            mime: up.file.mime,
            width: up.file.width ?? null,
            height: up.file.height ?? null,
            durationSec: clip.duration_sec,
            fps: clip.fps,
            sourceAssetId: clip.id,
            isNativeResolution: false,
            isMock: this.s.providers.upscaler.info.isMock,
            label: `${shot.title || 'Shot'} — clip (upscaled)`,
          });
          if (session)
            session.recordUsage('upscale', up.generationSeconds, {
              jobId: job.id,
              shotId: shot.id,
              model: up.model,
            });
        }
        this.recordSuccess(job, attemptNumber, started, session, this.s.providers.video.info, res, output, {
          prompt: prompt.final.motion,
          negative: prompt.final.negative,
          seed,
          references: [
            { role: 'image', storageKey: image.storage_key, label: 'approved image' },
            ...prompt.references,
          ],
          width: output.width ?? undefined,
          height: output.height ?? undefined,
          fps: shot.fps,
          durationSec: shot.duration_sec,
        });
        if (!shot.approved_video_asset_id)
          this.s.stories.setShotState(shot.id, { approval_state: 'video_review' });
        return `clip ${output.id}`;
      }

      case 'upscale': {
        const src = this.s.assets.get(job.target_id);
        this.setStatus(job, 'upscaling');
        const res = await this.s.providers.upscaler.upscale(
          {
            kind: src.kind === 'video' ? 'video' : 'image',
            source: await this.s.assets.read(src.id),
            sourceMime: src.mime,
            sourceWidth: src.width ?? 0,
            sourceHeight: src.height ?? 0,
            targetWidth: project.width,
            targetHeight: project.height,
          },
          ctx,
        );
        const out = await this.s.assets.create({
          projectId: project.id,
          kind: src.kind === 'video' ? 'upscaled_video' : 'upscaled_image',
          data: res.file.data,
          ext: res.file.ext,
          mime: res.file.mime,
          width: res.file.width ?? null,
          height: res.file.height ?? null,
          durationSec: src.duration_sec,
          fps: src.fps,
          sourceAssetId: src.id,
          isNativeResolution: false,
          isMock: this.s.providers.upscaler.info.isMock,
          label: `${src.label} (upscaled)`,
        });
        this.recordSuccess(
          job,
          attemptNumber,
          started,
          session,
          this.s.providers.upscaler.info,
          res,
          out,
          {},
        );
        return `upscaled ${out.id}`;
      }

      case 'lipsync': {
        const shot = this.s.stories.getShot(job.target_id);
        if (!shot.mouth_visible || !shot.lipsync_enabled)
          return 'skipped: lip sync not required for this shot';
        if (!shot.approved_video_asset_id)
          throw new AppError('PRECONDITION_FAILED', 'Lip sync needs an approved clip');
        const track = await this.audio.shotDialogueTrack(shot.id);
        if (!track) return 'skipped: no dialogue audio in this shot';
        const video = this.s.assets.get(shot.approved_video_asset_id);
        this.setStatus(job, 'lip_sync');
        const res = await this.s.providers.lipsync.sync(
          {
            video: await this.s.assets.read(video.id),
            videoMime: video.mime,
            audio: track.wav,
            durationSec: shot.duration_sec,
          },
          ctx,
        );
        const out = await this.s.assets.create({
          projectId: project.id,
          kind: 'lipsync_video',
          data: res.file.data,
          ext: res.file.ext,
          mime: res.file.mime,
          width: res.file.width ?? video.width,
          height: res.file.height ?? video.height,
          durationSec: video.duration_sec,
          fps: video.fps,
          sourceAssetId: video.id, // original clip is preserved
          isNativeResolution: video.is_native_resolution === 1,
          isMock: this.s.providers.lipsync.info.isMock,
          label: `${shot.title || 'Shot'} — lip-synced`,
        });
        this.recordSuccess(job, attemptNumber, started, session, this.s.providers.lipsync.info, res, out, {});
        this.s.assets.setApproval(out.id, 'approved');
        this.s.stories.setShotState(shot.id, { lipsync_video_asset_id: out.id });
        return `lip-sync ${out.id}`;
      }

      case 'tts':
      case 'music':
      case 'ambience':
      case 'sfx': {
        this.setStatus(job, 'generating_audio');
        const force = params['explicit'] === true;
        let outcome: AudioOutcome;
        if (job.kind === 'tts' && job.target_type === 'dialogue') {
          outcome = await this.audio.dialogue(this.s.stories.getDialogue(job.target_id), ctx, { force });
        } else if (job.kind === 'tts') {
          outcome = await this.audio.narration(this.s.stories.getNarration(job.target_id), ctx, { force });
        } else if (job.kind === 'music') {
          const scene = this.s.stories.getScene(job.target_id);
          const duration =
            typeof params['durationSec'] === 'number' ? params['durationSec'] : this.sceneDuration(scene.id);
          outcome = await this.audio.music(scene, duration, ctx, { force });
        } else if (job.kind === 'ambience') {
          outcome = await this.audio.ambience(this.s.stories.getScene(job.target_id), ctx, { force });
        } else {
          const cue = this.s.stories.listShotSfx(job.shot_id ?? '').find((c) => c.id === job.target_id);
          if (!cue) throw new AppError('NOT_FOUND', 'SFX cue no longer exists');
          outcome = await this.audio.sfx(cue, ctx, { force });
        }
        if (outcome.reused) return `reused cached audio ${outcome.audio.id}`;
        this.setStatus(job, 'audio_processing', 'normalising and storing');
        const res = outcome.result!;
        this.recordSuccess(
          job,
          attemptNumber,
          started,
          session,
          outcome.provider,
          res,
          this.s.assets.get(outcome.audio.generated_asset_id),
          {
            prompt: JSON.stringify(outcome.request),
            durationSec: outcome.audio.duration_sec,
          },
        );
        return `audio ${outcome.audio.id}`;
      }

      case 'reference': {
        const ownerType = params['ownerType'] === 'location' ? 'location' : 'character';
        const ownerId = String(params['ownerId'] ?? '');
        const slotType = String(params['slot_type'] ?? 'view');
        const slot = String(params['slot'] ?? 'front');
        const variantId =
          typeof params['variant_id'] === 'string' && params['variant_id'] ? params['variant_id'] : null;
        let prompt: string;
        let negative: string;
        if (ownerType === 'character') {
          const c = this.s.characters.get(ownerId);
          const variant = variantId ? this.s.characters.getVariant(variantId) : null;
          prompt = `character reference sheet, ${slot.replace('_', ' ')} ${slotType}, plain background. ${c.name}: ${c.prompt} ${variant?.prompt_additions ?? ''}`;
          negative = c.negative_prompt;
        } else {
          const l = this.s.characters.getLocation(ownerId);
          prompt = `location reference, ${slot}, ${l.prompt || l.description}`;
          negative = l.negative_prompt;
        }
        const seed = this.seedFor(job, null, attemptNumber);
        this.setStatus(job, 'generating_image', `${ownerType} reference ${slotType}:${slot}`);
        const res = await this.s.providers.image.generate(
          {
            mode: 'text_to_image',
            prompt,
            negativePrompt: negative,
            seed,
            width: 768,
            height: 768,
            quality: job.mode,
            references: [],
            settings,
          },
          ctx,
        );
        const ref = await this.s.assets.createReference(
          project.id,
          ownerType,
          ownerId,
          res.file.data,
          res.file.ext,
          res.file.mime,
          `${slotType}:${slot}`,
          this.s.providers.image.info.isMock,
        );
        if (ownerType === 'character') {
          this.s.characters.addReference(ownerId, ref, {
            slot_type: slotType,
            slot,
            variant_id: variantId ?? undefined,
          });
        }
        this.recordSuccess(job, attemptNumber, started, session, this.s.providers.image.info, res, null, {
          prompt,
          negative,
          seed,
        });
        return `reference ${ref.id}`;
      }
    }
  }

  sceneDuration(sceneId: string): number {
    return this.s.stories.listShots(sceneId).reduce((sum, s) => sum + s.duration_sec, 0) || 5;
  }

  // ---------------------------------------------------------------------------
  // Review: approve / reject / regenerate (spec §36)
  // ---------------------------------------------------------------------------

  approveAttempt(attemptId: string): void {
    const attempt = this.s.jobs.getAttempt(attemptId);
    if (attempt.status !== 'succeeded' || !attempt.output_asset_id) {
      throw new AppError('PRECONDITION_FAILED', 'Only successful attempts with an output can be approved');
    }
    if (!attempt.shot_id) {
      this.s.jobs.setAttemptApproval(attemptId, 'approved');
      this.s.assets.setApproval(attempt.output_asset_id, 'approved');
      return;
    }
    const shot = this.s.stories.getShot(attempt.shot_id);
    this.s.db.transaction(() => {
      if (attempt.kind === 'image') {
        // Only one approved image per shot: the previous one returns to "pending".
        for (const a of this.s.jobs.attemptsForShot(shot.id, 'image')) {
          if (a.approval === 'approved' && a.id !== attemptId) {
            this.s.jobs.setAttemptApproval(a.id, 'pending');
            if (a.output_asset_id) this.s.assets.setApproval(a.output_asset_id, 'pending');
          }
        }
        const imageChanged = shot.approved_image_asset_id !== attempt.output_asset_id;
        this.s.stories.setShotState(shot.id, {
          approved_image_asset_id: attempt.output_asset_id,
          approval_state:
            imageChanged || !shot.approved_video_asset_id ? 'image_approved' : shot.approval_state,
          // A new still invalidates the clip animated from the old one.
          ...(imageChanged ? { approved_video_asset_id: null, lipsync_video_asset_id: null } : {}),
        });
      } else if (attempt.kind === 'video') {
        const out = this.s.assets.get(attempt.output_asset_id!);
        const root =
          out.kind === 'upscaled_video' && out.source_asset_id ? this.s.assets.get(out.source_asset_id) : out;
        if (root.source_asset_id !== shot.approved_image_asset_id) {
          throw new AppError(
            'CONFLICT',
            'This clip was animated from an image that is no longer the approved still.',
          );
        }
        for (const a of this.s.jobs.attemptsForShot(shot.id, 'video')) {
          if (a.approval === 'approved' && a.id !== attemptId) {
            this.s.jobs.setAttemptApproval(a.id, 'pending');
            if (a.output_asset_id) this.s.assets.setApproval(a.output_asset_id, 'pending');
          }
        }
        this.s.stories.setShotState(shot.id, {
          approved_video_asset_id: attempt.output_asset_id,
          lipsync_video_asset_id: null,
          approval_state: 'approved',
        });
      } else {
        throw new AppError(
          'VALIDATION_FAILED',
          `Attempts of kind ${attempt.kind} are approved through their asset`,
        );
      }
      this.s.jobs.setAttemptApproval(attemptId, 'approved');
      this.s.assets.setApproval(attempt.output_asset_id!, 'approved');
      this.s.assets.recordUsage(
        attempt.output_asset_id!,
        `approved for shot`,
        this.s.stories.storyIdForShot(shot.id),
        shot.id,
      );
    });
  }

  rejectAttempt(attemptId: string): void {
    const attempt = this.s.jobs.getAttempt(attemptId);
    this.s.db.transaction(() => {
      this.s.jobs.setAttemptApproval(attemptId, 'rejected');
      if (attempt.output_asset_id) this.s.assets.setApproval(attempt.output_asset_id, 'rejected');
      if (!attempt.shot_id || !attempt.output_asset_id) return;
      const shot = this.s.stories.getShot(attempt.shot_id);
      if (attempt.kind === 'image' && shot.approved_image_asset_id === attempt.output_asset_id) {
        this.s.stories.setShotState(shot.id, {
          approved_image_asset_id: null,
          approved_video_asset_id: null,
          lipsync_video_asset_id: null,
          approval_state: 'rejected',
        });
      } else if (attempt.kind === 'video' && shot.approved_video_asset_id === attempt.output_asset_id) {
        this.s.stories.setShotState(shot.id, {
          approved_video_asset_id: null,
          lipsync_video_asset_id: null,
          approval_state: 'image_approved',
        });
      }
    });
  }

  /** Regenerate on explicit request (optionally with new seed / quality). History is preserved. */
  regenerate(
    shotId: string,
    kind: 'image' | 'video',
    opts: { seed?: number | 'new'; mode?: QualityMode } = {},
  ): GenerationJob {
    const q: QueueOptions = { explicit: true, seed: opts.seed ?? 'new' };
    if (opts.mode) q.mode = opts.mode;
    return kind === 'image' ? this.queueImage(shotId, q) : this.queueVideo(shotId, q);
  }
}
