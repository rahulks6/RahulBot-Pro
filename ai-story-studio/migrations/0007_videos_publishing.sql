-- v1.2: Simple Mode videos (one idea → full episode + Shorts), their Shorts, captions, thumbnails,
-- YouTube metadata and publishing. Additive only: existing projects, stories and exports are untouched.
-- Rollback: restore the automatic backup in data/backups.

-- One row per "CREATE NEW VIDEO". The story, scenes and shots it produces are ordinary rows in the
-- existing tables (story_id), so every Advanced tool keeps working on them.
CREATE TABLE videos (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id        TEXT REFERENCES stories(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  idea            TEXT NOT NULL,
  style_id        TEXT NOT NULL,
  length_key      TEXT NOT NULL,
  target_seconds  INTEGER NOT NULL,
  make_episode    INTEGER NOT NULL DEFAULT 1,
  make_shorts     INTEGER NOT NULL DEFAULT 1,
  shorts_count    INTEGER NOT NULL DEFAULT 2,
  language        TEXT NOT NULL DEFAULT 'en',
  narrator        TEXT NOT NULL DEFAULT 'female',
  music_mood      TEXT NOT NULL DEFAULT 'auto',
  review_plan     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN (
                    'draft', 'plan_review', 'generating', 'needs_attention', 'ready', 'approved',
                    'scheduled', 'published', 'failed', 'cancelled')),
  -- The orchestrator stage running now (see src/services/orchestrator.ts) and what it is doing.
  stage           TEXT NOT NULL DEFAULT 'queued',
  stage_detail    TEXT NOT NULL DEFAULT '',
  -- [{stage, status: pending|running|done|warn|failed|skipped, detail, started_at, finished_at}]
  stages_json     TEXT NOT NULL DEFAULT '[]',
  -- Scenes that need a decision: [{scene_id, shot_id, kind, message}]
  attention_json  TEXT NOT NULL DEFAULT '[]',
  plan_json       TEXT NOT NULL DEFAULT '{}',
  episode_export_id TEXT REFERENCES exports(id) ON DELETE SET NULL,
  thumbnail_key   TEXT,
  thumbnails_json TEXT NOT NULL DEFAULT '[]',
  captions_srt_key TEXT,
  captions_vtt_key TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  qc_json         TEXT NOT NULL DEFAULT '[]',
  cost_inr        REAL NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX idx_videos_created ON videos(created_at);
CREATE INDEX idx_videos_story ON videos(story_id);

-- Shorts cut (and re-drawn in 9:16) from a video's episode.
CREATE TABLE video_shorts (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  hook            TEXT NOT NULL DEFAULT '',
  scene_ids_json  TEXT NOT NULL DEFAULT '[]',
  duration_sec    REAL,
  status          TEXT NOT NULL CHECK (status IN ('planned', 'generating', 'ready', 'failed')),
  -- 'native' = every shot re-drawn in 9:16; 'reframed' = some shots reframed from 16:9 (recorded).
  framing         TEXT NOT NULL DEFAULT 'native',
  video_key       TEXT,
  captions_srt_key TEXT,
  captions_vtt_key TEXT,
  thumbnail_key   TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  qc_json         TEXT NOT NULL DEFAULT '[]',
  error_message   TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (video_id, idx)
);

-- Publishing to YouTube: nothing is uploaded without a row that a person approved.
CREATE TABLE publications (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  short_id        TEXT REFERENCES video_shorts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('episode', 'short')),
  status          TEXT NOT NULL CHECK (status IN (
                    'ready_for_review', 'approved', 'uploading', 'uploaded', 'scheduled', 'published',
                    'blocked', 'failed')),
  privacy         TEXT NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'unlisted', 'public')),
  publish_at      TEXT,
  made_for_kids   INTEGER,
  synthetic_media INTEGER NOT NULL DEFAULT 1,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  approved_at     TEXT,
  youtube_video_id TEXT,
  youtube_url     TEXT,
  -- Upload session (resumable upload URL is a secret-like capability: kept here only while uploading).
  upload_url      TEXT,
  uploaded_bytes  INTEGER NOT NULL DEFAULT 0,
  captions_status TEXT,
  thumbnail_status TEXT,
  remote_status   TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_publications_video ON publications(video_id);
