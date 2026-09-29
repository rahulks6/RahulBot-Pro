-- Phase 6: analytics events for signals that don't already have a
-- dedicated table (likes/comments/shares/mutes/blocks are already real
-- rows from Phases 2 and 5 — scoring reads those directly rather than
-- duplicating them here), plus the one real per-viewer exclusion rule
-- ("Not Interested") that recommendation candidate generation filters on.

CREATE TABLE recommendation_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    viewer_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_type          TEXT NOT NULL,
    creator_id          UUID NULL REFERENCES users (id) ON DELETE CASCADE,
    story_id            UUID NULL REFERENCES stories (id) ON DELETE CASCADE,
    value_ms            INTEGER NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT recommendation_events_type_valid CHECK (event_type IN (
        'creator_impression', 'story_impression', 'qualified_view', 'watch_duration',
        'story_complete', 'story_next', 'story_previous',
        'creator_sequence_started', 'creator_sequence_continued', 'creator_sequence_completed',
        'creator_swipe_next', 'creator_swipe_previous', 'quick_creator_skip', 'story_replay',
        'comment_open', 'profile_visit', 'follow_after_story', 'repeat_creator_visit', 'not_interested'
    )),
    CONSTRAINT recommendation_events_value_ms_nonnegative CHECK (value_ms IS NULL OR value_ms >= 0)
);

-- Scoring aggregates "how has this viewer engaged with this creator" and
-- "how is this creator doing overall" — both read by creator_id/story_id
-- filtered by event_type and a recency window.
CREATE INDEX recommendation_events_creator_type_idx ON recommendation_events (creator_id, event_type, created_at);
CREATE INDEX recommendation_events_viewer_creator_idx ON recommendation_events (viewer_id, creator_id, created_at);
-- Impression-type events are application-level deduplicated (see
-- events.repository.ts) by checking this same index for a recent row
-- before inserting, rather than a hard uniqueness constraint — a second
-- impression after enough time really is a new, meaningful impression.
CREATE INDEX recommendation_events_viewer_story_type_idx ON recommendation_events (viewer_id, story_id, event_type, created_at);

CREATE TABLE creator_not_interested (
    viewer_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    creator_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (viewer_id, creator_id),
    CONSTRAINT creator_not_interested_no_self CHECK (viewer_id <> creator_id)
);
