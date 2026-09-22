-- Phase 9: Highlights — permanent, named collections of a user's own past
-- Stories, shown on their profile, surviving the 24h expiry that governs
-- ordinary Story visibility (that survival is the entire point of a
-- Highlight). A Highlight's "cover" is deliberately not a stored column —
-- it's computed as its first item's Story media, so this pass doesn't need
-- a separate cover-image upload/crop flow (this sandbox has no image
-- processing anyway — see backend/README.md's media limitations).

CREATE TABLE highlights (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT highlights_title_length CHECK (char_length(title) BETWEEN 1 AND 30)
);
CREATE INDEX highlights_owner_idx ON highlights (owner_id, created_at);

CREATE TABLE highlight_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    highlight_id  UUID NOT NULL REFERENCES highlights (id) ON DELETE CASCADE,
    -- Deliberately no FK-level ON DELETE CASCADE from stories: a soft
    -- delete (stories.deleted_at) is how this schema actually removes a
    -- Story, and the application layer (stories.service.deleteStory)
    -- explicitly cleans up any highlight_items referencing it — see that
    -- function's own comment for why this is app logic, not a DB trigger.
    story_id      UUID NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT highlight_items_unique_story UNIQUE (highlight_id, story_id)
);
CREATE INDEX highlight_items_highlight_position_idx ON highlight_items (highlight_id, position);
