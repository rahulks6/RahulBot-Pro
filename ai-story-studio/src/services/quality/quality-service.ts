import type { StudioCore } from '../../app/studio.ts';
import type { Finding, QualityReport } from '../../domain/types.ts';
import { decodeWav, levels } from '../../media/wav.ts';
import type { ProbeResult } from '../../providers/types.ts';
import type { MixResult } from '../mixer.ts';
import type { TimelineService } from '../timeline.ts';
import { timelineDuration } from '../timeline.ts';
import { checkAudio, checkStory, checkVisual, validateExport, type ExportExpectation } from './checks.ts';
import { compareEpisodes, type EpisodeFingerprint } from './similarity.ts';
import { tokenize } from './text-similarity.ts';

export const YOUTUBE_CHECK_DISCLAIMER =
  'Internal creative quality aid only. It does not guarantee monetisation, reach or policy compliance; platform policies change and the thresholds here are configurable settings, not rules.';

export class QualityService {
  private readonly s: StudioCore;
  private readonly timeline: TimelineService;

  constructor(core: StudioCore & { timeline: TimelineService }) {
    this.s = core;
    this.timeline = core.timeline;
  }

  private q() {
    return this.s.settings.get('quality');
  }

  estimatedDuration(storyId: string): number {
    return this.s.stories.listStoryShots(storyId).reduce((sum, s) => sum + s.duration_sec, 0);
  }

  storyFindings(storyId: string): Finding[] {
    const tree = this.s.stories.tree(storyId);
    const view = this.timeline.view(storyId);
    const duration = view
      ? timelineDuration(view.items.filter((i) => i.track === 'video'))
      : this.estimatedDuration(storyId);
    return checkStory(tree, duration, this.q());
  }

  visualFindings(storyId: string): Finding[] {
    const tree = this.s.stories.tree(storyId);
    const project = this.s.projects.get(tree.story.project_id);
    const view = this.timeline.view(storyId);
    const assets = new Map(
      this.s.assets.list({ projectId: project.id, limit: 500 }).map((a) => [a.id, a] as const),
    );
    const characters = this.s.characters.list(project.id);
    return checkVisual(
      {
        project,
        tree,
        timelineVideo: view ? view.items.filter((i) => i.track === 'video') : [],
        assets,
        approvedRefCount: new Map(
          characters.map(
            (c) => [c.id, this.s.characters.listReferences(c.id).filter((r) => r.approved).length] as const,
          ),
        ),
        lockedCharacters: new Set(characters.filter((c) => c.locked).map((c) => c.id)),
        characterNames: new Map(characters.map((c) => [c.id, c.name] as const)),
      },
      this.q(),
    );
  }

  async audioFindings(storyId: string, mix?: MixResult): Promise<Finding[]> {
    const tree = this.s.stories.tree(storyId);
    const project = this.s.projects.get(tree.story.project_id);
    const view = this.timeline.view(storyId) ?? this.timeline.build(storyId);
    const m = mix ?? (await this.timeline.renderMix(storyId));
    const speechRmsDb = new Map<string, number>();
    for (const item of view.items) {
      if (
        (item.track === 'dialogue' || item.track === 'narration') &&
        item.asset_id &&
        !speechRmsDb.has(item.asset_id)
      ) {
        try {
          speechRmsDb.set(
            item.asset_id,
            levels(decodeWav(await this.s.assets.read(item.asset_id)).samples).rmsDb,
          );
        } catch {
          // reported as missing by the mixer
        }
      }
    }
    return checkAudio(
      {
        tree,
        items: view.items,
        mix: m,
        speechRmsDb,
        videoEndSec: timelineDuration(view.items.filter((i) => i.track === 'video')),
        narratorConfigured: Boolean(project.narrator_voice_id),
      },
      this.q(),
    );
  }

