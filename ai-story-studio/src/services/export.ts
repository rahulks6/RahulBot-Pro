import type { StudioCore } from '../app/studio.ts';
import type { ExportFormat } from '../domain/enums.ts';
import { EXPORT_PROFILES } from '../domain/enums.ts';
import type { ExportRecord, Finding } from '../domain/types.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { encodeWav } from '../media/wav.ts';
import { MOCK_MASTER_MIME } from '../providers/mock/common.ts';
import type { MockMasterManifest } from '../providers/mock/probe.ts';
import { statusFromFindings } from '../repositories/reports.ts';
import type { AudioPipeline } from './audio-pipeline.ts';
import type { GenerationService } from './generation.ts';
import type { QualityService } from './quality/quality-service.ts';
import type { TimelineService } from './timeline.ts';
import { timelineDuration } from './timeline.ts';

export interface BuildStep {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
}

/**
 * BUILD FINAL (spec §22, §51–§52). Runs the whole assembly and only marks
 * the export COMPLETE when validation passes. In Phase 1 the "master" is a
 * mock manifest plus a real WAV mix (no MP4 encoding yet); the validation
 * logic is the same one that will validate real FFmpeg masters.
 */
export class ExportService {
  private readonly s: StudioCore;
  private readonly audio: AudioPipeline;
  private readonly generation: GenerationService;
  private readonly timeline: TimelineService;
  private readonly quality: QualityService;

  constructor(
    core: StudioCore & {
      audio: AudioPipeline;
      generation: GenerationService;
      timeline: TimelineService;
      quality: QualityService;
    },
  ) {
    this.s = core;
    this.audio = core.audio;
    this.generation = core.generation;
    this.timeline = core.timeline;
    this.quality = core.quality;
  }

  private async runAudioJobs(
    count: number,
    step: string,
    log: (step: string, status: BuildStep['status'], detail: string) => void,
  ): Promise<void> {
    if (count === 0) {
      log(step, 'skipped', 'all audio already present (reused)');
      return;
    }
    const r = await this.generation.processQueue();
    log(step, r.failed > 0 ? 'failed' : 'ok', `${count} job(s): ${r.completed} complete, ${r.failed} failed`);
    if (r.failed > 0)
      throw new AppError('TTS_FAILED', 'Some audio could not be generated; see the Generation Queue.');
  }

