import type { Database } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { requireRow } from './base.ts';

export type VideoStatus =
  | 'draft'
  | 'plan_review'
  | 'generating'
  | 'needs_attention'
  | 'ready'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed'
  | 'cancelled';

export type StageStatus = 'pending' | 'running' | 'done' | 'warn' | 'failed' | 'skipped';

export interface StageRecord {
  stage: string;
  label: string;
  status: StageStatus;
  detail: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AttentionItem {
  scene_id: string | null;
  shot_id: string | null;
  kind: 'image' | 'video' | 'audio' | 'build' | 'short' | 'other';
  message: string;
}

export interface Video {
  id: string;
  project_id: string;
  story_id: string | null;
  title: string;
  idea: string;
  style_id: string;
  length_key: string;
  target_seconds: number;
  make_episode: number;
  make_shorts: number;
  shorts_count: number;
  language: string;
  narrator: string;
  music_mood: string;
  review_plan: number;
  status: VideoStatus;
  stage: string;
  stage_detail: string;
  stages_json: string;
  attention_json: string;
  plan_json: string;
  episode_export_id: string | null;
  thumbnail_key: string | null;
  thumbnails_json: string;
  captions_srt_key: string | null;
  captions_vtt_key: string | null;
  metadata_json: string;
  qc_json: string;
  cost_inr: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface VideoShort {
  id: string;
  video_id: string;
  /** The vertical story this Short is drawn from. */
  story_id: string | null;
  idx: number;
  title: string;
  hook: string;
  scene_ids_json: string;
  duration_sec: number | null;
  status: 'planned' | 'generating' | 'ready' | 'failed';
  framing: 'native' | 'reframed';
  video_key: string | null;
  captions_srt_key: string | null;
  captions_vtt_key: string | null;
  thumbnail_key: string | null;
  thumbnails_json: string;
  metadata_json: string;
  qc_json: string;
  error_message: string | null;
  created_at: string;
}

export type PublicationStatus =
  | 'ready_for_review'
  | 'approved'
  | 'uploading'
  | 'uploaded'
  | 'scheduled'
  | 'published'
  | 'blocked'
  | 'failed';

export interface Publication {
  id: string;
  video_id: string;
  short_id: string | null;
  kind: 'episode' | 'short';
  status: PublicationStatus;
  privacy: 'private' | 'unlisted' | 'public';
  publish_at: string | null;
  made_for_kids: number | null;
  synthetic_media: number;
  metadata_json: string;
  approved_at: string | null;
  youtube_video_id: string | null;
  youtube_url: string | null;
  upload_url: string | null;
  uploaded_bytes: number;
  captions_status: string | null;
  thumbnail_status: string | null;
  remote_status: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export type NewVideo = Pick<
  Video,
  | 'project_id'
  | 'title'
  | 'idea'
  | 'style_id'
  | 'length_key'
  | 'target_seconds'
  | 'make_episode'
  | 'make_shorts'
  | 'shorts_count'
  | 'language'
  | 'narrator'
  | 'music_mood'
  | 'review_plan'
>;

export class VideoRepository {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, now: () => string) {
    this.db = db;
    this.now = now;
  }

  create(v: NewVideo, stages: Array<{ stage: string; label: string }>): Video {
    const id = newId('vid');
    const at = this.now();
    const records: StageRecord[] = stages.map((s) => ({
      ...s,
      status: 'pending',
      detail: '',
      started_at: null,
      finished_at: null,
    }));
    this.db.insert('videos', {
      id,
      ...v,
      status: 'draft',
      stages_json: JSON.stringify(records),
      created_at: at,
      updated_at: at,
    });
    return this.get(id);
  }

  get(id: string): Video {
    return requireRow<Video>(this.db, 'videos', id, 'Video');
  }

  byStory(storyId: string): Video | undefined {
    return this.db.get<Video>('SELECT * FROM videos WHERE story_id = ?', storyId);
  }

  list(opts: { status?: VideoStatus[]; limit?: number } = {}): Video[] {
    const where = opts.status?.length ? `WHERE status IN (${opts.status.map(() => '?').join(', ')})` : '';
    return this.db.all<Video>(
      `SELECT * FROM videos ${where} ORDER BY created_at DESC LIMIT ?`,
      ...(opts.status ?? []),
      opts.limit ?? 200,
    );
  }

