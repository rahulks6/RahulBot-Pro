-- LOCAL GPU (v1.2): Model Manager downloads. Additive only: existing v1.1.x data is untouched.
-- Rollback: restore the automatic backup in data/backups (taken before this migration ran).

CREATE TABLE model_downloads (
  id              TEXT PRIMARY KEY,
  model_id        TEXT NOT NULL,
  repo            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
  bytes_expected  INTEGER NOT NULL DEFAULT 0,
  bytes_done      INTEGER NOT NULL DEFAULT 0,
  error_kind      TEXT,
  error_message   TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX idx_model_downloads_model ON model_downloads(model_id, started_at);