  async buildFinal(storyId: string, format: ExportFormat = 'landscape'): Promise<ExportRecord> {
    const story = this.s.stories.get(storyId);
    const project = this.s.projects.get(story.project_id);
    const profile = EXPORT_PROFILES[format];
    const rec = this.s.reports.createExport(
      storyId,
      format,
      profile.width,
      profile.height,
      project.fps,
      this.s.env.mockGeneration,
    );
    const steps: BuildStep[] = [];
    const log = (step: string, status: BuildStep['status'], detail: string): void => {
      steps.push({ step, status, detail });
      this.s.reports.updateExport(rec.id, { steps_json: JSON.stringify(steps) });
    };
    const logger = this.s.logger.child({ export: rec.id, story: storyId, project: project.id });
    try {
      // 1. Validate story and approved shots.
      const tree = this.s.stories.tree(storyId);
      if (tree.scenes.length === 0) throw new AppError('PRECONDITION_FAILED', 'Story has no scenes');
      const shots = tree.scenes.flatMap((s) => s.shots);
      const unapproved = shots.filter((sh) => !sh.shot.approved_video_asset_id);
      if (shots.length === 0 || unapproved.length > 0) {
        throw new AppError(
          'PRECONDITION_FAILED',
          `${unapproved.length} shot(s) have no approved clip: ${unapproved
            .map((u) => u.shot.title || u.shot.id)
            .slice(0, 5)
            .join(', ')}`,
        );
      }
      log('validate_story', 'ok', `${tree.scenes.length} scenes, ${shots.length} approved shots`);

      // 2. Generate missing narration / dialogue / music / ambience / SFX.
      // Speech first: its length decides scene durations, which music is generated for.
      let speechJobs = 0;
      for (const s of tree.scenes) {
        for (const n of s.narration) {
          if (!n.audio_asset_id) {
            this.generation.queueNarrationAudio(n.id);
            speechJobs++;
          }
        }
        for (const sh of s.shots) {
          for (const d of sh.dialogue) {
            if (!d.audio_asset_id) {
              this.generation.queueDialogueAudio(d.id);
              speechJobs++;
            }
          }
        }
      }
      await this.runAudioJobs(speechJobs, 'generate_speech', log);
      let bedJobs = 0;
      const durations = this.timeline.sceneDurations(storyId);
      for (const s of tree.scenes) {
        const sceneDur = durations.get(s.scene.id) ?? this.generation.sceneDuration(s.scene.id);
        if (s.scene.music_mood && !this.audio.findSceneAudio(s.scene, 'music', sceneDur)) {
          this.generation.queueSceneAudio(s.scene.id, 'music', { params: { durationSec: sceneDur } });
          bedJobs++;
        }
        if (s.scene.ambience && !this.audio.findSceneAudio(s.scene, 'ambience', sceneDur)) {
          this.generation.queueSceneAudio(s.scene.id, 'ambience');
          bedJobs++;
        }
        for (const sh of s.shots) {
          for (const cue of sh.sfx.filter((c) => c.approved)) {
            if (!this.audio.findSfxAudio(cue)) {
              this.generation.queueSfx(cue.id);
              bedJobs++;
            }
          }
        }
      }
      await this.runAudioJobs(bedJobs, 'generate_music_sfx_ambience', log);

      // 3. Lip sync where a speaking mouth is visible and lip sync is enabled.
      let lip = 0;
      for (const sh of shots) {
        const shot = this.s.stories.getShot(sh.shot.id);
        const hasDialogue = this.s.stories.listDialogue(shot.id).some((d) => d.audio_asset_id);
        if (shot.mouth_visible && shot.lipsync_enabled && hasDialogue && !shot.lipsync_video_asset_id) {
          this.generation.queueLipsync(shot.id);
          lip++;
        }
      }
      if (lip > 0) {
        const r = await this.generation.processQueue();
        log('lip_sync', r.failed > 0 ? 'failed' : 'ok', `${lip} shot(s); ${r.messages.join(' ')}`.trim());
        if (r.failed > 0) throw new AppError('LIPSYNC_FAILED', 'Lip sync failed for some shots');
      } else log('lip_sync', 'skipped', 'no visible speaking mouths requiring lip sync');

      // 4. Arrange clips, place dialogue/narration/SFX/ambience/music.
      const view = this.timeline.build(storyId);
      log(
        'arrange_timeline',
        'ok',
        `${view.items.length} items, ${view.durationSec.toFixed(1)}s${view.warnings.length ? `; ${view.warnings.join(' ')}` : ''}`,
      );

      // 5. Mix: ducking, normalisation, peak protection.
      const mix = await this.timeline.renderMix(storyId);
      const mixAsset = await this.s.assets.create({
        projectId: project.id,
        kind: 'mix',
        data: encodeWav(mix.pcm),
        ext: 'wav',
        mime: 'audio/wav',
        durationSec: mix.durationSec,
        isMock: false,
        label: `${story.title} — final mix`,
      });
      log(
        'mix_audio',
        'ok',
        `peak before protection ${mix.preLimiterPeakDb} dBFS, gain ${mix.limiterGainDb} dB, ducking ${this.s.settings.get('audioMix').duckingEnabled ? 'on' : 'off'}`,
      );

      // 6. Encode master (mock manifest in Phase 1).
      const videoItems = view.items.filter((i) => i.track === 'video');
      const duration = timelineDuration(videoItems);
      const manifest: MockMasterManifest = {
        format: 'ai-story-studio/mock-master',
        version: 1,
        note: 'MOCK MASTER — Phase 1 does not encode MP4. Real H.264/AAC encoding with FFmpeg arrives in Phase 4.',
        container: 'mp4',
        durationSec: Math.round(mix.durationSec * 1000) / 1000,
        video: { codec: 'h264', width: profile.width, height: profile.height, fps: project.fps },
        audio: { codec: 'aac', mixKey: mixAsset.storage_key },
        clips: videoItems
          .filter((i) => i.asset_id)
          .map((i) => ({
            shotId: i.source_id,
            storageKey: this.s.assets.get(i.asset_id!).storage_key,
            startSec: i.start_sec,
            durationSec: i.duration_sec,
          })),
      };
      const master = await this.s.assets.create({
        projectId: project.id,
        kind: 'master',
        data: Buffer.from(JSON.stringify(manifest, null, 2)),
        ext: 'json',
        mime: MOCK_MASTER_MIME,
        width: profile.width,
        height: profile.height,
        durationSec: manifest.durationSec,
        fps: project.fps,
        isMock: true,
        label: `${story.title} — ${format} master (mock)`,
      });
      log(
        'encode',
        'ok',
        `mock ${profile.width}×${profile.height} @${project.fps}fps H.264/AAC manifest${format === 'vertical' ? ' (centre-crop reframe of episode footage)' : ''}`,
      );

      // 7. Verify output.
      this.s.reports.updateExport(rec.id, {
        status: 'validating',
        master_asset_id: master.id,
        mix_asset_id: mixAsset.id,
        duration_sec: manifest.durationSec,
      });
      const probe = await this.s.providers.probe.probe(master.storage_key);
      const audioFindings = await this.quality.audioFindings(storyId, mix);
      const scenesWithClips = new Set<string>();
      for (const c of manifest.clips) scenesWithClips.add(this.s.stories.getShot(c.shotId).scene_id);
      const findings: Finding[] = this.quality.exportFindings(
        probe,
        {
          width: profile.width,
          height: profile.height,
          fps: project.fps,
          durationSec: duration,
          sceneIds: tree.scenes.map((s) => s.scene.id),
          scenesWithClips,
        },
        audioFindings,
      );
      this.s.reports.saveQuality(storyId, 'technical', findings, rec.id);
      const status = statusFromFindings(findings);
      if (status === 'fail') {
        const msg = findings
          .filter((x) => x.severity === 'fail')
          .map((x) => x.message)
          .join(' ');
        log('validate_output', 'failed', msg);
        this.s.reports.updateExport(rec.id, {
          status: 'failed',
          error_message: `Validation failed: ${msg}`,
          validation_json: JSON.stringify(findings),
        });
        logger.warn('export validation failed', { status: 'failed' });
      } else {
        log('validate_output', 'ok', `${findings.filter((x) => x.severity === 'warn').length} warning(s)`);
        this.s.reports.updateExport(rec.id, {
          status: 'complete',
          validation_json: JSON.stringify(findings),
          completed_at: this.s.clock.now().toISOString(),
        });
        if (story.status === 'draft' || story.status === 'in_production')
          this.s.stories.update(storyId, { status: 'review' });
        logger.info('export complete', { status: 'complete', duration: manifest.durationSec });
      }
    } catch (err) {
      const e = toAppError(err);
      log('error', 'failed', e.message);
      this.s.reports.updateExport(rec.id, { status: 'failed', error_message: e.message });
      logger.error('export failed', { error: e.message, code: e.code });
    }
    return this.s.reports.getExport(rec.id);
  }
}
