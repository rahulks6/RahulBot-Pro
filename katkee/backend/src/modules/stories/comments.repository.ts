import { query, queryOne, type Row } from "../../db/psql";

export interface CommentRecord {
  id: string;
  storyId: string;
  userId: string;
  username: string;
  displayName: string;
  body: string;
  createdAt: string;
}

function mapRow(row: Row): CommentRecord {
  return {
    id: row.id as string,
    storyId: row.story_id as string,
    userId: row.user_id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    body: row.body as string,
    createdAt: row.created_at as string,
  };
}

export async function createComment(storyId: string, userId: string, body: string): Promise<CommentRecord> {
  const row = await queryOne(
    `WITH inserted AS (
       INSERT INTO story_comments (story_id, user_id, body)
       VALUES (:'story_id', :'user_id', :'body')
       RETURNING id, story_id, user_id, body, created_at
     )
     SELECT inserted.id, inserted.story_id, inserted.user_id, inserted.body, inserted.created_at,
            u.username, u.display_name
     FROM inserted JOIN users u ON u.id = inserted.user_id`,
    { story_id: storyId, user_id: userId, body },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapRow(row);
}

export async function listComments(storyId: string, limit: number, offset: number): Promise<CommentRecord[]> {
  const rows = await query(
    `SELECT c.id, c.story_id, c.user_id, c.body, c.created_at, u.username, u.display_name
     FROM story_comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.story_id = :'story_id' AND c.deleted_at IS NULL AND u.deleted_at IS NULL
     ORDER BY c.created_at ASC
     LIMIT :'limit' OFFSET :'offset'`,
    { story_id: storyId, limit, offset },
  );
  return rows.map(mapRow);
}

export async function countComments(storyId: string): Promise<number> {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM story_comments WHERE story_id = :'story_id' AND deleted_at IS NULL`,
    { story_id: storyId },
  );
  return Number(row?.n ?? 0);
}

interface CommentOwnership {
  id: string;
  storyId: string;
  userId: string;
  storyOwnerId: string;
}

export async function findCommentWithStoryOwner(commentId: string): Promise<CommentOwnership | null> {
  const row = await queryOne(
    `SELECT c.id, c.story_id, c.user_id, s.owner_id AS story_owner_id
     FROM story_comments c
     JOIN stories s ON s.id = c.story_id
     WHERE c.id = :'id' AND c.deleted_at IS NULL`,
    { id: commentId },
  );
  if (!row) return null;
  return {
    id: row.id as string,
    storyId: row.story_id as string,
    userId: row.user_id as string,
    storyOwnerId: row.story_owner_id as string,
  };
}

/** How many times this viewer has commented on this creator's Stories, ever — a real "meaningful reply" signal for recommendation scoring (spec section 7). */
export async function countCommentsByUserOnCreator(viewerId: string, creatorId: string): Promise<number> {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM story_comments c
     JOIN stories s ON s.id = c.story_id
     WHERE c.user_id = :'viewer_id' AND s.owner_id = :'creator_id' AND c.deleted_at IS NULL`,
    { viewer_id: viewerId, creator_id: creatorId },
  );
  return Number(row?.n ?? 0);
}

export async function softDeleteComment(commentId: string): Promise<void> {
  await query(`UPDATE story_comments SET deleted_at = now() WHERE id = :'id'`, { id: commentId });
}
