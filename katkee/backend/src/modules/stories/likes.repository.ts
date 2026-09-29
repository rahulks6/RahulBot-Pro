import { query, queryOne } from "../../db/psql";

/** Returns true only if this call actually created a new like (false if it was already liked) — callers use this to fire a notification exactly once, not on every idempotent repeat call. */
export async function likeStory(storyId: string, userId: string): Promise<boolean> {
  const rows = await query(
    `INSERT INTO story_likes (story_id, user_id) VALUES (:'story_id', :'user_id')
     ON CONFLICT (story_id, user_id) DO NOTHING
     RETURNING story_id`,
    { story_id: storyId, user_id: userId },
  );
  return rows.length > 0;
}

export async function unlikeStory(storyId: string, userId: string): Promise<void> {
  await query(`DELETE FROM story_likes WHERE story_id = :'story_id' AND user_id = :'user_id'`, {
    story_id: storyId,
    user_id: userId,
  });
}

export async function countLikes(storyId: string): Promise<number> {
  const row = await queryOne(`SELECT COUNT(*) AS n FROM story_likes WHERE story_id = :'story_id'`, {
    story_id: storyId,
  });
  return Number(row?.n ?? 0);
}

export async function hasLiked(storyId: string, userId: string): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM story_likes WHERE story_id = :'story_id' AND user_id = :'user_id' LIMIT 1`,
    { story_id: storyId, user_id: userId },
  );
  return rows.length > 0;
}
