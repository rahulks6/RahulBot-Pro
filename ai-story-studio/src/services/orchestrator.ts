import type { Studio } from '../app/studio.ts';
import type { ScriptRequest } from '../domain/script.ts';
import { VIDEO_LENGTHS, videoStyle, type VideoLength } from '../domain/video-styles.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import type { AttentionItem, StageStatus, Video } from '../repositories/videos.ts';
import { studioProject } from './simple-studio.ts';
import { importStoryPackage } from './story-package.ts';
import { languageCode, scriptToPackage, targetShots, writeScript } from './story-writer.ts';
import { cuesFor, toSrt, toVtt } from './captions.ts';
import { episodeMetadata, shortMetadata } from './metadata.ts';
import { createShortStory, planShorts } from './shorts.ts';
import { TechnicalCheck } from './technical-check.ts';
import { burnCaptions, renderThumbnail } from './thumbnails.ts';

/**
 * The Auto Production Orchestrator: one idea → a finished video, READY FOR REVIEW.
 *
 *   story → plan → characters → images → animation → final (voices, music, sound, 1080p MP4)
 *   → [shorts → captions → thumbnail → metadata] → quality check → READY FOR REVIEW
 *
 * One cloud GPU is held for the whole production (sized for every model it needs) and released
 * at the end, on failure and on cancel. Progress is stage by stage with real counts ("7 of 11
 * pictures"), never an invented percentage.
 *
 * Retry policy for every picture and clip, decided by the automatic TECHNICAL check:
 *   attempt 1 — normal settings
 *   attempt 2 — safe configuration (new seed; lowest-VRAM memory plan, reduction allowed)
 *   attempt 3 — fallback: a fresh GPU/worker session and a new seed
 * Then the video stops with "Scene N needs attention" and the choices Retry / Review Scene / Skip.
 */
export interface StageDef {
  stage: string;
  label: string;
  run: (
    o: Orchestrator,
    v: Video,
    signal: AbortSignal,
  ) => Promise<{ status: 'done' | 'warn' | 'skipped'; detail: string }>;
}

/** Stops the run: the listed shots need a person's decision. */
export class NeedsAttention extends Error {
  readonly items: AttentionItem[];
  constructor(items: AttentionItem[]) {
    super(items.map((i) => i.message).join(' '));
    this.items = items;
  }
}

/** Plan review was requested: the run pauses after the plan. */
class PausedForPlan extends Error {}

export interface NewVideoInput {
  idea: string;
  length: VideoLength;
  customMinutes?: number;
  styleId: string;
  makeEpisode: boolean;
  makeShorts: boolean;
  shortsCount: number;
  language: 'en' | 'hi' | 'hinglish';
  narrator: 'female' | 'male';
  musicMood: string;
  reviewPlan: boolean;
}

const ROUNDS = 3;
const NO_EPISODE = { status: 'skipped' as const, detail: 'no full episode was requested' };

export class Orchestrator {
  readonly s: Studio;
  readonly check: TechnicalCheck;
  /** Stages in order; later milestones register more (Shorts, captions, thumbnail, metadata). */
  readonly stages: StageDef[];
  private current: { videoId: string; abort: AbortController; done: Promise<void> } | null = null;

  constructor(s: Studio, tempDir: string) {
    this.s = s;
    this.check = new TechnicalCheck(s.ffmpeg, tempDir);
    this.stages = [
      { stage: 'story', label: 'Writing the story', run: (o, v, sig) => o.writeStory(v, sig) },
      { stage: 'plan', label: 'Production plan', run: (o, v) => o.plan(v) },
      {
        stage: 'characters',
        label: 'Designing the characters',
        run: (o, v, sig) => o.characterLooks(v, sig),
      },
      { stage: 'images', label: 'Drawing the scenes', run: (o, v, sig) => o.pictures(v, sig) },
      { stage: 'animation', label: 'Animating', run: (o, v, sig) => o.animate(v, sig) },
      { stage: 'final', label: 'Voices, music and the final video', run: (o, v) => o.buildEpisode(v) },
      { stage: 'captions', label: 'Captions', run: (o, v) => o.captions(v) },
      { stage: 'shorts', label: 'Shorts (9:16)', run: (o, v, sig) => o.shorts(v, sig) },
      { stage: 'thumbnail', label: 'Thumbnails', run: (o, v) => o.thumbnails(v) },
      { stage: 'metadata', label: 'Titles, descriptions and tags', run: (o, v) => o.metadata(v) },
      { stage: 'quality', label: 'Quality check', run: (o, v) => o.qualityCheck(v) },
    ];
  }

  // --- creating and controlling videos ---------------------------------------------------------

