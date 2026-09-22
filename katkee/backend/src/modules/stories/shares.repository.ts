import { query, queryOne } from "../../db/psql";

/** An append-only analytics log (spec section 12's story_share event) — not idempotent, unlike likes/views. */
export async function recordShare(storyId: string, userId: string): Promise<void> {
  await query(`INSERT INTO story_shares (story_id, user_id) VALUES (:'story_id', :'user_id')`, {
    story_id: storyId,
    user_id: userId,
  });
}

export async function countShares(storyId: string): Promise<number> {
  const row = await queryOne(`SELECT COUNT(*) AS n FROM story_shares WHERE story_id = :'story_id'`, {
    story_id: storyId,
  });
  return Number(row?.n ?? 0);
}
