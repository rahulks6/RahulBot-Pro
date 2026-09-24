-- Evolves the single is_moderator boolean into a real staff hierarchy:
-- 'user' (default) < 'moderator' (resolve reports, remove content, suspend
-- accounts) < 'admin' (everything a moderator can do, plus grant/revoke
-- moderator and admin access to other accounts). is_primary_admin marks
-- the one account that granted itself nothing — it was seeded out of band
-- (see scripts/seedPrimaryAdmin.ts) — and can never be demoted, suspended,
-- or have its primary status moved to anyone else by the app itself.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'moderator', 'admin'));
ALTER TABLE users ADD COLUMN is_primary_admin BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET role = 'moderator' WHERE is_moderator = true;

ALTER TABLE users DROP COLUMN is_moderator;

-- A real, DB-level guarantee that at most one row is ever the primary
-- admin — defense in depth alongside the application-layer checks in
-- moderation.service.ts, not a substitute for them.
CREATE UNIQUE INDEX users_single_primary_admin_idx ON users (is_primary_admin) WHERE is_primary_admin = true;