  create(input: NewVideoInput): Video {
    const idea = input.idea.trim();
    if (idea.length < 8)
      throw new AppError('VALIDATION_FAILED', 'Describe the story idea in a sentence or two.');
    if (idea.length > 4000)
      throw new AppError('VALIDATION_FAILED', 'The idea is too long (4000 characters at most).');
    if (!input.makeEpisode && !input.makeShorts)
      throw new AppError('VALIDATION_FAILED', 'Choose at least one output: Full Episode or Shorts.');
    const seconds =
      input.length === 'custom'
        ? Math.round(Math.min(30, Math.max(0.5, input.customMinutes ?? 2)) * 60)
        : VIDEO_LENGTHS[input.length].seconds;
    const project = studioProject(this.s);
    return this.s.videos.create(
      {
        project_id: project.id,
        title: idea.split(/[.!?\n]/)[0]!.slice(0, 80) || 'New video',
        idea,
        style_id: videoStyle(input.styleId).id,
        length_key: input.length,
        target_seconds: seconds,
        make_episode: input.makeEpisode ? 1 : 0,
        make_shorts: input.makeShorts ? 1 : 0,
        shorts_count: Math.max(1, Math.min(5, Math.round(input.shortsCount))),
        language: input.language,
        narrator: input.narrator,
        music_mood: input.musicMood,
        review_plan: input.reviewPlan ? 1 : 0,
      },
      this.stages.map(({ stage, label }) => ({ stage, label })),
    );
  }

  runningVideoId(): string | null {
    return this.current?.videoId ?? null;
  }

  /** Start (or continue) a video in the background. One video is produced at a time. */
  start(videoId: string): Promise<void> {
    if (this.current) {
      if (this.current.videoId === videoId) return this.current.done;
      throw new AppError(
        'CONFLICT',
        'Another video is being made right now. It can start when that one finishes.',
      );
    }
    const v = this.s.videos.get(videoId);
    if (['ready', 'approved', 'scheduled', 'published'].includes(v.status))
      throw new AppError('CONFLICT', 'This video is already finished.');
    const abort = new AbortController();
    const done = this.run(videoId, abort.signal).finally(() => {
      this.current = null;
    });
    this.current = { videoId, abort, done };
    return done;
  }

  cancel(videoId: string): void {
    if (this.current?.videoId === videoId) this.current.abort.abort();
    else {
      const v = this.s.videos.get(videoId);
      if (['generating', 'needs_attention', 'plan_review', 'draft', 'failed'].includes(v.status))
        this.s.videos.update(videoId, { status: 'cancelled', stage_detail: 'Cancelled by you.' });
    }
  }

  /** The plan was reviewed: continue with production. */
  approvePlan(videoId: string): Promise<void> {
    const v = this.s.videos.get(videoId);
    if (v.status !== 'plan_review') throw new AppError('CONFLICT', 'This plan is not waiting for review.');
    this.s.videos.setStage(videoId, 'plan', 'done', 'approved by you');
    this.s.videos.update(videoId, { review_plan: 0 });
    return this.start(videoId);
  }

  /** "Skip": the shot is removed from this video (the rest of the scene continues). */
  skipShot(videoId: string, shotId: string): void {
    const v = this.s.videos.get(videoId);
    if (!v.story_id || this.s.stories.storyIdForShot(shotId) !== v.story_id)
      throw new AppError('NOT_FOUND', 'That shot is not part of this video.');
    const scene = this.s.stories.getScene(this.s.stories.getShot(shotId).scene_id);
    if (this.s.stories.listShots(scene.id).length <= 1)
      throw new AppError(
        'CONFLICT',
        'This is the only shot of its scene; use Retry or Review Scene instead.',
      );
    this.s.stories.deleteShot(shotId);
    const attention = this.s.videos.attention(v).filter((a) => a.shot_id !== shotId);
    this.s.videos.update(videoId, { attention_json: JSON.stringify(attention) });
    this.s.logger.info('video shot skipped', { video: videoId, shot: shotId });
  }

  /** Videos that were being made when the app closed wait for CONTINUE (nothing is lost). */
  recoverAfterRestart(): number {
    const stuck = this.s.videos.list({ status: ['generating'] });
    for (const v of stuck)
      this.s.videos.update(v.id, {
        status: 'needs_attention',
        attention_json: JSON.stringify([
          {
            scene_id: null,
            shot_id: null,
            kind: 'other',
            message:
              'AI Story Studio was closed while this video was being made. Press CONTINUE to go on from where it stopped.',
          },
        ] satisfies AttentionItem[]),
      });
    return stuck.length;
  }

  // --- the run ------------------------------------------------------------------------------------

