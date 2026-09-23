import { query, queryOne, type Row } from "../../db/psql";

export type Audience = "public" | "followers";
export type CommentSetting = "everyone" | "followers" | "disabled";

export interface StoryRecord {
  id: string;
  ownerId: string;
  mediaId: string;
  caption: string;
  audience: Audience;
  allowComments: CommentSetting;
  allowSharing: boolean;
  createdAt: string;
  expiresAt: string;
  deletedAt: string | null;
}

function mapRow(row: Row): StoryRecord {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    mediaId: row.media_id as string,
    caption: row.caption as string,
    audience: row.audience as Audience,
    allowComments: row.allow_comments as CommentSetting,
    allowSharing: row.allow_sharing === "t",
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    deletedAt: row.deleted_at ?? null,
  };
}

export async function createStory(input: {
  ownerId: string;
  mediaId: string;
  caption: string;
  audience: Audience;
  allowComments: CommentSetting;
  allowSharing: boolean;
  expiresAt: Date;
}): Promise<StoryRecord> {
  const row = await queryOne(
    `INSERT INTO stories (owner_id, media_id, caption, audience, allow_comments, allow_sharing, expires_at)
     VALUES (:'owner_id', :'media_id', :'caption', :'audience', :'allow_comments', :'allow_sharing', :'expires_at')
     RETURNING id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at`,
    {
      owner_id: input.ownerId,
      media_id: input.mediaId,
      caption: input.caption,
      audience: input.audience,
      allow_comments: input.allowComments,
      allow_sharing: input.allowSharing,
      expires_at: input.expiresAt.toISOString(),
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapRow(row);
}

export async function findStoryById(id: string): Promise<StoryRecord | null> {
  const row = await queryOne(
    `SELECT id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at
     FROM stories WHERE id = :'id'`,
    { id },
  );
  return row ? mapRow(row) : null;
}

export async function findStoryByMediaId(mediaId: string): Promise<StoryRecord | null> {
  const row = await queryOne(
    `SELECT id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at
     FROM stories WHERE media_id = :'media_id'`,
    { media_id: mediaId },
  );
  return row ? mapRow(row) : null;
}

export async function softDeleteStory(id: string): Promise<void> {
  await query(`UPDATE stories SET deleted_at = now() WHERE id = :'id'`, { id });
}

/** A user's currently-active (not expired, not deleted) Stories, oldest first — the day's sequence. */
export async function listActiveStoriesForOwner(ownerId: string): Promise<StoryRecord[]> {
  const rows = await query(
    `SELECT id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at
     FROM stories
     WHERE owner_id = :'owner_id' AND deleted_at IS NULL AND expires_at > now()
     ORDER BY created_at ASC`,
    { owner_id: ownerId },
  );
  return rows.map(mapRow);
}

/**
 * Every followee (+ optionally self) with at least one active Story,
 * most-recent-story-first. This is deliberately just "the following feed"
 * — a follower can see both a followed owner's 'public' and 'followers'
 * Stories, so audience doesn't need to be re-checked here (it's still
 * enforced per-story in getStory/listActiveStoriesForOwner for anyone
 * reaching a story directly). Recommending or surfacing public creators
 * the viewer does NOT already follow is real discovery/ranking — Phase 6
 * — and deliberately isn't attempted by this Phase 4 plumbing query.
 */
export async function listActiveStoryOwnersForViewer(
  viewerId: string,
  includeSelf: boolean,
): Promise<{ ownerId: string; latestStoryAt: string }[]> {
  const rows = await query(
    `SELECT s.owner_id, MAX(s.created_at) AS latest_story_at
     FROM stories s
     WHERE s.deleted_at IS NULL
       AND s.expires_at > now()
       AND (
         (s.owner_id = :'viewer_id' AND :'include_self' = 'true')
         OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = :'viewer_id' AND f.followee_id = s.owner_id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = :'viewer_id' AND b.blocked_id = s.owner_id)
            OR (b.blocker_id = s.owner_id AND b.blocked_id = :'viewer_id')
       )
     GROUP BY s.owner_id
     ORDER BY latest_story_at DESC`,
    { viewer_id: viewerId, include_self: includeSelf },
  );
  return rows.map((row) => ({ ownerId: row.owner_id as string, latestStoryAt: row.latest_story_at as string }));
}

/**
 * Every non-deleted Story an owner has ever published, expired or not,
 * most recent first — the Archive that migration 0005's comment on
 * `deleted_at` (never hard-deleting on expiry) was written for. Phase 9
 * finally exercises it: Highlights are a curated, public subset of this
 * same history.
 */
export async function listArchivedStoriesForOwner(ownerId: string, limit: number, offset: number): Promise<StoryRecord[]> {
  const rows = await query(
    `SELECT id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at
     FROM stories
     WHERE owner_id = :'owner_id' AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { owner_id: ownerId, limit, offset },
  );
  return rows.map(mapRow);
}

export async function recordView(storyId: string, viewerId: string): Promise<void> {
  await query(
    `INSERT INTO story_views (story_id, viewer_id) VALUES (:'story_id', :'viewer_id')
     ON CONFLICT (story_id, viewer_id) DO NOTHING`,
    { story_id: storyId, viewer_id: viewerId },
  );
}

export async function countViews(storyId: string): Promise<number> {
  const row = await queryOne(`SELECT COUNT(*) AS n FROM story_views WHERE story_id = :'story_id'`, {
    story_id: storyId,
  });
  return Number(row?.n ?? 0);
}

export interface StoryViewerRow {
  id: string;
  username: string;
  displayName: string;
  viewedAt: string;
}

/** Owner-only (enforced in stories.service.ts) — the actual identities behind countViews' number. */
export async function listViewers(storyId: string, limit: number, offset: number): Promise<StoryViewerRow[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, sv.viewed_at
     FROM story_views sv
     JOIN users u ON u.id = sv.viewer_id
     WHERE sv.story_id = :'story_id'
     ORDER BY sv.viewed_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { story_id: storyId, limit, offset },
  );
  return rows.map((r) => ({
    id: String(r.id),
    username: String(r.username),
    displayName: String(r.display_name),
    viewedAt: String(r.viewed_at),
  }));
}
