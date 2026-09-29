-- Phase 7: Activity notifications (spec section 31) — likes, comments,
-- follows, follow requests, and @mentions in comments. Never DMs (those
-- are Phase 8, and get their own inbox, not this feed).

CREATE TABLE notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    actor_id            UUID NULL REFERENCES users (id) ON DELETE CASCADE,
    type                TEXT NOT NULL,
    story_id            UUID NULL REFERENCES stories (id) ON DELETE CASCADE,
    comment_id          UUID NULL REFERENCES story_comments (id) ON DELETE CASCADE,
    follow_request_id   UUID NULL REFERENCES follow_requests (id) ON DELETE CASCADE,
    read_at             TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notifications_type_valid CHECK (type IN ('like', 'comment', 'follow', 'follow_request', 'mention'))
);

-- The Activity list itself: newest first, one recipient at a time.
CREATE INDEX notifications_recipient_created_idx ON notifications (recipient_id, created_at DESC);
-- The unread badge count needs this to stay cheap regardless of how much
-- read history a recipient accumulates.
CREATE INDEX notifications_recipient_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