  private async run(videoId: string, signal: AbortSignal): Promise<void> {
    const log = this.s.logger.child({ video: videoId });
    this.s.videos.update(videoId, {
      status: 'generating',
      error_message: null,
      attention_json: '[]',
      started_at: this.s.videos.get(videoId).started_at ?? this.s.clock.now().toISOString(),
    });
    log.info('video production started', {});
    try {
      await this.s.gpu.hold(async () => {
        for (const def of this.stages) {
          const v = this.s.videos.get(videoId);
          const rec = this.s.videos.stages(v).find((x) => x.stage === def.stage);
          if (rec && ['done', 'warn', 'skipped'].includes(rec.status)) continue;
          if (signal.aborted) throw new AppError('CANCELLED', 'Cancelled by you.');
          this.s.videos.setStage(videoId, def.stage, 'running', def.label);
          const out = await def.run(this, v, signal);
          this.s.videos.setStage(videoId, def.stage, out.status, out.detail);
          log.info('video stage finished', {
            stage: def.stage,
            status: out.status,
            detail: out.detail.slice(0, 200),
          });
        }
      });
      this.s.videos.update(videoId, {
        status: 'ready',
        stage: 'ready',
        stage_detail: 'READY FOR REVIEW',
        finished_at: this.s.clock.now().toISOString(),
      });
      log.info('video ready for review', {});
    } catch (err) {
      const v = this.s.videos.get(videoId);
      const running = this.s.videos.stages(v).find((x) => x.status === 'running');
      if (err instanceof PausedForPlan) {
        this.s.videos.update(videoId, {
          status: 'plan_review',
          stage_detail: 'The plan is ready for your review.',
        });
        return;
      }
      const e = err instanceof NeedsAttention ? null : toAppError(err);
      const status: StageStatus = 'failed';
      if (running)
        this.s.videos.setStage(
          videoId,
          running.stage,
          status,
          err instanceof NeedsAttention ? err.message : e!.message,
        );
      if (err instanceof NeedsAttention) {
        this.s.videos.update(videoId, {
          status: 'needs_attention',
          attention_json: JSON.stringify(err.items),
        });
        log.warn('video needs attention', { items: err.items.length });
      } else if (e!.code === 'CANCELLED') {
        this.s.videos.update(videoId, {
          status: 'cancelled',
          stage_detail: 'Cancelled. The cloud GPU was stopped.',
        });
        this.cancelQueuedJobs(v);
        log.info('video cancelled', {});
      } else {
        this.s.videos.update(videoId, {
          status: 'needs_attention',
          error_message: e!.message,
          attention_json: JSON.stringify([
            { scene_id: null, shot_id: null, kind: 'other', message: this.explain(e!) },
          ] satisfies AttentionItem[]),
        });
        log.error('video production stopped', { error: e!.message, code: e!.code });
      }
    } finally {
      this.s.videos.update(videoId, { cost_inr: this.spent(videoId) });
    }
  }

  /** Plain-language reason and what to do. */
  private explain(e: AppError): string {
    switch (e.code) {
      case 'CLOUD_GPU_DISABLED':
      case 'CLOUD_AUTH_FAILED':
        return `${e.message} Open Settings → AI Engine.`;
      case 'SESSION_BUDGET_REACHED':
      case 'BUDGET_EXCEEDED':
        return `${e.message} Raise the spending limit in Settings, then press CONTINUE.`;
      case 'GPU_UNAVAILABLE':
      case 'PRICE_TOO_HIGH':
      case 'PROVISION_FAILED':
        return `${e.message} RunPod had no suitable GPU just now; press CONTINUE to try again in a few minutes.`;
      default:
        return `${e.message} Press CONTINUE to try again from this step.`;
    }
  }

  private cancelQueuedJobs(v: Video): void {
    if (!v.story_id) return;
    for (const j of this.s.db.all<{ id: string }>(
      "SELECT id FROM generation_jobs WHERE story_id = ? AND status NOT IN ('complete', 'failed', 'cancelled')",
      v.story_id,
    ))
      this.s.jobs.cancel(j.id);
  }

  private spent(videoId: string): number {
    const v = this.s.videos.get(videoId);
    if (!v.story_id) return v.cost_inr;
    const row = this.s.db.get<{ c: number | null }>(
      `SELECT SUM(a.estimated_cost_inr) AS c FROM generation_attempts a
       JOIN generation_jobs j ON j.id = a.job_id WHERE j.story_id = ? AND a.is_mock = 0`,
      v.story_id,
    );
    return Math.round((row?.c ?? 0) * 100) / 100;
  }

  // --- stage: story ---------------------------------------------------------------------------------

  async writeStory(v: Video, signal: AbortSignal): Promise<{ status: 'done'; detail: string }> {
    if (v.story_id) return { status: 'done', detail: 'already written' };
    const project = this.s.projects.get(v.project_id);
    const known = this.s.characters
      .list(project.id)
      .filter((c) => new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(v.idea))
      .map((c) => ({ name: c.name, description: c.appearance || c.prompt }));
    const req: ScriptRequest = {
      idea: v.idea,
      targetSeconds: v.target_seconds,
      targetShots: targetShots(v.target_seconds),
      language: v.language as ScriptRequest['language'],
      style: videoStyle(v.style_id).label,
      knownCharacters: known,
    };
    const text = this.s.providers.text;
    const write = () =>
      writeScript(
        text,
        req,
        {
          attemptKey: `video:${v.id}:story`,
          signal,
          onProgress: (p) =>
            this.detail(
              v.id,
              'story',
              p.status === 'loading_model' ? 'loading the story writer (first run downloads it)' : 'writing',
            ),
        },
        this.seedFor(v),
      );
    const result =
      text.info.computeLocation === 'cloud_gpu'
        ? await this.onGpu(() => write(), ['text', 'image', 'video', 'tts'])
        : await write();
    const pkg = scriptToPackage(result.script, req, {
      project,
      existingCharacters: this.s.characters.list(project.id).map((c) => c.name),
      styleId: v.style_id,
      narrator: v.narrator === 'male' ? 'male' : 'female',
      targetSeconds: v.target_seconds,
    });
    const summary = importStoryPackage(this.s, pkg, { projectId: project.id });
    this.ensureVoices(summary.storyId, result.script.characters, languageCode(req.language));
    const shots = this.s.stories.listStoryShots(summary.storyId).length;
    this.s.videos.update(v.id, {
      story_id: summary.storyId,
      title: result.script.title,
      plan_json: JSON.stringify({
        logline: result.script.logline,
        moral: result.script.moral ?? '',
        characters: result.script.characters.map((c) => c.name),
        scenes: result.script.scenes.map((s) => ({ title: s.title, shots: s.shots.length })),
        shots,
        writer: { model: result.model, mock: result.isMock, calls: result.calls },
      }),
    });
    return {
      status: 'done',
      detail: `"${result.script.title}" — ${result.script.scenes.length} scenes, ${shots} shots, ${result.script.characters.length} characters${result.isMock ? ' (placeholder script: developer test mode)' : ''}`,
    };
  }

