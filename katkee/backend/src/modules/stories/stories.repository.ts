import { query, queryOne, type Row } from "../../db/psql";
import type { StoryOverlay, DrawStroke, FilterKey, StoryCrop } from "./overlays";

export type Audience = "public" | "followers";
export type CommentSetting = "everyone" | "followers" | "disabled";

const STORY_COLUMNS =
  "id, owner_id, media_id, caption, audience, allow_comments, allow_sharing, created_at, expires_at, deleted_at, overlays, drawing, filter, audio_muted, crop";

const DEFAULT_CROP: StoryCrop = { zoom: 1, offsetX: 0, offsetY: 0 };

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
  overlays: StoryOverlay[];
  drawing: DrawStroke[];
  filter: FilterKey;
  audioMuted: boolean;
  crop: StoryCrop;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseCropJson(raw: string | null | undefined): StoryCrop {
  if (!raw) return DEFAULT_CROP;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_CROP;
    const { zoom, offsetX, offsetY } = parsed as Record<string, unknown>;
    if (typeof zoom !== "number" || typeof offsetX !== "number" || typeof offsetY !== "number") return DEFAULT_CROP;
    return { zoom, offsetX, offsetY };
  } catch {
    return DEFAULT_CROP;
  }
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
    overlays: parseJsonArray<StoryOverlay>(row.overlays),
    drawing: parseJsonArray<DrawStroke>(row.drawing),
    filter: (row.filter as FilterKey) ?? "original",
    audioMuted: row.audio_muted === "t",
    crop: parseCropJson(row.crop),
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
  overlays: StoryOverlay[];
  drawing: DrawStroke[];
  filter: FilterKey;
  audioMuted: boolean;
  crop: StoryCrop;
}): Promise<StoryRecord> {
  const row = await queryOne(
    `INSERT INTO stories (owner_id, media_id, caption, audience, allow_comments, allow_sharing, expires_at, overlays, drawing, filter, audio_muted, crop)
     VALUES (:'owner_id', :'media_id', :'caption', :'audience', :'allow_comments', :'allow_sharing', :'expires_at', :'overlays'::jsonb, :'drawing'::jsonb, :'filter', :'audio_muted', :'crop'::jsonb)
     RETURNING ${STORY_COLUMNS}`,
    {
      owner_id: input.ownerId,
      media_id: input.mediaId,
      caption: input.caption,
      audience: input.audience,
      allow_comments: input.allowComments,
      allow_sharing: input.allowSharing,
      expires_at: input.expiresAt.toISOString(),
      overlays: JSON.stringify(input.overlays),
      drawing: JSON.stringify(input.drawing),
      filter: input.filter,
      audio_muted: input.audioMuted,
      crop: JSON.stringify(input.crop),
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapRow(row);
}

export async function findStoryById(id: string): Promise<StoryRecord | null> {
  const row = await queryOne(`SELECT ${STORY_COLUMNS} FROM stories WHERE id = :'id'`, { id });
  return row ? mapRow(row) : null;
}

export async function findStoryByMediaId(mediaId: string): Promise<StoryRecord | null> {
  const row = await queryOne(`SELECT ${STORY_COLUMNS} FROM stories WHERE media_id = :'media_id'`, { media_id: mediaId });
  return row ? mapRow(row) : null;
}

export async function softDeleteStory(id: string): Promise<void> {
  await query(`UPDATE stories SET deleted_at = now() WHERE id = :'id'`, { id });
}

/** A user's currently-active (not expired, not deleted) Stories, oldest first — the day's sequence. */
export async function listActiveStoriesForOwner(ownerId: string): Promise<StoryRecord[]> {
  const rows = await query(
    `SELECT ${STORY_COLUMNS}
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
    `SELECT ${STORY_COLUMNS}
     FROM stories
     WHERE owner_id = :'owner_id' AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { owner_id: ownerId, limit, offset },
  );
  return rows.map(mapRow);
}

/**
 * `was_following` is a real snapshot, taken right now — whether this
 * viewer already followed the Story's owner at the exact moment of this
 * view, not looked up later against whatever the relationship happens to
 * be by the time someone checks Insights (spec: Views vs. Viewers,
 * following-vs-discovery — see getStoryInsights' own comment for why
 * that distinction matters). `ON CONFLICT DO NOTHING` means a repeat
 * view by the same viewer never overwrites it — the snapshot is from
 * their *first* view, which is the one "did they already follow before
 * they ever saw this" is actually asking about.
 */
export async function recordView(storyId: string, viewerId: string): Promise<void> {
  await query(
    `INSERT INTO story_views (story_id, viewer_id, was_following)
     VALUES (
       :'story_id', :'viewer_id',
       EXISTS (
         SELECT 1 FROM follows f
         JOIN stories s ON s.id = :'story_id'
         WHERE f.follower_id = :'viewer_id' AND f.followee_id = s.owner_id
       )
     )
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

export interface InsightsCounts {
  totalViews: number;
  followingViews: number;
  completedViews: number;
  profileVisitViews: number;
}

function mapInsightsRow(row: Row | null): InsightsCounts {
  return {
    totalViews: Number(row?.total_views ?? 0),
    followingViews: Number(row?.following_views ?? 0),
    completedViews: Number(row?.completed_views ?? 0),
    profileVisitViews: Number(row?.profile_visit_views ?? 0),
  };
}

/**
 * Real, honestly-scoped Insights (spec): everything here comes from data
 * this backend actually has, not invented numbers.
 * - "Following" vs "discovery" is `story_views.was_following` — a real
 *   snapshot taken at the moment of the viewer's own first view (see
 *   recordView's own comment), not a live lookup against whatever the
 *   relationship happens to be by the time someone checks Insights.
 * - "Completed" reuses story_complete, the same recommendation-scoring
 *   event Phase 6 already records for every Story (spec section 13).
 * - "Profile visit" reuses profile_visit, already creator-scoped (not
 *   story-scoped) — a viewer counts if they ever visited this creator's
 *   profile, not provably *because* of this specific Story.
 */
export async function getStoryInsights(storyId: string, ownerId: string): Promise<InsightsCounts> {
  const row = await queryOne(
    `SELECT
       COUNT(*) AS total_views,
       COUNT(*) FILTER (WHERE sv.was_following) AS following_views,
       COUNT(*) FILTER (WHERE sc.viewer_id IS NOT NULL) AS completed_views,
       COUNT(*) FILTER (WHERE pv.viewer_id IS NOT NULL) AS profile_visit_views
     FROM story_views sv
     LEFT JOIN (
       SELECT DISTINCT viewer_id FROM recommendation_events WHERE story_id = :'story_id' AND event_type = 'story_complete'
     ) sc ON sc.viewer_id = sv.viewer_id
     LEFT JOIN (
       SELECT DISTINCT viewer_id FROM recommendation_events WHERE creator_id = :'owner_id' AND event_type = 'profile_visit'
     ) pv ON pv.viewer_id = sv.viewer_id
     WHERE sv.story_id = :'story_id'`,
    { story_id: storyId, owner_id: ownerId },
  );
  return mapInsightsRow(row);
}

/**
 * The same shape, one level up: every currently-active Story the owner
 * has, at once (spec: "per-sequence Insights", the run of Stories a
 * viewer swipes through for one creator — see StoryFeed.tsx). "Completed"
 * here means creator_sequence_completed (reached the end of the whole
 * sequence), the sequence-level counterpart to story_complete above —
 * not "completed at least one Story in it", which would count someone
 * who bailed after the first as a completion. "Following" uses each
 * viewer's *most recent* view's real was_following snapshot within this
 * sequence (DISTINCT ON, ordered newest first) — the meaningful answer
 * to "were they already following by the time they were watching this
 * run" when the same viewer appears across more than one of these
 * Stories, rather than picking an arbitrary one of their views.
 */
export async function getSequenceInsights(ownerId: string): Promise<InsightsCounts> {
  const row = await queryOne(
    `WITH latest_view AS (
       SELECT DISTINCT ON (viewer_id) viewer_id, was_following
       FROM story_views
       WHERE story_id IN (
         SELECT id FROM stories WHERE owner_id = :'owner_id' AND deleted_at IS NULL AND expires_at > now()
       )
       ORDER BY viewer_id, viewed_at DESC
     )
     SELECT
       COUNT(*) AS total_views,
       COUNT(*) FILTER (WHERE lv.was_following) AS following_views,
       COUNT(*) FILTER (WHERE sc.viewer_id IS NOT NULL) AS completed_views,
       COUNT(*) FILTER (WHERE pv.viewer_id IS NOT NULL) AS profile_visit_views
     FROM latest_view lv
     LEFT JOIN (
       SELECT DISTINCT viewer_id FROM recommendation_events WHERE creator_id = :'owner_id' AND event_type = 'creator_sequence_completed'
     ) sc ON sc.viewer_id = lv.viewer_id
     LEFT JOIN (
       SELECT DISTINCT viewer_id FROM recommendation_events WHERE creator_id = :'owner_id' AND event_type = 'profile_visit'
     ) pv ON pv.viewer_id = lv.viewer_id`,
    { owner_id: ownerId },
  );
  return mapInsightsRow(row);
}