  fingerprint(storyId: string): EpisodeFingerprint {
    const tree = this.s.stories.tree(storyId);
    const clipChecksums: string[] = [];
    const audioChecksums: string[] = [];
    const checksumOf = (id: string | null | undefined, into: string[]): void => {
      const a = this.s.assets.find(id);
      if (a && !a.continuity_tag) into.push(a.checksum);
    };
    const shots = tree.scenes.flatMap((s) => s.shots);
    for (const sh of shots) checksumOf(sh.shot.approved_video_asset_id, clipChecksums);
    for (const s of tree.scenes) {
      for (const n of s.narration)
        checksumOf(this.s.assets.findAudio(n.audio_asset_id)?.generated_asset_id, audioChecksums);
      for (const sh of s.shots)
        for (const d of sh.dialogue)
          checksumOf(this.s.assets.findAudio(d.audio_asset_id)?.generated_asset_id, audioChecksums);
    }
    const locName = (id: string | null) => (id ? this.s.characters.getLocation(id).name : '');
    return {
      storyId,
      title: tree.story.title,
      label:
        tree.story.episode_number !== null ? `Episode ${tree.story.episode_number}` : `"${tree.story.title}"`,
      storyText: [
        tree.story.synopsis,
        tree.story.story_text,
        ...tree.scenes.map((s) => s.scene.summary),
      ].join('\n'),
      dialogue: shots.flatMap((sh) => sh.dialogue.map((d) => d.text)),
      narration: tree.scenes.flatMap((s) => s.narration.map((n) => n.text)),
      prompts: shots.map((sh) => [sh.shot.action, sh.shot.image_prompt].join(' ')),
      shotPlan: shots.map((sh) =>
        [sh.shot.framing, sh.shot.camera_angle, sh.shot.camera_movement, sh.shot.location_id ?? '']
          .join('|')
          .toLowerCase(),
      ),
      sceneStructure: tree.scenes.map((s) =>
        `${locName(s.scene.location_id)}|${s.scene.music_mood}`.toLowerCase(),
      ),
      clipChecksums,
      audioChecksums,
    };
  }

  /** Similarity vs. previous episodes in the same project (spec §55, §59). */
  runSimilarity(storyId: string): { findings: Finding[] } {
    const story = this.s.stories.get(storyId);
    const others = this.s.stories
      .list(story.project_id)
      .filter((s) => s.id !== storyId && s.created_at <= story.created_at);
    const recurring = new Set<string>([
      ...this.s.characters.list(story.project_id).flatMap((c) => tokenize(c.name)),
      ...this.s.characters.listLocations(story.project_id).flatMap((l) => tokenize(l.name)),
    ]);
    const { rows, findings } = compareEpisodes(
      this.fingerprint(storyId),
      others.map((o) => this.fingerprint(o.id)),
      recurring,
      this.q(),
    );
    this.s.reports.replaceSimilarity(storyId, rows);
    return { findings };
  }

  /** Run every pre-export check and store one report per kind plus the aggregate YouTube Quality Check. */
  async runAll(storyId: string): Promise<QualityReport[]> {
    const story = this.storyFindings(storyId);
    const visual = this.visualFindings(storyId);
    const audio = await this.audioFindings(storyId);
    const similarity = this.runSimilarity(storyId).findings;
    const reviewDone = this.s.reports.checklistComplete(storyId);
    const youtube: Finding[] = [
      { code: 'disclaimer', severity: 'info', message: YOUTUBE_CHECK_DISCLAIMER },
      ...story.filter((f) => f.severity !== 'info'),
      ...visual.filter((f) => f.severity !== 'info'),
      ...audio.filter((f) => f.severity !== 'info'),
      ...similarity,
      reviewDone
        ? { code: 'human_review', severity: 'info', message: 'Human review checklist complete.' }
        : { code: 'human_review', severity: 'warn', message: 'Human review checklist is not complete.' },
    ];
    this.s.reports.saveQuality(storyId, 'story', story);
    this.s.reports.saveQuality(storyId, 'visual', visual);
    this.s.reports.saveQuality(storyId, 'audio', audio);
    this.s.reports.saveQuality(storyId, 'youtube', youtube);
    return this.s.reports.latestQuality(storyId);
  }

  exportFindings(probe: ProbeResult, exp: ExportExpectation, audioFindings: Finding[]): Finding[] {
    return validateExport(probe, exp, audioFindings);
  }
}