  /** Characters reused from the library may have no voice yet: give each speaker one. */
  private ensureVoices(
    storyId: string,
    cast: Array<{ name: string; voice: string }>,
    language: string,
  ): void {
    const projectId = this.s.stories.projectIdForStory(storyId);
    for (const c of cast) {
      const ch = this.s.characters.findByName(projectId, c.name);
      if (!ch || ch.voice_profile_id) continue;
      const voice = this.s.characters.createVoice(projectId, {
        name: `${c.name} voice ${ch.id.slice(-4)}`,
        voice_model: 'auto',
        language,
        presentation: c.voice === 'male' ? 'male' : c.voice === 'female' ? 'female' : 'neutral',
        ...(c.voice === 'child' ? { pitch: 3, speed: 1.05 } : {}),
      });
      this.s.characters.update(ch.id, { voice_profile_id: voice.id });
    }
  }

  // --- stage: plan ------------------------------------------------------------------------------------

  async plan(v: Video): Promise<{ status: 'done'; detail: string }> {
    const storyId = this.storyOf(v);
    const shots = this.s.stories.listStoryShots(storyId);
    const cast = this.cast(storyId);
    const newLooks = cast.filter((c) => !this.s.characters.listReferences(c).some((r) => r.approved)).length;
    const plan = {
      ...parseJson<Record<string, unknown>>(v.plan_json, {}),
      shots: shots.length,
      newLooks,
      seconds: Math.round(shots.reduce((t, s) => t + s.duration_sec, 0)),
    };
    this.s.videos.update(v.id, { plan_json: JSON.stringify(plan) });
    if (v.review_plan) throw new PausedForPlan();
    return {
      status: 'done',
      detail: `${shots.length} shots (about ${Math.round(plan.seconds / 6) / 10} min), ${newLooks} new character look(s) to design`,
    };
  }

  // --- stage: characters --------------------------------------------------------------------------

  async characterLooks(v: Video, signal: AbortSignal): Promise<{ status: 'done' | 'warn'; detail: string }> {
    const storyId = this.storyOf(v);
    const style = videoStyle(v.style_id);
    const need = this.cast(storyId).filter(
      (id) => !this.s.characters.listReferences(id).some((r) => r.approved),
    );
    if (!need.length) return { status: 'done', detail: 'every character already has an approved look' };
    const slots = ['front', 'face_closeup'] as const;
    const missing = new Set(need.flatMap((c) => slots.map((sl) => `${c}|${sl}`)));
    for (let round = 1; round <= ROUNDS && missing.size; round++) {
      await this.prepareRound(round);
      const before = new Set(need.flatMap((c) => this.s.characters.listReferences(c).map((r) => r.id)));
      for (const k of missing) {
        const [cid, slot] = k.split('|') as [string, string];
        this.s.generation.queueReference(
          { type: 'character', id: cid },
          { slot_type: 'view', slot },
          {
            mode: 'optimized',
            seed: 'new',
            params: { stylePrompt: style.prompt, ...(round === 2 ? { safeMode: true } : {}) },
          },
        );
      }
      this.detail(v.id, 'characters', `designing ${missing.size} picture(s), attempt ${round}`);
      await this.s.generation.processQueue({ signal });
      for (const k of [...missing]) {
        const [cid, slot] = k.split('|') as [string, string];
        const fresh = this.s.characters
          .listReferences(cid)
          .filter((r) => !before.has(r.id) && r.slot === slot);
        for (const r of fresh) {
          const ok = r.is_mock
            ? true
            : (
                await this.check.image(
                  await this.s.storage.get(r.storage_key),
                  r.storage_key.split('.').pop() ?? 'png',
                )
              ).ok;
          if (ok) {
            this.s.characters.setReferenceApproval(r.id, true);
            missing.delete(k);
            break;
          }
        }
      }
    }
    const names = [...new Set([...missing].map((k) => this.s.characters.get(k.split('|')[0]!).name))];
    return missing.size
      ? {
          status: 'warn',
          detail: `no usable look yet for ${names.join(', ')} (scenes are drawn from the description)`,
        }
      : { status: 'done', detail: `${need.length} character look(s) designed and checked` };
  }

