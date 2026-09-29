-- Phase 8: 1:1 direct messages. Group DMs aren't in scope for this pass —
-- nothing in the spec build order through Phase 8 requires them, and a
-- 1:1-only schema is meaningfully simpler (no membership table needed to
-- find-or-create a conversation, just a canonically-ordered pair).

CREATE TABLE conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Canonically ordered so a (viewer, target) pair maps to exactly one
    -- conversation regardless of who started it — find-or-create is a
    -- single indexed lookup, not a join across a membership table.
    user_a_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_b_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversations_ordered_pair CHECK (user_a_id < user_b_id),
    CONSTRAINT conversations_unique_pair UNIQUE (user_a_id, user_b_id)
);

CREATE TABLE messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body                TEXT NULL,
    -- A shared Story (spec section 15's "Send to a Katkee user"). SET NULL
    -- rather than CASCADE on delete: the message ("Alex shared a Story")
    -- should survive the Story's own deletion/expiry, just like a text
    -- conversation survives one side deleting an old message elsewhere.
    shared_story_id     UUID NULL REFERENCES stories (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messages_body_length CHECK (body IS NULL OR char_length(body) <= 2000),
    CONSTRAINT messages_body_or_story CHECK (body IS NOT NULL OR shared_story_id IS NOT NULL)
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at);

-- Per-participant read state — a conversation itself has no "unread" flag,
-- only what each participant has and hasn't seen yet.
CREATE TABLE conversation_reads (
    conversation_id     UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    last_read_at        TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
    PRIMARY KEY (conversation_id, user_id)
);
