-- Phase 10: Moderation — user-filed Reports and a moderator queue to
-- resolve them, plus the account-suspension action that finally wires up
-- `users.is_active`: that column has existed and been checked at login
-- since migration 0001, but nothing has ever been able to set it false
-- until now.

ALTER TABLE users ADD COLUMN is_moderator BOOLEAN NOT NULL DEFAULT false;

-- Deliberately no FK on target_id: a report can point into stories,
-- story_comments, or users, and this schema has no single table all three
-- share. The application layer (moderation.service.ts) validates the
-- target actually exists, for the right type, at report-creation time —
-- the same tradeoff recommendation_events already made for its own
-- optional story_id/creator_id columns, just without even those being
-- typed FKs here since the type varies per row.
CREATE TABLE reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    target_type     TEXT NOT NULL,
    target_id       UUID NOT NULL,
    reason          TEXT NOT NULL,
    details         TEXT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    resolution_note TEXT NULL,
    reviewed_by     UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reports_target_type_valid CHECK (target_type IN ('story', 'comment', 'user')),
    CONSTRAINT reports_reason_valid CHECK (reason IN (
        'spam', 'harassment', 'nudity', 'violence', 'hate_speech', 'self_harm', 'other'
    )),
    CONSTRAINT reports_status_valid CHECK (status IN ('pending', 'dismissed', 'actioned')),
    CONSTRAINT reports_details_length CHECK (details IS NULL OR char_length(details) <= 500),
    CONSTRAINT reports_resolution_note_length CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500)
);
CREATE INDEX reports_status_created_idx ON reports (status, created_at);
CREATE INDEX reports_target_idx ON reports (target_type, target_id);
