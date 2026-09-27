-- v1.3: animated series (Series → Seasons → Episodes), the Series Bible, character canon with English
-- and Hinglish voices, continuity memory with approval, localized versions that share the master
-- visuals, and YouTube channel profiles per language. Additive only: existing projects, videos and
-- publications keep working unchanged. Rollback: restore the automatic backup in data/backups.

-- A series owns one project: its characters, locations and props ARE the canon (references, locks).
CREATE TABLE series (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  working_title     TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  genre             TEXT NOT NULL DEFAULT '',
  target_age        TEXT NOT NULL DEFAULT '6-12',
  target_audience   TEXT NOT NULL DEFAULT '',
  style_id          TEXT NOT NULL DEFAULT '3d_kids',
  story_tone        TEXT NOT NULL DEFAULT '',
  episode_minutes   REAL NOT NULL DEFAULT 6,
  master_language   TEXT NOT NULL DEFAULT 'en',
  -- Extra language versions made from the same master visuals, e.g. ["hi-Latn"].
  localizations_json TEXT NOT NULL DEFAULT '["hi-Latn"]',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  -- The Series Bible: {section: text} for PREMISE, WORLD, CHARACTERS, STORY RULES, ... (see SERIES_SYSTEM.md).
  bible_json        TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE seasons (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  episode_target  INTEGER NOT NULL DEFAULT 12,
  premise         TEXT NOT NULL DEFAULT '',
  main_mystery    TEXT NOT NULL DEFAULT '',
  arcs            TEXT NOT NULL DEFAULT '',
  beginning_state TEXT NOT NULL DEFAULT '',
  midseason       TEXT NOT NULL DEFAULT '',
  finale_state    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_production', 'complete')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (series_id, number)
);

CREATE TABLE episodes (
  id                TEXT PRIMARY KEY,
  series_id         TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_id         TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL,
  working_title     TEXT NOT NULL DEFAULT '',
  title_en          TEXT NOT NULL DEFAULT '',
  title_hi          TEXT NOT NULL DEFAULT '',
  idea              TEXT NOT NULL DEFAULT '',
  premise           TEXT NOT NULL DEFAULT '',
  synopsis          TEXT NOT NULL DEFAULT '',
  lesson            TEXT NOT NULL DEFAULT '',
  -- Story features for duplicate detection: {problem, setting, villain, science, resolution, lesson, setpiece}.
  features_json     TEXT NOT NULL DEFAULT '{}',
  -- Similar earlier episodes found before production: [{episode, score, fields}].
  similarity_json   TEXT NOT NULL DEFAULT '[]',
  -- Continuity check results: [{severity, message, fixed}].
  continuity_json   TEXT NOT NULL DEFAULT '[]',
  continuity_summary TEXT NOT NULL DEFAULT '',
  story_status      TEXT NOT NULL DEFAULT 'planned' CHECK (story_status IN ('planned', 'writing', 'written', 'failed')),
  production_status TEXT NOT NULL DEFAULT 'planned' CHECK (production_status IN (
                      'planned', 'generating', 'qc', 'ready_for_review', 'approved', 'rejected',
                      'needs_attention', 'failed', 'cancelled')),
  video_id          TEXT REFERENCES videos(id) ON DELETE SET NULL,
  approved_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (season_id, number)
);
CREATE INDEX idx_episodes_series ON episodes(series_id, number);

-- Canonical profile of a recurring character (the character row keeps look, references and locks).
CREATE TABLE series_characters (
  character_id      TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  series_id         TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  -- {age, role, personality, strengths, weaknesses, relationships, speech_style, catchphrases,
  --  face, skin, hair, eyes, height, proportions, clothing, shoes, accessories, colors, technology}
  profile_json      TEXT NOT NULL DEFAULT '{}',
  -- Hinglish style: {english_share (0..1), formality, humor, technical, notes}
  hinglish_json     TEXT NOT NULL DEFAULT '{}',
  -- Separate persistent voices per language version: {voice_profile_id, speed}
  voice_en_json     TEXT NOT NULL DEFAULT '{}',
  voice_hi_json     TEXT NOT NULL DEFAULT '{}',
  -- Pronunciation for speech: {"Aira": "आइरा", ...}
  pronunciation_json TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Continuity memory. Facts from a produced episode stay 'proposed' until the person approves that
-- episode; only 'canon' facts are given to the writer (rejected experiments never become canon).
CREATE TABLE continuity_facts (
  id          TEXT PRIMARY KEY,
  series_id   TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_id   TEXT REFERENCES seasons(id) ON DELETE CASCADE,
  episode_id  TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'canon', 'event', 'relationship', 'discovery', 'new_character', 'new_location',
                'object_state', 'character_state', 'mystery_open', 'mystery_resolved')),
  subject     TEXT NOT NULL DEFAULT '',
  fact        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'canon', 'rejected', 'retired')),
  created_at  TEXT NOT NULL,
  approved_at TEXT
);
CREATE INDEX idx_facts_series ON continuity_facts(series_id, status);