  // --- stages: images and animation -------------------------------------------------------------------

  async pictures(v: Video, signal: AbortSignal) {
    if (!v.make_episode) return NO_EPISODE;
    return this.shotRounds(v, 'image', signal);
  }

  async animate(v: Video, signal: AbortSignal) {
    if (!v.make_episode) return NO_EPISODE;
    return this.shotRounds(v, 'video', signal);
  }

  private async shotRounds(
    v: Video,
    kind: 'image' | 'video',
    signal: AbortSignal,
  ): Promise<{ status: 'done'; detail: string }> {
    const storyId = this.storyOf(v);
    const stage = kind === 'image' ? 'images' : 'animation';
    const { left, problems, total } = await this.rounds(v.id, storyId, kind, stage, signal);
    if (left.length) {
      throw new NeedsAttention(
        left.map((sh) => {
          const scene = this.s.stories.getScene(sh.scene_id);
          return {
            scene_id: scene.id,
            shot_id: sh.id,
            kind,
            message: `Scene ${scene.position + 1}, shot ${sh.position + 1} needs attention: ${problems.get(sh.id) ?? 'no usable result'} (tried ${ROUNDS} times).`,
          };
        }),
      );
    }
    return { status: 'done', detail: `${total} ${kind === 'image' ? 'pictures' : 'clips'} made and checked` };
  }

  /** The retry rounds for every shot of a story that has no approved picture (or clip) yet. */
  private async rounds(
    videoId: string,
    storyId: string,
    kind: 'image' | 'video',
    stage: string,
    signal: AbortSignal,
  ): Promise<{
    left: Array<{ id: string; scene_id: string; position: number }>;
    problems: Map<string, string>;
    total: number;
  }> {
    const noun = kind === 'image' ? 'pictures' : 'clips';
    const v = { id: videoId };
    const pending = () =>
      this.s.stories
        .listStoryShots(storyId)
        .filter((sh) => (kind === 'image' ? !sh.approved_image_asset_id : !sh.approved_video_asset_id));
    const total = this.s.stories.listStoryShots(storyId).length;
    const problems = new Map<string, string>();
    for (let round = 1; round <= ROUNDS && pending().length; round++) {
      await this.prepareRound(round);
      const jobs = new Map<string, string>();
      for (const sh of pending()) {
        const opts = {
          seed: round === 1 ? undefined : ('new' as const),
          explicit: true,
          params: round === 2 ? { safeMode: true } : {},
        };
        const job =
          kind === 'image'
            ? this.s.generation.queueImage(sh.id, opts)
            : this.s.generation.queueVideo(sh.id, opts);
        jobs.set(sh.id, job.id);
      }
      this.detail(
        v.id,
        stage,
        `${total - pending().length} of ${total} ${noun} done · making ${jobs.size} (attempt ${round}${round === 2 ? ', safe settings' : round === 3 ? ', fresh GPU' : ''})`,
      );
      await this.s.generation.processQueue({ signal });
      for (const [shotId, jobId] of jobs) {
        const attempt = this.s.jobs
          .attemptsForJob(jobId)
          .find((a) => a.status === 'succeeded' && a.output_asset_id);
        if (!attempt) {
          const job = this.s.jobs.get(jobId);
          problems.set(shotId, job.error_message ?? 'generation failed');
          continue;
        }
        const asset = this.s.assets.get(attempt.output_asset_id!);
        const data = await this.s.storage.get(asset.storage_key);
        const res = asset.is_mock
          ? { ok: true, problems: [] }
          : kind === 'image'
            ? await this.check.image(data, asset.storage_key.split('.').pop() ?? 'png')
            : await this.check.clip(data);
        if (res.ok) {
          this.s.generation.approveAttempt(attempt.id);
          problems.delete(shotId);
        } else {
          this.s.generation.rejectAttempt(attempt.id);
          problems.set(
            shotId,
            `the ${kind === 'image' ? 'picture' : 'clip'} failed the technical check: ${res.problems.join(', ')}`,
          );
        }
      }
      this.detail(v.id, stage, `${total - pending().length} of ${total} ${noun} done`);
    }
    return { left: pending(), problems, total };
  }

  /** Round 3 starts on a fresh GPU session (a new worker, possibly another GPU type). */
  private async prepareRound(round: number): Promise<void> {
    if (round < 3) return;
    for (const inst of this.s.gpuRepo.active())
      if (inst.is_mock === 0) await this.s.gpu.terminate(inst.id, 'retry_fresh_gpu');
  }

  // --- stage: final episode ------------------------------------------------------------------------

