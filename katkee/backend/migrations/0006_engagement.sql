-- Phase 5: likes, comments, and share events on a Story.
--
-- story_likes mirrors story_views' idempotent-per-viewer shape (a like is a
-- state, not a log). story_comments is soft-deletable (comment authors and
-- the Story owner can both remove one, per spec section 14). story_shares
-- is an append-only event log, not a state — sharing repeatedly is a real,
-- meaningful action (spec section 12's story_share analytics event), unlike
-- a view or a like.

CREATE TABLE story_likes (
    story_id            UUID NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (story_id, user_id)
);

CREATE INDEX story_likes_story_id_idx ON story_likes (story_id);

CREATE TABLE story_comments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id            UUID NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body                TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ NULL,
    CONSTRAINT story_comments_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX story_comments_story_id_idx ON story_comments (story_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE story_shares (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id            UUID NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX story_shares_story_id_idx ON story_shares (story_id);
