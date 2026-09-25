import type { StudioCore } from '../app/studio.ts';
import type { ExportFormat } from '../domain/enums.ts';
import { EXPORT_PROFILES } from '../domain/enums.ts';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportRecord, Finding, GeneratedAsset, TimelineItem } from '../domain/types.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { encodeWav } from '../media/wav.ts';
import { findTitleFont, type FfmpegTools } from '../media/ffmpeg.ts';
import { FfprobeMediaProbe } from '../providers/ffprobe.ts';
import { MOCK_MASTER_MIME, MOCK_VIDEO_MIME } from '../providers/mock/common.ts';
import type { MockVideoManifest } from '../providers/mock/image.ts';
import type { MockMasterManifest } from '../providers/mock/probe.ts';
import type { ProbeResult } from '../providers/types.ts';
import { statusFromFindings } from '../repositories/reports.ts';
import { EpisodeAssembler, type AssemblySegment } from './assembler.ts';
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
 * the export COMPLETE when validation passes. With local FFmpeg (Phase 4) the
 * master is a real H.264/AAC MP4, loudness-normalised and validated with
 * ffprobe; without it, a mock manifest plus the real WAV mix stands in.
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

  /** FFmpeg for assembly per ASSEMBLY_MODE; throws when `ffmpeg` is required but missing. */
  private ffmpegTools(): FfmpegTools | null {
    if (this.s.env.assemblyMode === 'mock') return null;
    if (!this.s.ffmpeg && this.s.env.assemblyMode === 'ffmpeg')
      throw new AppError(
        'PRECONDITION_FAILED',
        'ASSEMBLY_MODE=ffmpeg but FFmpeg was not found. Install FFmpeg or set FFMPEG_PATH / FFPROBE_PATH.',
      );
    return this.s.ffmpeg;
  }

  /**
   * Timeline video items → assembly segments. Real clips (video/*) are used as
   * footage; mock clips resolve to their source still; approved images are
   * used as stills. Each slot runs until the next one starts, so the picture
   * length always equals the timeline (and the audio mix).
   */
  private async segments(
    items: TimelineItem[],
  ): Promise<{ segments: AssemblySegment[]; mockVisuals: number }> {
    const segments: AssemblySegment[] = [];
    let mockVisuals = 0;
    for (const [i, item] of items.entries()) {
      const asset = this.s.assets.find(item.asset_id);
      if (!asset)
        throw new AppError('PRECONDITION_FAILED', `Shot "${item.label}" has no clip on the timeline`);
      let kind: AssemblySegment['kind'];
      let key = asset.storage_key;
      if (asset.mime.startsWith('video/')) kind = 'video';
      else if (asset.mime.startsWith('image/')) kind = 'still';
      else if (asset.mime === MOCK_VIDEO_MIME) {
        const m = JSON.parse((await this.s.assets.read(asset.id)).toString('utf8')) as MockVideoManifest;
        kind = 'still';
        key = m.sourceImageKey;
      } else
        throw new AppError('PRECONDITION_FAILED', `Unsupported clip type ${asset.mime} for "${item.label}"`);
      if (asset.is_mock) mockVisuals++;
      if (!(await this.s.storage.exists(key)))
        throw new AppError('NOT_FOUND', `Media for "${item.label}" is missing from storage`);
      const next = items[i + 1];
      const slot = next ? next.start_sec - item.start_sec : item.duration_sec;
      segments.push({
        kind,
        path: this.s.storage.localPath(key),
        durationSec: Math.max(1 / 24, Math.round(slot * 1000) / 1000),
        trimInSec: kind === 'video' ? item.trim_in_sec : 0,
        transition: item.transition,
      });
    }
    return { segments, mockVisuals };
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
    let workDir: string | undefined;
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
      const tools = this.ffmpegTools();
      const enc = this.s.settings.get('encoding');
      const mix = await this.timeline.renderMix(
        storyId,
        undefined,
        tools ? Number(enc.sampleRate) : undefined,
      );
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

      // 6. Encode master: real H.264/AAC MP4 with local FFmpeg, else the mock manifest.
      const videoItems = view.items
        .filter((i) => i.track === 'video')
        .sort((a, b) => a.start_sec - b.start_sec);
      const duration = timelineDuration(videoItems);
      const reframe = format === 'vertical' ? ' (centre-crop reframe of episode footage)' : '';
      const extraFindings: Finding[] = [];
      let master: GeneratedAsset;
      let masterDuration: number;
      let probe: ProbeResult;
      if (tools) {
        workDir = join(this.s.env.dataDir, 'tmp', `build-${rec.id}`);
        await rm(workDir, { recursive: true, force: true });
        await mkdir(workDir, { recursive: true });
        const mixPath = join(workDir, 'mix.wav');
        await writeFile(mixPath, encodeWav(mix.pcm));
        const { segments, mockVisuals } = await this.segments(videoItems);
        const titles = view.items
          .filter((i) => i.track === 'title' && i.label.trim())
          .map((i) => ({ text: i.label, startSec: i.start_sec, durationSec: i.duration_sec }));
        const out = await new EpisodeAssembler(tools, findTitleFont()).assemble({
          segments,
          titles,
          mixWavPath: mixPath,
          width: profile.width,
          height: profile.height,
          fps: project.fps,
          workDir,
          encoding: enc,
        });
        master = await this.s.assets.createFromFile(
          {
            projectId: project.id,
            kind: 'master',
            ext: 'mp4',
            mime: 'video/mp4',
            width: profile.width,
            height: profile.height,
            durationSec: out.durationSec,
            fps: project.fps,
            isMock: mockVisuals > 0,
            label: `${story.title} — ${format} master${mockVisuals ? ' (mock visuals)' : ''}`,
          },
          out.masterPath,
        );
        masterDuration = out.durationSec;
        const l = out.loudness;
        log(
          'encode',
          'ok',
          [
            `FFmpeg ${profile.width}×${profile.height} @${project.fps}fps H.264 (CRF ${enc.videoCrf}, ${enc.preset}) + AAC ${enc.audioBitrateKbps}k ${enc.sampleRate} Hz stereo${reframe}`,
            l.normalised
              ? `loudness ${l.inputLufs} → ${l.outputLufs} LUFS (target ${enc.targetLufs}), true peak ${l.outputTruePeakDb} dBTP`
              : 'loudness normalisation skipped',
            `${out.transitions.crossfades} crossfade(s), ${out.transitions.fades} fade(s), ${out.titlesDrawn} title card(s)`,
            ...(mockVisuals ? [`${mockVisuals} shot(s) use mock placeholder stills`] : []),
            ...out.warnings,
          ].join('; '),
        );
        if (mockVisuals > 0) {
          extraFindings.push({
            code: 'mock_visuals',
            severity: 'info',
            message: `${mockVisuals} shot(s) are mock placeholders (still + push-in). The MP4 is real; the footage is not.`,
          });
        }
        if (l.normalised && l.outputLufs !== null && Math.abs(l.outputLufs - enc.targetLufs) > 1) {
          extraFindings.push({
            code: 'loudness_target',
            severity: 'warn',
            message: `Integrated loudness ${l.outputLufs} LUFS is more than 1 LU from the ${enc.targetLufs} LUFS target.`,
          });
        }
        for (const w of out.warnings)
          extraFindings.push({ code: 'assembly_warning', severity: 'warn', message: w });
        probe = await new FfprobeMediaProbe(this.s.storage, tools.ffprobe, tools.ffmpeg).probe(
          master.storage_key,
        );
      } else {
        const manifest: MockMasterManifest = {
          format: 'ai-story-studio/mock-master',
          version: 1,
          note: 'MOCK MASTER — no MP4 was encoded (FFmpeg not installed, or ASSEMBLY_MODE=mock).',
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
        master = await this.s.assets.create({
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
        masterDuration = manifest.durationSec;
        log(
          'encode',
          'ok',
          `mock ${profile.width}×${profile.height} @${project.fps}fps H.264/AAC manifest${reframe}`,
        );
        probe = await this.s.providers.probe.probe(master.storage_key);
      }

      // 7. Verify output.
      this.s.reports.updateExport(rec.id, {
        status: 'validating',
        master_asset_id: master.id,
        mix_asset_id: mixAsset.id,
        duration_sec: masterDuration,
      });
      const audioFindings = await this.quality.audioFindings(storyId, mix);
      const scenesWithClips = new Set<string>();
      for (const v of videoItems)
        if (v.asset_id) scenesWithClips.add(this.s.stories.getShot(v.source_id).scene_id);
      const findings: Finding[] = this.quality
        .exportFindings(
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
        )
        .concat(extraFindings);
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
        logger.info('export complete', { status: 'complete', duration: masterDuration });
      }
    } catch (err) {
      const e = toAppError(err);
      log('error', 'failed', e.message);
      this.s.reports.updateExport(rec.id, { status: 'failed', error_message: e.message });
      logger.error('export failed', { error: e.message, code: e.code });
    }
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return this.s.reports.getExport(rec.id);
  }
}
