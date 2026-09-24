-- Phase F, Migration 3: a lighter-weight RESTRICTED account state, additive
-- to (not a replacement for) the existing is_active suspension mechanism.
-- is_active keeps meaning exactly what it means today — false blocks login
-- and token refresh (auth.service.ts), unchanged. account_status is the new,
-- narrower state the new spec's moderation actions read/write; 'restricted'
-- blocks only specific write actions (publish a Story, post a comment,
-- start a new DM) at those exact action points, and is deliberately never
-- checked by login or token refresh — an already-signed-in restricted user
-- keeps browsing normally, which is exactly the distinction between
-- "restricted" and "suspended" the spec draws.
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD CONSTRAINT users_account_status_valid
    CHECK (account_status IN ('active', 'restricted', 'suspended', 'disabled'));