  async buildEpisode(v: Video): Promise<{ status: 'done' | 'warn' | 'skipped'; detail: string }> {
    if (!v.make_episode) return NO_EPISODE;
    const storyId = this.storyOf(v);
    const rec = await this.s.exports.buildFinal(storyId, 'landscape');
    if (rec.status !== 'complete') {
      const steps = parseJson<Array<{ step: string; status: string; detail: string }>>(rec.steps_json, []);
      const failed = steps.find((x) => x.status === 'failed');
      throw new AppError(
        'FFMPEG_FAILED',
        `The final video could not be built${failed ? ` (${failed.step}: ${failed.detail})` : ''}: ${rec.error_message ?? ''}`.trim(),
      );
    }
    this.s.videos.update(v.id, { episode_export_id: rec.id });
    const warns = parseJson<Array<{ status: string; detail: string }>>(rec.steps_json, []).filter(
      (x) => x.status === 'warn',
    );
    return {
      status: warns.length ? 'warn' : 'done',
      detail: `${rec.width}×${rec.height}, ${rec.fps} fps, ${rec.duration_sec?.toFixed(1) ?? '?'} s${rec.is_mock ? ' (contains placeholders: developer test mode)' : ''}${warns.length ? ` · ${warns.map((w) => w.detail).join('; ')}` : ''}`,
    };
  }

  // --- stage: captions -------------------------------------------------------------------------

  async captions(v: Video): Promise<{ status: 'done' | 'warn' | 'skipped'; detail: string }> {
    if (!v.make_episode) return NO_EPISODE;
    const storyId = this.storyOf(v);
    const keys = await this.writeCaptions(storyId, `videos/${v.id}/episode`);
    this.s.videos.update(v.id, { captions_srt_key: keys?.srt ?? null, captions_vtt_key: keys?.vtt ?? null });
    return keys
      ? { status: 'done', detail: `${keys.count} captions (SRT and WebVTT)` }
      : { status: 'warn', detail: 'no narration or dialogue, so there are no captions' };
  }

  private async writeCaptions(
    storyId: string,
    prefix: string,
  ): Promise<{ srt: string; vtt: string; count: number } | null> {
    const cues = cuesFor(this.s, this.s.timeline, storyId);
    if (!cues.length) return null;
    const srt = `${prefix}.srt`;
    const vtt = `${prefix}.vtt`;
    await this.s.storage.put(srt, toSrt(cues));
    await this.s.storage.put(vtt, toVtt(cues));
    return { srt, vtt, count: cues.length };
  }

  // --- stage: Shorts ---------------------------------------------------------------------------------

  async shorts(
    v: Video,
    signal: AbortSignal,
  ): Promise<{ status: 'done' | 'warn' | 'skipped'; detail: string }> {
    if (!v.make_shorts) return { status: 'skipped', detail: 'no Shorts were requested' };
    const storyId = this.storyOf(v);
    let list = this.s.videos.shorts(v.id);
    if (!list.length) {
      const plans = planShorts(this.s.stories.tree(storyId), v.shorts_count);
      if (!plans.length)
        return { status: 'warn', detail: 'the story has no part that fits a Short (15–58 s)' };
      list = this.s.videos.replaceShorts(
        v.id,
        plans.map((p) => ({
          title: p.title,
          hook: p.hook,
          scene_ids_json: JSON.stringify({ scenes: p.sceneIds, shots: p.shotIds }),
          duration_sec: p.seconds,
        })),
      );
    }
    const failed: string[] = [];
    let reframed = 0;
    for (const short of list) {
      if (short.status === 'ready') continue;
      const label = `Short ${short.idx + 1} of ${list.length}`;
      try {
        const plan = parseJson<{ scenes: string[]; shots: string[] }>(short.scene_ids_json, {
          scenes: [],
          shots: [],
        });
        let storyForShort = short.story_id;
        if (!storyForShort) {
          storyForShort = createShortStory(
            this.s,
            storyId,
            {
              title: short.title,
              hook: short.hook,
              sceneIds: plan.scenes,
              shotIds: plan.shots,
              seconds: short.duration_sec ?? 0,
              score: 0,
            },
            `${this.s.videos.get(v.id).title} — Short ${short.idx + 1}`,
          );
          this.s.videos.updateShort(short.id, { story_id: storyForShort, status: 'generating' });
        }
        let framing: 'native' | 'reframed' = 'native';
        for (const kind of ['image', 'video'] as const) {
          this.detail(v.id, 'shorts', `${label}: ${kind === 'image' ? 'drawing in 9:16' : 'animating'}`);
          const { left } = await this.rounds(v.id, storyForShort, kind, 'shorts', signal);
          if (!left.length) continue;
          // Last resort, recorded on the Short: the episode's own shot, reframed to 9:16.
          const shortShots = this.s.stories.listStoryShots(storyForShort);
          for (const sh of left) {
            const src = plan.shots[shortShots.findIndex((x) => x.id === sh.id)];
            const original = src ? this.s.stories.getShot(src) : null;
            if (!original?.approved_image_asset_id || !original.approved_video_asset_id)
              throw new AppError(
                'VIDEO_GENERATION_FAILED',
                `${label}: shot ${sh.position + 1} could not be made in 9:16.`,
              );
            this.s.stories.setShotState(sh.id, {
              approved_image_asset_id: original.approved_image_asset_id,
              approved_video_asset_id: original.approved_video_asset_id,
              approval_state: 'approved',
            });
            framing = 'reframed';
            reframed++;
          }
        }
        this.detail(v.id, 'shorts', `${label}: voices, music and the 9:16 video`);
        const rec = await this.s.exports.buildFinal(storyForShort, 'vertical');
        if (rec.status !== 'complete' || !rec.master_asset_id)
          throw new AppError(
            'FFMPEG_FAILED',
            `${label} could not be built: ${rec.error_message ?? 'unknown error'}`,
          );
        const master = this.s.assets.get(rec.master_asset_id);
        const caps = await this.writeCaptions(storyForShort, `videos/${v.id}/short-${short.idx + 1}`);
        let videoKey = master.storage_key;
        if (caps && this.s.settings.get('app').burnShortsCaptions && this.s.ffmpeg && !rec.is_mock) {
          const burned = await burnCaptions(
            this.s.ffmpeg,
            this.check.tempDir,
            await this.s.storage.get(master.storage_key),
            toSrt(cuesFor(this.s, this.s.timeline, storyForShort)),
          );
          if (burned) {
            videoKey = `videos/${v.id}/short-${short.idx + 1}-captioned.mp4`;
            await this.s.storage.put(videoKey, burned);
          }
        }
        this.s.videos.updateShort(short.id, {
          status: 'ready',
          framing,
          video_key: videoKey,
          duration_sec: rec.duration_sec,
          captions_srt_key: caps?.srt ?? null,
          captions_vtt_key: caps?.vtt ?? null,
          error_message: null,
        });
      } catch (err) {
        const e = toAppError(err);
        if (e.code === 'CANCELLED' || e.code === 'SESSION_BUDGET_REACHED' || e.code === 'BUDGET_EXCEEDED')
          throw e;
        this.s.videos.updateShort(short.id, { status: 'failed', error_message: e.message });
        failed.push(`${label}: ${e.message}`);
      }
    }
    const ready = this.s.videos.shorts(v.id).filter((x) => x.status === 'ready').length;
    return failed.length || reframed
      ? {
          status: 'warn',
          detail: `${ready} Short(s) ready${reframed ? `; ${reframed} shot(s) reframed from the episode instead of drawn in 9:16` : ''}${failed.length ? `; ${failed.join(' ')}` : ''}`,
        }
      : { status: 'done', detail: `${ready} Short(s) drawn natively in 9:16, with captions` };
  }

