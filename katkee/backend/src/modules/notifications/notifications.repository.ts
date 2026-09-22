import { nullable, query, queryOne, type Row } from "../../db/psql";

export type NotificationType = "like" | "comment" | "follow" | "follow_request" | "mention";

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  createdAt: string;
  readAt: string | null;
  actor: { id: string; username: string; displayName: string } | null;
  story: { id: string; mediaId: string } | null;
  comment: { id: string; body: string } | null;
  followRequest: { id: string; status: string } | null;
}

function mapRow(row: Row): NotificationRecord {
  return {
    id: row.id as string,
    type: row.type as NotificationType,
    createdAt: row.created_at as string,
    readAt: (row.read_at as string | null) ?? null,
    actor: row.actor_id ? { id: row.actor_id as string, username: row.actor_username as string, displayName: row.actor_display_name as string } : null,
    story: row.story_id ? { id: row.story_id as string, mediaId: row.story_media_id as string } : null,
    comment: row.comment_id ? { id: row.comment_id as string, body: row.comment_body as string } : null,
    followRequest: row.follow_request_id ? { id: row.follow_request_id as string, status: row.follow_request_status as string } : null,
  };
}

const SELECT_COLUMNS = `
  n.id, n.type, n.created_at, n.read_at,
  a.id AS actor_id, a.username AS actor_username, a.display_name AS actor_display_name,
  s.id AS story_id, s.media_id AS story_media_id,
  c.id AS comment_id, c.body AS comment_body,
  fr.id AS follow_request_id, fr.status AS follow_request_status
`;

const JOINS = `
  FROM notifications n
  LEFT JOIN users a ON a.id = n.actor_id AND a.deleted_at IS NULL
  LEFT JOIN stories s ON s.id = n.story_id
  LEFT JOIN story_comments c ON c.id = n.comment_id
  LEFT JOIN follow_requests fr ON fr.id = n.follow_request_id
`;

export async function createNotification(input: {
  recipientId: string;
  actorId: string | null;
  type: NotificationType;
  storyId?: string;
  commentId?: string;
  followRequestId?: string;
}): Promise<void> {
  if (input.actorId && input.actorId === input.recipientId) return; // never notify someone about their own action

  await query(
    `INSERT INTO notifications (recipient_id, actor_id, type, story_id, comment_id, follow_request_id)
     VALUES (:'recipient_id', ${nullable("actor_id", "uuid")}, :'type', ${nullable("story_id", "uuid")}, ${nullable("comment_id", "uuid")}, ${nullable("follow_request_id", "uuid")})`,
    {
      recipient_id: input.recipientId,
      actor_id: input.actorId,
      type: input.type,
      story_id: input.storyId ?? null,
      comment_id: input.commentId ?? null,
      follow_request_id: input.followRequestId ?? null,
    },
  );
}

export async function listForRecipient(recipientId: string, limit: number, offset: number): Promise<NotificationRecord[]> {
  const rows = await query(
    `SELECT ${SELECT_COLUMNS} ${JOINS}
     WHERE n.recipient_id = :'recipient_id'
     ORDER BY n.created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { recipient_id: recipientId, limit, offset },
  );
  return rows.map(mapRow);
}

export async function countUnread(recipientId: string): Promise<number> {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = :'recipient_id' AND read_at IS NULL`,
    { recipient_id: recipientId },
  );
  return Number(row?.n ?? 0);
}

/** Ownership-scoped by design — a recipient can only ever mark their own notifications read. */
export async function markRead(id: string, recipientId: string): Promise<void> {
  await query(
    `UPDATE notifications SET read_at = now() WHERE id = :'id' AND recipient_id = :'recipient_id' AND read_at IS NULL`,
    { id, recipient_id: recipientId },
  );
}

export async function markAllRead(recipientId: string): Promise<void> {
  await query(`UPDATE notifications SET read_at = now() WHERE recipient_id = :'recipient_id' AND read_at IS NULL`, {
    recipient_id: recipientId,
  });
}