  update(id: string, values: Partial<Omit<Video, 'id' | 'created_at'>>): Video {
    this.db.update('videos', id, { ...values, updated_at: this.now() });
    return this.get(id);
  }

  stages(v: Video): StageRecord[] {
    return parseJson<StageRecord[]>(v.stages_json, []);
  }

  attention(v: Video): AttentionItem[] {
    return parseJson<AttentionItem[]>(v.attention_json, []);
  }

  /** Move a stage on; the video's current stage and detail follow the running stage. */
  setStage(id: string, stage: string, status: StageStatus, detail = ''): Video {
    const v = this.get(id);
    const stages = this.stages(v);
    const rec = stages.find((s) => s.stage === stage);
    if (!rec) throw new AppError('INTERNAL', `Unknown stage ${stage}`);
    const at = this.now();
    rec.status = status;
    rec.detail = detail;
    if (status === 'running') {
      rec.started_at = rec.started_at ?? at;
      rec.finished_at = null;
    } else if (status !== 'pending') rec.finished_at = at;
    return this.update(id, {
      stages_json: JSON.stringify(stages),
      ...(status === 'running' ? { stage, stage_detail: detail } : {}),
    });
  }

  /** Reset stages from `from` onwards to pending (a retry or regeneration starts there again). */
  resetStagesFrom(id: string, from: string): Video {
    const v = this.get(id);
    const stages = this.stages(v);
    const i = stages.findIndex((s) => s.stage === from);
    if (i < 0) throw new AppError('INTERNAL', `Unknown stage ${from}`);
    for (const s of stages.slice(i))
      Object.assign(s, { status: 'pending', detail: '', started_at: null, finished_at: null });
    return this.update(id, { stages_json: JSON.stringify(stages) });
  }

  // --- Shorts ---------------------------------------------------------------------------

  shorts(videoId: string): VideoShort[] {
    return this.db.all<VideoShort>('SELECT * FROM video_shorts WHERE video_id = ? ORDER BY idx', videoId);
  }

  getShort(id: string): VideoShort {
    return requireRow<VideoShort>(this.db, 'video_shorts', id, 'Short');
  }

  replaceShorts(
    videoId: string,
    shorts: Array<Pick<VideoShort, 'title' | 'hook' | 'scene_ids_json' | 'duration_sec'>>,
  ): VideoShort[] {
    this.db.transaction(() => {
      this.db.run('DELETE FROM video_shorts WHERE video_id = ?', videoId);
      shorts.forEach((sh, idx) =>
        this.db.insert('video_shorts', {
          id: newId('vsh'),
          video_id: videoId,
          idx,
          ...sh,
          status: 'planned',
          created_at: this.now(),
        }),
      );
    });
    return this.shorts(videoId);
  }

  updateShort(id: string, values: Partial<Omit<VideoShort, 'id' | 'video_id' | 'created_at'>>): VideoShort {
    this.db.update('video_shorts', id, values);
    return this.getShort(id);
  }

  // --- Publications ------------------------------------------------------------------------

  publications(videoId?: string): Publication[] {
    return videoId
      ? this.db.all<Publication>(
          'SELECT * FROM publications WHERE video_id = ? ORDER BY kind, created_at',
          videoId,
        )
      : this.db.all<Publication>('SELECT * FROM publications ORDER BY updated_at DESC LIMIT 500');
  }

  getPublication(id: string): Publication {
    return requireRow<Publication>(this.db, 'publications', id, 'Publication');
  }

  createPublication(
    values: Pick<Publication, 'video_id' | 'short_id' | 'kind' | 'metadata_json'> &
      Partial<Pick<Publication, 'made_for_kids' | 'privacy'>>,
  ): Publication {
    const id = newId('pub');
    const at = this.now();
    this.db.insert('publications', {
      id,
      ...values,
      status: 'ready_for_review',
      created_at: at,
      updated_at: at,
    });
    return this.getPublication(id);
  }

  updatePublication(id: string, values: Partial<Omit<Publication, 'id' | 'created_at'>>): Publication {
    this.db.update('publications', id, { ...values, updated_at: this.now() });
    return this.getPublication(id);
  }
}