  // --- stage: thumbnails ----------------------------------------------------------------------------

  async thumbnails(v: Video): Promise<{ status: 'done' | 'warn'; detail: string }> {
    const storyId = this.storyOf(v);
    const title = this.s.videos.get(v.id).title;
    const made: string[] = [];
    if (v.make_episode) {
      const shots = this.s.stories.listStoryShots(storyId).filter((x) => x.approved_image_asset_id);
      const cast = (id: string) => this.s.stories.shotCharacters(id).length;
      const picks = [
        [...shots].sort((a, b) => cast(b.id) - cast(a.id))[0],
        shots[Math.floor(shots.length / 2)],
        shots[shots.length - 1],
      ].filter((x, i, arr) => x && arr.findIndex((y) => y?.id === x.id) === i);
      for (const [i, sh] of picks.entries()) {
        const asset = this.s.assets.get(sh!.approved_image_asset_id!);
        const out = await renderThumbnail(this.s.ffmpeg, this.check.tempDir, {
          image: await this.s.storage.get(asset.storage_key),
          ext: asset.storage_key.split('.').pop() ?? 'png',
          title,
          vertical: false,
        });
        const key = `videos/${v.id}/thumbnail-${i + 1}.${out.ext}`;
        await this.s.storage.put(key, out.data);
        made.push(key);
      }
      this.s.videos.update(v.id, { thumbnails_json: JSON.stringify(made), thumbnail_key: made[0] ?? null });
    }
    let shortsDone = 0;
    for (const short of this.s.videos.shorts(v.id).filter((x) => x.status === 'ready' && x.story_id)) {
      const first = this.s.stories.listStoryShots(short.story_id!).find((x) => x.approved_image_asset_id);
      if (!first) continue;
      const asset = this.s.assets.get(first.approved_image_asset_id!);
      const out = await renderThumbnail(this.s.ffmpeg, this.check.tempDir, {
        image: await this.s.storage.get(asset.storage_key),
        ext: asset.storage_key.split('.').pop() ?? 'png',
        title: short.hook || title,
        vertical: true,
      });
      const key = `videos/${v.id}/short-${short.idx + 1}-thumbnail.${out.ext}`;
      await this.s.storage.put(key, out.data);
      this.s.videos.updateShort(short.id, { thumbnail_key: key, thumbnails_json: JSON.stringify([key]) });
      shortsDone++;
    }
    const detail = `${made.length} episode thumbnail choice(s)${shortsDone ? `, ${shortsDone} Short thumbnail(s)` : ''}${this.s.ffmpeg ? '' : ' (without the title: FFmpeg is not installed)'}`;
    return { status: made.length || shortsDone ? 'done' : 'warn', detail };
  }

