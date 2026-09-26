-- v1.2: live job progress as the worker reports it (model loading, diffusion steps, encoding).
-- Additive only; existing rows get defaults. Rollback: restore the automatic backup in data/backups.

ALTER TABLE generation_jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN status_detail TEXT NOT NULL DEFAULT '';
