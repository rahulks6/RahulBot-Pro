-- Phase F, Migration 1: granular admin permissions + an immutable audit trail.
-- Additive only. The existing role/is_primary_admin columns (migration 0020)
-- are untouched and keep gating the existing moderator/admin mobile-facing
-- endpoints exactly as they do today. This migration adds the finer-grained
-- layer the new, separate Admin Console needs on top: a specific admin can
-- hold a specific subset of named permissions, the primary admin
-- (is_primary_admin — the SUPER_ADMIN of the new spec) implicitly holds all
-- of them and is never rows in this table, and every privileged action taken
-- through the new console is written to an append-only audit_logs row that
-- no admin endpoint in this codebase ever updates or deletes.

CREATE TABLE admin_permissions (
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,
    granted_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, permission),
    CONSTRAINT admin_permissions_valid CHECK (permission IN (
        'reports.read', 'reports.review',
        'content.remove', 'content.restore',
        'users.view', 'users.restrict', 'users.suspend',
        'moderation.history.read',
        'ads.create', 'ads.edit', 'ads.review', 'ads.pause', 'ads.analytics.read',
        'admins.read', 'admins.create', 'admins.update', 'admins.disable',
        'audit.read'
    ))
);

CREATE INDEX admin_permissions_user_idx ON admin_permissions (user_id);

-- The action-centric trail the Admin Console's "moderation history" screen
-- reads: one row per actual action taken (remove/restore/restrict/suspend),
-- separate from the reports table's own reviewed_by/reviewed_at (0011),
-- since a single report resolution and a direct, report-less action both
-- need to land here the same way.
CREATE TABLE moderation_actions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    action_type  TEXT NOT NULL,
    target_type  TEXT NOT NULL,
    target_id    UUID NOT NULL,
    report_id    UUID NULL REFERENCES reports (id) ON DELETE SET NULL,
    reason       TEXT NULL,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT moderation_actions_type_valid CHECK (action_type IN (
        'remove_content', 'restore_content', 'restrict_user', 'unrestrict_user',
        'suspend_user', 'unsuspend_user', 'dismiss_report'
    )),
    CONSTRAINT moderation_actions_target_type_valid CHECK (target_type IN ('story', 'comment', 'user'))
);

CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_type, target_id, created_at);
CREATE INDEX moderation_actions_actor_idx ON moderation_actions (actor_id, created_at);

-- Append-only by convention: no repository function in this codebase ever
-- issues UPDATE/DELETE against this table, and no route exposes one either.
-- A real second, write-once DB role is future infrastructure work this V1
-- doesn't block on (see backend/README.md's Admin Console section).
CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT NULL,
    target_id   UUID NULL,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at);
