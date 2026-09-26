-- Phase 3: model benchmarks, human ratings and model selection decisions.
-- Benchmarks are not tied to a project; their output files live under
-- storage key benchmarks/<run id>/<file>.

CREATE TABLE benchmark_runs (
  id              TEXT PRIMARY KEY,
  worker_job_id   TEXT NOT NULL,
  worker_url      TEXT NOT NULL,
  suite           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
  include_mock    INTEGER NOT NULL DEFAULT 0,
  hourly_rate_inr REAL NOT NULL DEFAULT 0,   -- used only to estimate cost per output
  models_json     TEXT NOT NULL DEFAULT '[]', -- id, kind, licence, commercial_use, mock, … as reported by the worker
  gpu_json        TEXT NOT NULL DEFAULT '{}',
  summary_json    TEXT NOT NULL DEFAULT '{}',
  error_message   TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);

CREATE TABLE benchmark_results (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  case_key       TEXT NOT NULL,
  seed           INTEGER,
  status         TEXT NOT NULL,
  error_code     TEXT,
  error_message  TEXT,
  load_seconds   REAL,
  run_seconds    REAL,
  peak_vram_mb   REAL,
  storage_key    TEXT,
  mime           TEXT,
  sha256         TEXT,
  checks_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_benchmark_results_run ON benchmark_results(run_id, kind, case_key);

-- Human judgement: automated checks cannot measure quality or character consistency.
CREATE TABLE benchmark_ratings (
  result_id   TEXT PRIMARY KEY REFERENCES benchmark_results(id) ON DELETE CASCADE,
  quality     INTEGER NOT NULL CHECK (quality BETWEEN 1 AND 5),
  consistency INTEGER CHECK (consistency BETWEEN 1 AND 5),
  notes       TEXT NOT NULL DEFAULT '',
  rated_at    TEXT NOT NULL
);

-- Decision log: one active model per kind; history is kept.
CREATE TABLE model_selections (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('image', 'video', 'tts', 'music', 'sfx', 'lipsync', 'upscale')),
  model_id             TEXT NOT NULL,
  benchmark_run_id     TEXT REFERENCES benchmark_runs(id) ON DELETE SET NULL,
  license              TEXT NOT NULL DEFAULT '',
  commercial_use       TEXT NOT NULL DEFAULT '',
  license_acknowledged INTEGER NOT NULL DEFAULT 0,
  rationale            TEXT NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1,
  decided_at           TEXT NOT NULL
);
CREATE INDEX idx_model_selections_kind ON model_selections(kind, active);