-- Extended canon for locations and props (the rows keep description, prompt, references and locks).
ALTER TABLE locations ADD COLUMN canon_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE props ADD COLUMN canon_json TEXT NOT NULL DEFAULT '{}';

-- Language versions: a localized story is a copy whose shots use the SAME approved pictures and clips.
-- speech_text: what the voice says when it differs from the caption text (Hinglish: Hindi words in
-- Devanagari for the Hindi phonemizer, English words in Latin letters); captions keep `text`.
ALTER TABLE stories ADD COLUMN source_story_id TEXT REFERENCES stories(id) ON DELETE SET NULL;
-- {character_id: voice_profile_id, "narrator": voice_profile_id}: this version's voices.
ALTER TABLE stories ADD COLUMN voice_overrides_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dialogue_lines ADD COLUMN speech_text TEXT;
ALTER TABLE narration_lines ADD COLUMN speech_text TEXT;

-- A video made for an episode, and the language versions it must produce besides the master.
ALTER TABLE videos ADD COLUMN episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL;
ALTER TABLE videos ADD COLUMN localizations_json TEXT NOT NULL DEFAULT '[]';

-- One language version of a video (short_id NULL) or of one of its Shorts. It is a copy of the story
-- whose shots point at the SAME approved pictures and clips (shared master visuals); only the words,
-- voices, captions, thumbnail text and metadata differ.
CREATE TABLE localizations (
  id               TEXT PRIMARY KEY,
  video_id         TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  short_id         TEXT REFERENCES video_shorts(id) ON DELETE CASCADE,
  language         TEXT NOT NULL,
  story_id         TEXT REFERENCES stories(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('planned', 'localizing', 'voicing', 'ready', 'needs_attention', 'failed')),
  export_id        TEXT REFERENCES exports(id) ON DELETE SET NULL,
  video_key        TEXT,
  captions_srt_key TEXT,
  captions_vtt_key TEXT,
  thumbnail_key    TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}',
  -- Localization QA and timing: [{line_id, severity, message}], {lines, rewritten, paced, flagged}.
  qa_json          TEXT NOT NULL DEFAULT '[]',
  timing_json      TEXT NOT NULL DEFAULT '{}',
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (video_id, short_id, language)
);
CREATE INDEX idx_localizations_video ON localizations(video_id);

-- YouTube channels: one profile per audience/language, each with its own Google sign-in.
CREATE TABLE channel_profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  language        TEXT NOT NULL,
  youtube_channel_id    TEXT,
  youtube_channel_title TEXT,
  default_privacy TEXT NOT NULL DEFAULT 'private' CHECK (default_privacy IN ('private', 'unlisted', 'public')),
  schedule        TEXT NOT NULL DEFAULT 'none' CHECK (schedule IN ('none', 'daily', 'weekly')),
  publish_time    TEXT NOT NULL DEFAULT '17:00',
  weekday         INTEGER NOT NULL DEFAULT 6,
  -- The audience's time zone in minutes from UTC (India: 330); NULL = this computer's time zone.
  utc_offset_minutes INTEGER,
  audience        TEXT NOT NULL DEFAULT 'ask' CHECK (audience IN ('ask', 'kids', 'not_kids')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (language)
);

ALTER TABLE publications ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE publications ADD COLUMN channel_profile_id TEXT REFERENCES channel_profiles(id) ON DELETE SET NULL;
ALTER TABLE publications ADD COLUMN localization_id TEXT REFERENCES localizations(id) ON DELETE CASCADE;
