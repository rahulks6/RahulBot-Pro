-- AI Story Studio — initial schema (Phase 1).
--
-- Conventions
--   * ids are text (prefixed random ids, e.g. "prj_…").
--   * timestamps are ISO-8601 UTC text.
--   * booleans are INTEGER 0/1.
--   * *_json columns hold flexible, model-specific configuration only; core
--     relationships are modelled with real tables and foreign keys.
--   * money is stored in INR (REAL) and every cost row records whether it was
--     simulated (is_mock = 1) so mock numbers never mix with real spending.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE style_presets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = global preset
  name            TEXT NOT NULL,
  style_prompt    TEXT NOT NULL DEFAULT '',
  rendering       TEXT NOT NULL DEFAULT '',
  lighting        TEXT NOT NULL DEFAULT '',
  colors          TEXT NOT NULL DEFAULT '',
  camera          TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  series            TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  genre             TEXT NOT NULL DEFAULT '',
  target_audience   TEXT NOT NULL DEFAULT '',
  default_style_id  TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
  width             INTEGER NOT NULL DEFAULT 1920,
  height            INTEGER NOT NULL DEFAULT 1080,
  aspect_ratio      TEXT NOT NULL DEFAULT '16:9' CHECK (aspect_ratio IN ('16:9', '9:16')),
  fps               INTEGER NOT NULL DEFAULT 24 CHECK (fps IN (24, 30)),
  default_quality   TEXT NOT NULL DEFAULT 'optimized' CHECK (default_quality IN ('fast_preview', 'optimized', 'high_quality')),
  narrator_voice_id TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL,
  production_notes  TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE voice_profiles (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'character' CHECK (role IN ('character', 'narrator')),
  voice_model      TEXT NOT NULL DEFAULT 'mock-tts',
  voice_identity   TEXT NOT NULL DEFAULT '',     -- model voice id / speaker embedding id
  reference_asset_id TEXT REFERENCES reference_assets(id) ON DELETE SET NULL,
  language         TEXT NOT NULL DEFAULT 'en',
  presentation     TEXT NOT NULL DEFAULT 'neutral' CHECK (presentation IN ('male', 'female', 'neutral')),
  pitch            REAL NOT NULL DEFAULT 0,      -- semitones relative to model default
  speed            REAL NOT NULL DEFAULT 1,
  speaking_style   TEXT NOT NULL DEFAULT '',
  narration_style  TEXT NOT NULL DEFAULT '',
  default_emotion  TEXT NOT NULL DEFAULT 'neutral',
  settings_json    TEXT NOT NULL DEFAULT '{}',
  locked           INTEGER NOT NULL DEFAULT 0,
  locked_at        TEXT,
  lock_snapshot_json TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE reference_assets (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_type   TEXT NOT NULL CHECK (owner_type IN ('character', 'location', 'prop', 'style', 'voice', 'project')),
  owner_id     TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  storage_key  TEXT NOT NULL,
  mime         TEXT NOT NULL,
  approved     INTEGER NOT NULL DEFAULT 0,
  is_mock      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_reference_assets_owner ON reference_assets(owner_type, owner_id);

CREATE TABLE characters (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  species             TEXT NOT NULL DEFAULT '',
  age                 TEXT NOT NULL DEFAULT '',
  role                TEXT NOT NULL DEFAULT '',
  personality         TEXT NOT NULL DEFAULT '',
  appearance          TEXT NOT NULL DEFAULT '',
  face                TEXT NOT NULL DEFAULT '',
  hair                TEXT NOT NULL DEFAULT '',
  eyes                TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  proportions         TEXT NOT NULL DEFAULT '',
  clothing            TEXT NOT NULL DEFAULT '',
  accessories         TEXT NOT NULL DEFAULT '',
  colors              TEXT NOT NULL DEFAULT '',
  prompt              TEXT NOT NULL DEFAULT '',
  negative_prompt     TEXT NOT NULL DEFAULT '',
  voice_profile_id    TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL,
  preferred_seeds_json TEXT NOT NULL DEFAULT '[]',
  generation_settings_json TEXT NOT NULL DEFAULT '{}',
  locked              INTEGER NOT NULL DEFAULT 0,
  locked_at           TEXT,
  lock_snapshot_json  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE character_variants (
  id                TEXT PRIMARY KEY,
  character_id      TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  clothing_override TEXT NOT NULL DEFAULT '',
  prompt_additions  TEXT NOT NULL DEFAULT '',
  negative_additions TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (character_id, name)
);

CREATE TABLE character_references (
  id                 TEXT PRIMARY KEY,
  character_id       TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  variant_id         TEXT REFERENCES character_variants(id) ON DELETE CASCADE,
  slot_type          TEXT NOT NULL CHECK (slot_type IN ('view', 'expression', 'pose', 'other')),
  slot               TEXT NOT NULL,
  reference_asset_id TEXT NOT NULL REFERENCES reference_assets(id) ON DELETE CASCADE,
  approved           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_character_references_character ON character_references(character_id);

CREATE TABLE locations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  environment       TEXT NOT NULL DEFAULT '',
  architecture      TEXT NOT NULL DEFAULT '',
  important_objects TEXT NOT NULL DEFAULT '',
  colors            TEXT NOT NULL DEFAULT '',
  lighting          TEXT NOT NULL DEFAULT '',
  weather           TEXT NOT NULL DEFAULT '',
  time_of_day       TEXT NOT NULL DEFAULT '',
  prompt            TEXT NOT NULL DEFAULT '',
  negative_prompt   TEXT NOT NULL DEFAULT '',
  locked            INTEGER NOT NULL DEFAULT 0,
  locked_at         TEXT,
  lock_snapshot_json TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE props (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  scale             TEXT NOT NULL DEFAULT '',
  colors            TEXT NOT NULL DEFAULT '',
  prompt            TEXT NOT NULL DEFAULT '',
  negative_prompt   TEXT NOT NULL DEFAULT '',
  locked            INTEGER NOT NULL DEFAULT 0,
  locked_at         TEXT,
  lock_snapshot_json TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE prop_characters (
  prop_id      TEXT NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (prop_id, character_id)
);

CREATE TABLE stories (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  episode_number      INTEGER,
  synopsis            TEXT NOT NULL DEFAULT '',
  story_text          TEXT NOT NULL DEFAULT '',
  moral               TEXT NOT NULL DEFAULT '',
  language            TEXT NOT NULL DEFAULT 'en',
  target_duration_sec INTEGER NOT NULL DEFAULT 60,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_production', 'review', 'complete')),
  production_notes    TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_stories_project ON stories(project_id);

CREATE TABLE scenes (
  id           TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,
  time_of_day  TEXT NOT NULL DEFAULT '',
  music_mood   TEXT NOT NULL DEFAULT '',
  music_genre  TEXT NOT NULL DEFAULT '',
  music_energy TEXT NOT NULL DEFAULT '' CHECK (music_energy IN ('', 'low', 'medium', 'high')),
  ambience     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_scenes_story ON scenes(story_id, position);

CREATE TABLE shots (
  id                      TEXT PRIMARY KEY,
  scene_id                TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position                INTEGER NOT NULL,
  title                   TEXT NOT NULL DEFAULT '',
  action                  TEXT NOT NULL DEFAULT '',
  emotion                 TEXT NOT NULL DEFAULT '',
  framing                 TEXT NOT NULL DEFAULT '',
  camera_angle            TEXT NOT NULL DEFAULT '',
  camera_movement         TEXT NOT NULL DEFAULT '',
  lighting                TEXT NOT NULL DEFAULT '',
  location_id             TEXT REFERENCES locations(id) ON DELETE SET NULL,
  style_id                TEXT REFERENCES style_presets(id) ON DELETE SET NULL,
  image_prompt            TEXT NOT NULL DEFAULT '',   -- manual prompt (used only when *_locked = 1)
  image_prompt_locked     INTEGER NOT NULL DEFAULT 0,
  motion_prompt           TEXT NOT NULL DEFAULT '',
  motion_prompt_locked    INTEGER NOT NULL DEFAULT 0,
  negative_prompt         TEXT NOT NULL DEFAULT '',
  negative_prompt_locked  INTEGER NOT NULL DEFAULT 0,
  duration_sec            REAL NOT NULL DEFAULT 5,
  fps                     INTEGER NOT NULL DEFAULT 24 CHECK (fps IN (24, 30)),
  seed                    INTEGER,
  generation_mode         TEXT NOT NULL DEFAULT 'optimized' CHECK (generation_mode IN ('fast_preview', 'optimized', 'high_quality')),
  mouth_visible           INTEGER NOT NULL DEFAULT 0,
  lipsync_enabled         INTEGER NOT NULL DEFAULT 1,
  music_notes             TEXT NOT NULL DEFAULT '',
  ambience_notes          TEXT NOT NULL DEFAULT '',
  approval_state          TEXT NOT NULL DEFAULT 'draft' CHECK (approval_state IN ('draft', 'image_review', 'image_approved', 'video_review', 'approved', 'rejected')),
  approved_image_asset_id TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  approved_video_asset_id TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  lipsync_video_asset_id  TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_shots_scene ON shots(scene_id, position);

CREATE TABLE shot_characters (
  shot_id      TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  variant_id   TEXT REFERENCES character_variants(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shot_id, character_id)
);

CREATE TABLE shot_props (
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  prop_id TEXT NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  PRIMARY KEY (shot_id, prop_id)
);

CREATE TABLE shot_sfx (
  id         TEXT PRIMARY KEY,
  shot_id    TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  offset_sec REAL NOT NULL DEFAULT 0,
  required   INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggested', 'package')),
  approved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Text lines are separate from video so the same animation can be dubbed.
CREATE TABLE dialogue_lines (
  id             TEXT PRIMARY KEY,
  shot_id        TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  character_id   TEXT REFERENCES characters(id) ON DELETE SET NULL,
  text           TEXT NOT NULL,
  emotion        TEXT NOT NULL DEFAULT 'neutral',
  delivery       TEXT NOT NULL DEFAULT '',
  speed          REAL NOT NULL DEFAULT 1,
  language       TEXT NOT NULL DEFAULT 'en',
  required       INTEGER NOT NULL DEFAULT 1,
  audio_asset_id TEXT REFERENCES audio_assets(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_dialogue_shot ON dialogue_lines(shot_id, position);

CREATE TABLE narration_lines (
  id             TEXT PRIMARY KEY,
  scene_id       TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  shot_id        TEXT REFERENCES shots(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL,
  text           TEXT NOT NULL,
  emotion        TEXT NOT NULL DEFAULT 'neutral',
  speed          REAL NOT NULL DEFAULT 1,
  language       TEXT NOT NULL DEFAULT 'en',
  required       INTEGER NOT NULL DEFAULT 1,
  audio_asset_id TEXT REFERENCES audio_assets(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_narration_scene ON narration_lines(scene_id, position);

-- Every generated file (images, clips, audio, upscales, lip-sync versions,
-- masters). Rows are never overwritten; derived assets point at their source.
CREATE TABLE generated_assets (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'upscaled_image', 'upscaled_video', 'lipsync_video', 'mix', 'master')),
  storage_key          TEXT NOT NULL,
  mime                 TEXT NOT NULL,
  width                INTEGER,
  height               INTEGER,
  duration_sec         REAL,
  fps                  INTEGER,
  source_asset_id      TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  is_native_resolution INTEGER NOT NULL DEFAULT 1,
  is_mock              INTEGER NOT NULL DEFAULT 0,
  checksum             TEXT NOT NULL,
  size_bytes           INTEGER NOT NULL DEFAULT 0,
  approval             TEXT NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending', 'approved', 'rejected')),
  reusable             INTEGER NOT NULL DEFAULT 0,
  continuity_tag       TEXT NOT NULL DEFAULT '', -- intro / outro / theme / catchphrase: intentional series reuse
  tags                 TEXT NOT NULL DEFAULT '',
  label                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_generated_assets_project ON generated_assets(project_id, kind);
CREATE INDEX idx_generated_assets_checksum ON generated_assets(checksum);

CREATE TABLE audio_assets (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  generated_asset_id TEXT NOT NULL REFERENCES generated_assets(id) ON DELETE CASCADE,
  layer              TEXT NOT NULL CHECK (layer IN ('dialogue', 'narration', 'music', 'sfx', 'ambience')),
  cache_key          TEXT NOT NULL,          -- hash of provider+model+inputs; identical requests reuse the asset
  voice_profile_id   TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL,
  character_id       TEXT REFERENCES characters(id) ON DELETE SET NULL,
  language           TEXT NOT NULL DEFAULT '',
  text               TEXT NOT NULL DEFAULT '',
  emotion            TEXT NOT NULL DEFAULT '',
  speed              REAL NOT NULL DEFAULT 1,
  mood               TEXT NOT NULL DEFAULT '',
  genre              TEXT NOT NULL DEFAULT '',
  energy             TEXT NOT NULL DEFAULT '',
  sfx_tag            TEXT NOT NULL DEFAULT '',
  loopable           INTEGER NOT NULL DEFAULT 0,
  duration_sec       REAL NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_audio_assets_cache ON audio_assets(project_id, cache_key);

CREATE TABLE asset_usages (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES generated_assets(id) ON DELETE CASCADE,
  story_id   TEXT REFERENCES stories(id) ON DELETE CASCADE,
  shot_id    TEXT REFERENCES shots(id) ON DELETE CASCADE,
  context    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_asset_usages_asset ON asset_usages(asset_id);

CREATE TABLE gpu_instances (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  tag                  TEXT NOT NULL,          -- every studio-created resource is tagged; only tagged resources are ever terminated
  gpu_model            TEXT NOT NULL,
  vram_gb              INTEGER NOT NULL,
  hourly_rate_inr      REAL NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('provisioning', 'running', 'terminating', 'terminated', 'failed')),
  idle_timeout_sec     INTEGER NOT NULL,
  max_lifetime_sec     INTEGER NOT NULL,
  is_mock              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  ready_at             TEXT,
  last_activity_at     TEXT NOT NULL,
  terminated_at        TEXT,
  termination_reason   TEXT
);

CREATE TABLE gpu_events (
  id              TEXT PRIMARY KEY,
  gpu_instance_id TEXT,
  provider        TEXT NOT NULL,
  event           TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '',
  is_mock         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE generation_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id       TEXT REFERENCES stories(id) ON DELETE CASCADE,
  shot_id        TEXT REFERENCES shots(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('image', 'video', 'upscale', 'tts', 'music', 'sfx', 'ambience', 'lipsync', 'reference')),
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'optimized',
  batch_id       TEXT,
  params_json    TEXT NOT NULL DEFAULT '{}',
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 2,
  log_json       TEXT NOT NULL DEFAULT '[]',
  error_code     TEXT,
  error_message  TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX idx_jobs_status ON generation_jobs(status);

-- Immutable generation history. A regenerate always creates a new row.
CREATE TABLE generation_attempts (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id            TEXT REFERENCES shots(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  attempt_number     INTEGER NOT NULL,
  prompt             TEXT NOT NULL DEFAULT '',
  negative_prompt    TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL,
  model_version      TEXT NOT NULL,
  seed               INTEGER,
  references_json    TEXT NOT NULL DEFAULT '[]',
  width              INTEGER,
  height             INTEGER,
  fps                INTEGER,
  duration_sec       REAL,
  settings_json      TEXT NOT NULL DEFAULT '{}',
  provider           TEXT NOT NULL,
  gpu_model          TEXT,
  gpu_instance_id    TEXT REFERENCES gpu_instances(id) ON DELETE SET NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  generation_seconds REAL NOT NULL DEFAULT 0,
  gpu_seconds        REAL NOT NULL DEFAULT 0,
  estimated_cost_inr REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  error_code         TEXT,
  error_message      TEXT,
  output_asset_id    TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  approval           TEXT NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending', 'approved', 'rejected')),
  is_mock            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_attempts_shot ON generation_attempts(shot_id, kind);

CREATE TABLE usage_records (
  id              TEXT PRIMARY KEY,
  gpu_instance_id TEXT REFERENCES gpu_instances(id) ON DELETE SET NULL,
  job_id          TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  attempt_id      TEXT REFERENCES generation_attempts(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  story_id        TEXT REFERENCES stories(id) ON DELETE SET NULL,
  shot_id         TEXT REFERENCES shots(id) ON DELETE SET NULL,
  category        TEXT NOT NULL CHECK (category IN ('startup', 'model_load', 'generation', 'upscale', 'audio', 'lipsync', 'idle', 'other')),
  seconds         REAL NOT NULL,
  hourly_rate_inr REAL NOT NULL,
  cost_inr        REAL NOT NULL,
  provider        TEXT NOT NULL,
  gpu_model       TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  is_mock         INTEGER NOT NULL DEFAULT 0,
  recorded_at     TEXT NOT NULL
);
CREATE INDEX idx_usage_recorded ON usage_records(recorded_at);

CREATE TABLE timelines (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL UNIQUE REFERENCES stories(id) ON DELETE CASCADE,
  fps        INTEGER NOT NULL DEFAULT 24,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE timeline_items (
  id            TEXT PRIMARY KEY,
  timeline_id   TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  track         TEXT NOT NULL CHECK (track IN ('video', 'dialogue', 'narration', 'sfx', 'ambience', 'music', 'title')),
  position      INTEGER NOT NULL DEFAULT 0,
  asset_id      TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  source_type   TEXT NOT NULL DEFAULT '', -- shot / dialogue / narration / scene / shot_sfx / title
  source_id     TEXT NOT NULL DEFAULT '',
  label         TEXT NOT NULL DEFAULT '',
  start_sec     REAL NOT NULL,
  duration_sec  REAL NOT NULL,
  trim_in_sec   REAL NOT NULL DEFAULT 0,
  volume_db     REAL NOT NULL DEFAULT 0,
  fade_in_sec   REAL NOT NULL DEFAULT 0,
  fade_out_sec  REAL NOT NULL DEFAULT 0,
  transition    TEXT NOT NULL DEFAULT 'cut' CHECK (transition IN ('cut', 'crossfade', 'fade_black')),
  loop          INTEGER NOT NULL DEFAULT 0,
  manual        INTEGER NOT NULL DEFAULT 0, -- manually adjusted items survive automatic rebuilds
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_timeline_items ON timeline_items(timeline_id, track, start_sec);

CREATE TABLE exports (
  id                TEXT PRIMARY KEY,
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  format            TEXT NOT NULL CHECK (format IN ('landscape', 'vertical')),
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  fps               INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'building', 'validating', 'complete', 'failed')),
  master_asset_id   TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  mix_asset_id      TEXT REFERENCES generated_assets(id) ON DELETE SET NULL,
  duration_sec      REAL,
  is_mock           INTEGER NOT NULL DEFAULT 0,
  steps_json        TEXT NOT NULL DEFAULT '[]',
  validation_json   TEXT NOT NULL DEFAULT '[]',
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE TABLE quality_reports (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  export_id  TEXT REFERENCES exports(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('story', 'audio', 'visual', 'technical', 'youtube')),
  status     TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail')),
  findings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_quality_reports_story ON quality_reports(story_id, kind);

CREATE TABLE similarity_reports (
  id                TEXT PRIMARY KEY,
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  compared_story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  story_similarity     REAL NOT NULL,
  dialogue_similarity  REAL NOT NULL,
  narration_similarity REAL NOT NULL,
  shot_plan_similarity REAL NOT NULL,
  prompt_similarity    REAL NOT NULL,
  asset_reuse          REAL NOT NULL,
  repeated_clips       INTEGER NOT NULL,
  repeated_audio       INTEGER NOT NULL,
  title_duplicate      INTEGER NOT NULL,
  findings_json        TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_similarity_story ON similarity_reports(story_id);

CREATE TABLE review_checklist_items (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  item_key   TEXT NOT NULL,
  checked    INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  checked_at TEXT,
  UNIQUE (story_id, item_key)
);

CREATE TABLE story_package_imports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  story_id      TEXT REFERENCES stories(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('imported', 'failed')),
  package_hash  TEXT NOT NULL,
  errors_json   TEXT NOT NULL DEFAULT '[]',
  summary_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
