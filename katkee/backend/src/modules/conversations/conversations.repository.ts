import { nullable, query, queryOne, type Row } from "../../db/psql";

export interface ConversationRow {
  id: string;
  userAId: string;
  userBId: string;
  createdAt: string;
}

function mapConversationRow(row: Row): ConversationRow {
  return {
    id: row.id as string,
    userAId: row.user_a_id as string,
    userBId: row.user_b_id as string,
    createdAt: row.created_at as string,
  };
}

/** The canonical (a, b) ordering this schema's UNIQUE constraint expects — a < b, not caller order. */
function orderedPair(userIdA: string, userIdB: string): [string, string] {
  return userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
}

export async function findConversationBetween(userIdA: string, userIdB: string): Promise<ConversationRow | null> {
  const [a, b] = orderedPair(userIdA, userIdB);
  const row = await queryOne(
    `SELECT id, user_a_id, user_b_id, created_at FROM conversations WHERE user_a_id = :'a' AND user_b_id = :'b'`,
    { a, b },
  );
  return row ? mapConversationRow(row) : null;
}

export async function createConversation(userIdA: string, userIdB: string): Promise<ConversationRow> {
  const [a, b] = orderedPair(userIdA, userIdB);
  const rows = await query(
    `INSERT INTO conversations (user_a_id, user_b_id) VALUES (:'a', :'b')
     ON CONFLICT (user_a_id, user_b_id) DO NOTHING
     RETURNING id, user_a_id, user_b_id, created_at`,
    { a, b },
  );
  if (rows.length > 0) return mapConversationRow(rows[0]!);
  // Lost a create race against the other participant — the row now exists; fetch it.
  const existing = await findConversationBetween(a, b);
  if (!existing) throw new Error("Conversation not found immediately after a conflicting insert");
  return existing;
}

export async function findConversationById(id: string): Promise<ConversationRow | null> {
  const row = await queryOne(`SELECT id, user_a_id, user_b_id, created_at FROM conversations WHERE id = :'id'`, { id });
  return row ? mapConversationRow(row) : null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  sharedStoryId: string | null;
  createdAt: string;
}

