-- Phase 4: Story publishing + the 24-hour lifecycle. A Story wraps one
-- already-uploaded media row (Phase 3) with audience/comment/sharing
-- settings and a server-computed expiry. Rows are never hard-deleted on
-- expiry — Archive/Highlights (Phase 9) will need the history — "active"
-- is just "expires_at > now() AND deleted_at IS NULL", checked at query
-- time everywhere a Story is surfaced.

CREATE TABLE stories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    media_id            UUID NOT NULL UNIQUE REFERENCES media (id) ON DELETE RESTRICT,
    caption             TEXT NOT NULL DEFAULT '',
    audience            TEXT NOT NULL DEFAULT 'public',
    allow_comments      TEXT NOT NULL DEFAULT 'everyone',
    allow_sharing       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    deleted_at          TIMESTAMPTZ NULL,
    CONSTRAINT stories_audience_valid CHECK (audience IN ('public', 'followers')),
    CONSTRAINT stories_allow_comments_valid CHECK (allow_comments IN ('everyone', 'followers', 'disabled'))
);

CREATE INDEX stories_owner_active_idx ON stories (owner_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX stories_expires_at_idx ON stories (expires_at) WHERE deleted_at IS NULL;

CREATE TABLE story_views (
    story_id            UUID NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    viewer_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    viewed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX story_views_story_id_idx ON story_views (story_id);
