-- Phase 5: real cloud GPU (RunPod) lifecycle, job recovery and the guided GPU test.
-- Additive only: existing projects, jobs and GPU history keep loading unchanged.

-- Fine-grained lifecycle shown in the UI (DISABLED … READY, GENERATING, IDLE, TERMINATING, STOPPED, FAILED).
ALTER TABLE gpu_instances ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'READY';
ALTER TABLE gpu_instances ADD COLUMN worker_url TEXT;
ALTER TABLE gpu_instances ADD COLUMN session_budget_inr REAL;
ALTER TABLE gpu_instances ADD COLUMN error_message TEXT;
ALTER TABLE gpu_instances ADD COLUMN purpose TEXT NOT NULL DEFAULT 'generation';
-- Existing history rows are all finished sessions.
UPDATE gpu_instances SET lifecycle_state = CASE status
  WHEN 'terminated' THEN 'STOPPED' WHEN 'failed' THEN 'FAILED' WHEN 'terminating' THEN 'TERMINATING' ELSE 'READY' END;

-- Remote (worker) job bookkeeping so a restart re-polls instead of paying for the same generation twice.
ALTER TABLE generation_jobs ADD COLUMN remote_job_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN gpu_instance_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN remote_submitted_at TEXT;

-- Installation identity (names every cloud resource this installation creates) and similar metadata.
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Guided first-GPU tests (Settings → Cloud GPU → Start Test GPU).
CREATE TABLE cloud_tests (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
  gpu_instance_id TEXT,
  gpu_model       TEXT,
  hourly_rate_inr REAL,
  test_kind       TEXT NOT NULL,
  steps_json      TEXT NOT NULL DEFAULT '[]',
  output_key      TEXT,
  runtime_sec     REAL,
  cost_inr        REAL,
  error_message   TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
