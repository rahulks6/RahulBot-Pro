import type { StudioCore } from '../app/studio.ts';
import type { AudioLayer } from '../domain/enums.ts';
import type { Scene, Shot, Timeline, TimelineItem } from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { decodeWav, encodeWav, type PcmAudio } from '../media/wav.ts';
import { estimateSpeechSeconds } from '../providers/mock/audio.ts';
import type { NewTimelineItem } from '../repositories/timeline.ts';
import { SPEECH_GAP_SEC, SPEECH_LEAD_SEC, type AudioPipeline } from './audio-pipeline.ts';
import { AUDIO_TRACKS, mixTimeline, type MixResult } from './mixer.ts';

export interface TimelineView {
  timeline: Timeline;
  items: TimelineItem[];
  durationSec: number;
  warnings: string[];
}

/**
 * Automatic timeline (spec §33, §50): places approved clips, dialogue,
 * narration, SFX, ambience and music from story timing. Items the user has
 * edited (manual = 1) are preserved across rebuilds, and the automatic item
 * for the same source is then skipped.
 */
interface SpeechLine {
  kind: 'narration' | 'dialogue';
  id: string;
  text: string;
  speed: number;
  emotion: string;
  audioId: string | null;
  label: string;
}

interface ShotPlan {
  shot: Shot;
  startSec: number;
  slotSec: number;
  holdSec: number;
  speech: Array<{ line: SpeechLine; startSec: number; durationSec: number; assetId: string | null }>;
}

interface ScenePlan {
  scene: Scene;
  startSec: number;
  durationSec: number;
  shots: ShotPlan[];
}

export interface TimelinePlan {
  scenes: ScenePlan[];
  durationSec: number;
  warnings: string[];
}

export class TimelineService {
  private readonly s: StudioCore;
  private readonly audio: AudioPipeline;

  constructor(core: StudioCore & { audio: AudioPipeline }) {
    this.s = core;
    this.audio = core.audio;
  }

  view(storyId: string): TimelineView | undefined {
    const timeline = this.s.timelines.forStory(storyId);
    if (!timeline) return undefined;
    const items = this.s.timelines.items(timeline.id);
    return { timeline, items, durationSec: timelineDuration(items), warnings: [] };
  }

  /**
   * Compute placements without writing anything: shot slots (a shot is
   * extended — last frame held — when its speech is longer than the clip),
   * speech positions and scene spans. Used by build() and by audio
   * generation so music is generated for the exact scene length.
   */
  plan(storyId: string): TimelinePlan {
    const scenes: ScenePlan[] = [];
    const warnings: string[] = [];
    let t = 0;
    for (const scene of this.s.stories.listScenes(storyId)) {
      const sceneStart = t;
      const shots = this.s.stories.listShots(scene.id);
      const sceneNarration = this.s.stories.listNarration(scene.id);
      const shotPlans: ShotPlan[] = [];
      shots.forEach((shot, idx) => {
        const lines: SpeechLine[] = [
          ...(idx === 0
            ? sceneNarration.filter((n) => !n.shot_id || !shots.some((x) => x.id === n.shot_id))
            : []),
          ...sceneNarration.filter((n) => n.shot_id === shot.id),
        ].map((n) => ({
          kind: 'narration',
          id: n.id,
          text: n.text,
          speed: n.speed,
          emotion: n.emotion,
          audioId: n.audio_asset_id,
          label: `Narrator: ${n.text}`,
        }));
        for (const d of this.s.stories.listDialogue(shot.id)) {
          const who = d.character_id ? this.s.characters.get(d.character_id).name : 'Unknown';
          lines.push({
            kind: 'dialogue',
            id: d.id,
            text: d.text,
            speed: d.speed,
            emotion: d.emotion,
            audioId: d.audio_asset_id,
            label: `${who}: ${d.text}`,
          });
        }
        const speech: ShotPlan['speech'] = [];
        let cursor = t + SPEECH_LEAD_SEC;
        for (const line of lines) {
          const audio = this.s.assets.findAudio(line.audioId);
          const dur = audio?.duration_sec ?? estimateSpeechSeconds(line.text, line.speed, line.emotion);
          speech.push({
            line,
            startSec: cursor,
            durationSec: dur,
            assetId: audio?.generated_asset_id ?? null,
          });
          cursor += dur + SPEECH_GAP_SEC;
        }
        const speechEnd = lines.length ? cursor - SPEECH_GAP_SEC + 0.2 : t;
        const slot = Math.max(shot.duration_sec, speechEnd - t);
        const hold = slot - shot.duration_sec;
        if (hold > 0.05)
          warnings.push(
            `Shot "${shot.title || shot.id}" speech runs ${hold.toFixed(1)}s past the clip; last frame is held.`,
          );
        shotPlans.push({ shot, startSec: t, slotSec: slot, holdSec: hold > 0.05 ? hold : 0, speech });
        t += slot;
      });
      scenes.push({ scene, startSec: sceneStart, durationSec: t - sceneStart, shots: shotPlans });
    }
    return { scenes, durationSec: t, warnings };
  }

  sceneDurations(storyId: string): Map<string, number> {
    return new Map(this.plan(storyId).scenes.map((p) => [p.scene.id, p.durationSec] as const));
  }

