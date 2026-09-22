import { query } from "../../db/psql";

const MAX_EXPLORE_CANDIDATES = 50;

/**
 * Every creator eligible to be shown to this viewer at all: has an active
 * Story, isn't the viewer, isn't blocked (either direction) or muted,
 * isn't marked Not Interested, and — if their account is private — the
 * viewer already follows them (private Stories never enter discovery).
 * Followed creators are never capped; non-followed ("explore") candidates
 * are capped at MAX_EXPLORE_CANDIDATES most-recently-active, to bound the
 * per-candidate scoring queries below rather than scoring every public
 * creator on the platform on every request.
 */
export async function listEligibleCreatorIds(viewerId: string): Promise<string[]> {
  const rows = await query(
    `WITH candidates AS (
       SELECT DISTINCT ON (s.owner_id) s.owner_id, u.is_private,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = :'viewer_id' AND f.followee_id = s.owner_id) AS is_following,
              MAX(s.created_at) OVER (PARTITION BY s.owner_id) AS latest_story_at
       FROM stories s
       JOIN users u ON u.id = s.owner_id
       WHERE s.deleted_at IS NULL AND s.expires_at > now()
         AND u.deleted_at IS NULL AND u.is_active AND u.id <> :'viewer_id'
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = :'viewer_id' AND b.blocked_id = s.owner_id)
              OR (b.blocker_id = s.owner_id AND b.blocked_id = :'viewer_id')
         )
         AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = :'viewer_id' AND m.muted_id = s.owner_id)
         AND NOT EXISTS (
           SELECT 1 FROM creator_not_interested n WHERE n.viewer_id = :'viewer_id' AND n.creator_id = s.owner_id
         )
     )
     SELECT owner_id FROM candidates
     WHERE is_following OR NOT is_private
     ORDER BY is_following DESC, latest_story_at DESC
     LIMIT :'limit'`,
    // Followed creators sort first, so this only ever trims explore
    // candidates in practice (an account following more than ~250 active
    // creators at once is unrealistic for now) — a hard per-viewer cap
    // on followed creators isn't attempted here, matching Phase 4/5's own
    // "following feed" behavior.
    { viewer_id: viewerId, limit: MAX_EXPLORE_CANDIDATES + 200 },
  );
  return rows.map((r) => r.owner_id as string);
}

export { MAX_EXPLORE_CANDIDATES };