  // --- stage: metadata ------------------------------------------------------------------------------

  async metadata(v: Video): Promise<{ status: 'done'; detail: string }> {
    const now = this.s.videos.get(v.id);
    const storyId = this.storyOf(now);
    const tree = this.s.stories.tree(storyId);
    const plan = parseJson<{ logline?: string; moral?: string; characters?: string[] }>(now.plan_json, {});
    const characters = plan.characters ?? [];
    if (now.make_episode) {
      const view = this.s.timeline.view(storyId);
      const firstStart = new Map<string, number>();
      for (const item of view?.items.filter((i) => i.track === 'video' && i.source_type === 'shot') ?? []) {
        const sceneId = this.s.stories.getShot(item.source_id).scene_id;
        firstStart.set(sceneId, Math.min(firstStart.get(sceneId) ?? Infinity, item.start_sec));
      }
      const chapters = tree.scenes
        .filter((sc) => firstStart.has(sc.scene.id))
        .map((sc) => ({ startSec: Math.round(firstStart.get(sc.scene.id)!), title: sc.scene.title }));
      const exp = now.episode_export_id ? this.s.reports.getExport(now.episode_export_id) : null;
      const meta = episodeMetadata({
        title: now.title,
        logline: plan.logline ?? tree.story.synopsis,
        moral: plan.moral ?? tree.story.moral,
        characters,
        style: videoStyle(now.style_id).label,
        language: tree.story.language,
        chapters,
        totalSec: exp?.duration_sec ?? 0,
      });
      this.s.videos.update(v.id, { metadata_json: JSON.stringify(meta) });
    }
    const shorts = this.s.videos.shorts(v.id);
    for (const short of shorts)
      this.s.videos.updateShort(short.id, {
        metadata_json: JSON.stringify(
          shortMetadata({
            episodeTitle: now.title,
            hook: short.hook,
            characters,
            language: tree.story.language,
            index: short.idx,
            count: shorts.length,
          }),
        ),
      });
    return {
      status: 'done',
      detail: `drafted for the episode${shorts.length ? ` and ${shorts.length} Short(s)` : ''}; you review them before publishing`,
    };
  }

  // --- stage: quality check -----------------------------------------------------------------------

  async qualityCheck(v: Video): Promise<{ status: 'done' | 'warn'; detail: string }> {
    const storyId = this.storyOf(v);
    const findings = [
      ...this.s.quality.storyFindings(storyId),
      ...this.s.quality.visualFindings(storyId),
      ...(await this.s.quality.audioFindings(storyId)),
    ];
    const exp = v.episode_export_id ? this.s.reports.getExport(v.episode_export_id) : null;
    const validation = exp
      ? parseJson<Array<{ severity?: string; message?: string; code?: string }>>(exp.validation_json, [])
      : [];
    const all = [
      ...findings,
      ...validation.map((x) => ({
        code: x.code ?? 'export',
        severity: (x.severity ?? 'info') as 'info' | 'warn' | 'fail',
        message: x.message ?? '',
      })),
    ];
    const fails = all.filter((f) => f.severity === 'fail');
    const warns = all.filter((f) => f.severity === 'warn');
    this.s.videos.update(v.id, { qc_json: JSON.stringify(all.slice(0, 200)) });
    return {
      status: fails.length || warns.length ? 'warn' : 'done',
      detail: `${fails.length} problem(s), ${warns.length} warning(s) to look at before publishing`,
    };
  }

  // --- helpers ------------------------------------------------------------------------------------------

  storyOf(v: Video): string {
    const id = this.s.videos.get(v.id).story_id;
    if (!id) throw new AppError('PRECONDITION_FAILED', 'The story has not been written yet.');
    return id;
  }

  /** Characters appearing in the story (ids). */
  cast(storyId: string): string[] {
    return [
      ...new Set(
        this.s.db
          .all<{ character_id: string }>(
            `SELECT DISTINCT sc.character_id FROM shot_characters sc JOIN shots sh ON sh.id = sc.shot_id
             JOIN scenes s ON s.id = sh.scene_id WHERE s.story_id = ?`,
            storyId,
          )
          .map((r) => r.character_id),
      ),
    ];
  }

  private seedFor(v: Video): number {
    let h = 0;
    for (const c of v.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 2 ** 31;
  }

  private detail(videoId: string, stage: string, detail: string): void {
    this.s.videos.setStage(videoId, stage, 'running', detail);
  }

  /** Run on a cloud GPU session sized for every model this production uses. */
  private async onGpu<T>(fn: () => Promise<T>, kinds: Array<'text' | 'image' | 'video' | 'tts'>): Promise<T> {
    const models = kinds.map((k) => this.s.models.selected(k)).filter((m) => m !== undefined);
    const plan = await this.s.gpu.plan(Math.max(0, ...models.map((m) => m.minVramGb)), 600, {
      recommendedVramGb: Math.max(0, ...models.map((m) => m.recommendedVramGb)),
    });
    return this.s.gpu.withSession(plan, () => fn());
  }
}