  build(storyId: string): TimelineView {
    const story = this.s.stories.get(storyId);
    const project = this.s.projects.get(story.project_id);
    const tl = this.s.timelines.ensure(storyId, project.fps);
    const plan = this.plan(storyId);
    this.s.db.transaction(() => {
      this.s.timelines.clearAutomatic(tl.id);
      const manual = this.s.timelines.items(tl.id);
      const manualSources = new Set(
        manual.filter((m) => m.source_id).map((m) => `${m.track}:${m.source_type}:${m.source_id}`),
      );
      const add = (i: NewTimelineItem): void => {
        if (manualSources.has(`${i.track}:${i.sourceType}:${i.sourceId}`)) return;
        this.s.timelines.addItem(tl.id, i);
      };
      let videoPos = 0;
      for (const sp of plan.scenes) {
        const { scene } = sp;
        sp.shots.forEach((p, idx) => {
          for (const s of p.speech) {
            add({
              track: s.line.kind,
              assetId: s.assetId,
              sourceType: s.line.kind,
              sourceId: s.line.id,
              label: s.line.label.slice(0, 120),
              startSec: s.startSec,
              durationSec: s.durationSec,
            });
          }
          const clip = this.s.assets.find(p.shot.lipsync_video_asset_id ?? p.shot.approved_video_asset_id);
          add({
            track: 'video',
            position: videoPos++,
            assetId: clip?.id ?? null,
            sourceType: 'shot',
            sourceId: p.shot.id,
            label: `${scene.title} / ${p.shot.title || `Shot ${p.shot.position + 1}`}${p.holdSec ? ` (+${p.holdSec.toFixed(1)}s hold)` : ''}`,
            startSec: p.startSec,
            durationSec: p.slotSec,
            transition: idx === 0 && sp.startSec > 0 ? 'crossfade' : 'cut',
          });
          for (const cue of this.s.stories.listShotSfx(p.shot.id).filter((c) => c.approved)) {
            const audio = this.audio.findSfxAudio(cue);
            add({
              track: 'sfx',
              assetId: audio?.generated_asset_id ?? null,
              sourceType: 'shot_sfx',
              sourceId: cue.id,
              label: `SFX: ${cue.tag}`,
              startSec: p.startSec + Math.min(cue.offset_sec, p.slotSec - 0.1),
              durationSec: Math.min(audio?.duration_sec ?? 1.5, p.slotSec),
              fadeOutSec: 0.1,
            });
          }
        });
        const sceneDur = sp.durationSec;
        if (sceneDur <= 0) continue;
        if (scene.music_mood) {
          const music = this.audio.findSceneAudio(scene, 'music', sceneDur);
          add({
            track: 'music',
            assetId: music?.generated_asset_id ?? null,
            sourceType: 'scene',
            sourceId: scene.id,
            label: `Music: ${scene.music_mood}`,
            startSec: sp.startSec,
            durationSec: sceneDur,
            fadeInSec: Math.min(1, sceneDur / 4),
            fadeOutSec: Math.min(1.5, sceneDur / 4),
            transition: 'crossfade',
          });
        }
        if (scene.ambience) {
          const amb = this.audio.findSceneAudio(scene, 'ambience', sceneDur);
          add({
            track: 'ambience',
            assetId: amb?.generated_asset_id ?? null,
            sourceType: 'scene',
            sourceId: scene.id,
            label: `Ambience: ${scene.ambience}`,
            startSec: sp.startSec,
            durationSec: sceneDur,
            fadeInSec: 0.5,
            fadeOutSec: 0.5,
            loop: true,
          });
        }
      }
      this.s.timelines.touch(tl.id);
    });
    const items = this.s.timelines.items(tl.id);
    return { timeline: tl, items, durationSec: timelineDuration(items), warnings: plan.warnings };
  }

  /** Add a title card (intro/outro/title) to the title track. */
  addTitle(storyId: string, text: string, startSec: number, durationSec: number): TimelineItem {
    const tl = this.s.timelines.forStory(storyId);
    if (!tl) throw new AppError('PRECONDITION_FAILED', 'Build the timeline first');
    return this.s.timelines.addItem(tl.id, {
      track: 'title',
      sourceType: 'title',
      sourceId: '',
      label: text.slice(0, 200),
      startSec,
      durationSec,
      manual: true,
    });
  }

  /** Render the audio mix (optionally soloing layers) from the current timeline. */
  async renderMix(
    storyId: string,
    layers?: readonly AudioLayer[],
    sampleRate?: number,
  ): Promise<MixResult & { items: TimelineItem[] }> {
    const view = this.view(storyId) ?? this.build(storyId);
    const audio = new Map<string, PcmAudio>();
    for (const item of view.items) {
      if (!item.asset_id || audio.has(item.asset_id) || !AUDIO_TRACKS.includes(item.track as AudioLayer))
        continue;
      try {
        audio.set(item.asset_id, decodeWav(await this.s.assets.read(item.asset_id)));
      } catch {
        // Missing/corrupt audio is reported by the mixer as a missing item.
      }
    }
    const videoEnd = timelineDuration(view.items.filter((i) => i.track === 'video'));
    const result = mixTimeline({
      items: view.items,
      audio,
      durationSec: videoEnd || view.durationSec,
      settings: this.s.settings.get('audioMix'),
      ...(layers ? { layers } : {}),
      ...(sampleRate ? { sampleRate } : {}),
    });
    return { ...result, items: view.items };
  }

  /** Write a preview WAV (ephemeral, overwritten each time) and return its storage key. */
  async writePreview(
    storyId: string,
    layers?: readonly AudioLayer[],
  ): Promise<{ key: string; mix: MixResult }> {
    const story = this.s.stories.get(storyId);
    const mix = await this.renderMix(storyId, layers);
    const name = layers && layers.length ? layers.join('-') : 'full';
    const key = `projects/${story.project_id}/previews/${storyId}-${name}.wav`;
    await this.s.storage.put(key, encodeWav(mix.pcm));
    return { key, mix };
  }
}

export function timelineDuration(items: TimelineItem[]): number {
  return Math.round(items.reduce((m, i) => Math.max(m, i.start_sec + i.duration_sec), 0) * 1000) / 1000;
}
