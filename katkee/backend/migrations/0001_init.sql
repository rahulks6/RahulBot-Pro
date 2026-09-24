-- KATKEE Phase 1 schema: identity, auth sessions, and the core social graph
-- tables the rest of the product (Phase 2+) will build on. Media, stories,
-- highlights, conversations, and notifications are deliberately deferred to
-- their own phases so this migration stays reviewable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username            CITEXT NOT NULL,
    email               CITEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    display_name        TEXT NOT NULL,
    bio                 TEXT NOT NULL DEFAULT '',
    avatar_media_id     UUID NULL,
    is_private          BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_.]{3,30}$'),
    CONSTRAINT users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE UNIQUE INDEX users_username_unique ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE refresh_tokens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash          TEXT NOT NULL,
    user_agent          TEXT NULL,
    ip_address          INET NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ NULL,
    replaced_by_id      UUID NULL REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_token_hash_unique ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

CREATE TABLE follows (
    follower_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    followee_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT follows_no_self_follow CHECK (follower_id <> followee_id)
);

CREATE INDEX follows_followee_id_idx ON follows (followee_id);

CREATE TABLE follow_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    target_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ NULL,
    CONSTRAINT follow_requests_no_self CHECK (requester_id <> target_id),
    CONSTRAINT follow_requests_status_valid CHECK (status IN ('pending', 'accepted', 'declined'))
);

CREATE UNIQUE INDEX follow_requests_pending_unique
    ON follow_requests (requester_id, target_id) WHERE status = 'pending';
CREATE INDEX follow_requests_target_id_idx ON follow_requests (target_id) WHERE status = 'pending';

CREATE TABLE blocks (
    blocker_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT blocks_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE TABLE mutes (
    muter_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    muted_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (muter_id, muted_id),
    CONSTRAINT mutes_no_self_mute CHECK (muter_id <> muted_id)
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