function mapMessageRow(row: Row): MessageRow {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    senderId: row.sender_id as string,
    body: (row.body as string | null) ?? null,
    sharedStoryId: (row.shared_story_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function createMessage(
  conversationId: string,
  senderId: string,
  body: string | null,
  sharedStoryId: string | null,
): Promise<MessageRow> {
  const row = await queryOne(
    `INSERT INTO messages (conversation_id, sender_id, body, shared_story_id)
     VALUES (:'conversation_id', :'sender_id', ${nullable("body")}, ${nullable("shared_story_id", "uuid")})
     RETURNING id, conversation_id, sender_id, body, shared_story_id, created_at`,
    { conversation_id: conversationId, sender_id: senderId, body: body ?? "", shared_story_id: sharedStoryId ?? "" },
  );
  if (!row) throw new Error("Message insert returned no row");
  // Sending a message is itself an implicit "I've seen everything up to here."
  await markRead(conversationId, senderId);
  return mapMessageRow(row);
}

/**
 * Newest first, unlike comments' oldest-first listing — a chat thread's
 * default page should be the latest activity, not the start of a
 * potentially months-old conversation. Callers reverse for top-to-bottom
 * display.
 */
export async function listMessages(conversationId: string, limit: number, offset: number): Promise<MessageRow[]> {
  const rows = await query(
    `SELECT id, conversation_id, sender_id, body, shared_story_id, created_at
     FROM messages
     WHERE conversation_id = :'conversation_id'
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { conversation_id: conversationId, limit, offset },
  );
  return rows.map(mapMessageRow);
}

/** Reading obviously implies delivery too, so this bumps both watermarks. */
export async function markRead(conversationId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at, last_delivered_at)
     VALUES (:'conversation_id', :'user_id', now(), now())
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET
       last_read_at = now(),
       last_delivered_at = GREATEST(conversation_reads.last_delivered_at, now())`,
    { conversation_id: conversationId, user_id: userId },
  );
}

/**
 * Bumped whenever a participant's client successfully fetches messages
 * (see conversations.service.ts's listMessages) — the real, honestly-
 * scoped "delivered" signal this backend can observe with no push/
 * WebSocket channel: the recipient's app actually received the data on a
 * real fetch, not just "the server has it" (that's `sent`, the default).
 */
export async function markDelivered(conversationId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_delivered_at)
     VALUES (:'conversation_id', :'user_id', now())
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_delivered_at = GREATEST(conversation_reads.last_delivered_at, now())`,
    { conversation_id: conversationId, user_id: userId },
  );
}

export interface ReadState {
  lastReadAt: string;
  lastDeliveredAt: string;
}

const EPOCH = new Date(0).toISOString();

/** A participant's own read/delivered watermarks — defaults to epoch (never read, never delivered) if they've never fetched or read this conversation at all. */
export async function getReadState(conversationId: string, userId: string): Promise<ReadState> {
  const row = await queryOne(
    `SELECT last_read_at, last_delivered_at FROM conversation_reads WHERE conversation_id = :'conversation_id' AND user_id = :'user_id'`,
    { conversation_id: conversationId, user_id: userId },
  );
  return {
    lastReadAt: (row?.last_read_at as string) ?? EPOCH,
    lastDeliveredAt: (row?.last_delivered_at as string) ?? EPOCH,
  };
}

export interface ConversationSummary {
  id: string;
  otherUser: { id: string; username: string; displayName: string };
  lastMessage: {
    id: string;
    senderId: string;
    body: string | null;
    sharedStoryId: string | null;
    createdAt: string;
  } | null;
  unread: boolean;
  createdAt: string;
}

function mapConversationSummaryRow(row: Row): ConversationSummary {
  return {
    id: row.id as string,
    otherUser: {
      id: row.other_user_id as string,
      username: row.other_username as string,
      displayName: row.other_display_name as string,
    },
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id as string,
          senderId: row.last_message_sender_id as string,
          body: (row.last_message_body as string | null) ?? null,
          sharedStoryId: (row.last_message_shared_story_id as string | null) ?? null,
          createdAt: row.last_message_created_at as string,
        }
      : null,
    unread: row.is_unread === "t",
    createdAt: row.created_at as string,
  };
}

export async function listConversationsForUser(userId: string, limit: number, offset: number): Promise<ConversationSummary[]> {
  const rows = await query(
    `SELECT
       c.id, c.created_at,
       ou.id AS other_user_id, ou.username AS other_username, ou.display_name AS other_display_name,
       lm.id AS last_message_id, lm.sender_id AS last_message_sender_id, lm.body AS last_message_body,
       lm.shared_story_id AS last_message_shared_story_id, lm.created_at AS last_message_created_at,
       (lm.created_at IS NOT NULL AND lm.created_at > COALESCE(cr.last_read_at, 'epoch')) AS is_unread
     FROM conversations c
     JOIN users ou ON ou.id = (CASE WHEN c.user_a_id = :'user_id' THEN c.user_b_id ELSE c.user_a_id END)
     LEFT JOIN LATERAL (
       SELECT id, sender_id, body, shared_story_id, created_at
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON true
     LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = :'user_id'
     WHERE c.user_a_id = :'user_id' OR c.user_b_id = :'user_id'
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { user_id: userId, limit, offset },
  );
  return rows.map(mapConversationSummaryRow);
}

export async function countUnreadConversations(userId: string): Promise<number> {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM (
       SELECT c.id
       FROM conversations c
       JOIN LATERAL (
         SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = :'user_id'
       WHERE (c.user_a_id = :'user_id' OR c.user_b_id = :'user_id')
         AND lm.created_at > COALESCE(cr.last_read_at, 'epoch')
     ) unread_conversations`,
    { user_id: userId },
  );
  return Number(row?.n ?? 0);
}
