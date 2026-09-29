-- Story Insights' "following vs. discovery" split (Phase 13) was a *live*
-- join against `follows` — each viewer's CURRENT relationship to the
-- owner, not what it was when they actually viewed the Story. This
-- closes that gap for real: a snapshot taken at view time, not
-- approximated after the fact.
ALTER TABLE story_views ADD COLUMN was_following BOOLEAN;

-- Backfill existing rows the only way possible after the fact — each
-- viewer's *current* relationship, same approximation the live-join
-- version made, but only for rows that already existed before this
-- migration ran. Every view recorded from here on gets the real thing
-- (see stories.repository.ts's recordView).
UPDATE story_views sv
SET was_following = EXISTS (
    SELECT 1 FROM follows f
    JOIN stories s ON s.id = sv.story_id
    WHERE f.follower_id = sv.viewer_id AND f.followee_id = s.owner_id
);

ALTER TABLE story_views ALTER COLUMN was_following SET NOT NULL;
ALTER TABLE story_views ALTER COLUMN was_following SET DEFAULT false;
