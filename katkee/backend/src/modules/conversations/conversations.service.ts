import { HttpError } from "../../http/errors";
import { assertNotRestricted } from "../../shared/accountStatus";
import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as engagementService from "../stories/engagement.service";
import * as conversationsRepo from "./conversations.repository";
import type { ConversationRow, ConversationSummary, MessageRow } from "./conversations.repository";

async function requireOtherUser(username: string, viewerId: string): Promise<usersRepo.UserRecord> {
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.id === viewerId) throw new HttpError(400, "You can't message yourself.");
  return target;
}

async function assertNotBlocked(userIdA: string, userIdB: string): Promise<void> {
  const blocked = await socialRepo.anyBlockBetween(userIdA, userIdB);
  if (blocked) throw new HttpError(404, "User not found.");
}

export interface ConversationWithOtherUser {
  id: string;
  createdAt: string;
  otherUser: { id: string; username: string; displayName: string };
}

/** Find-or-create the 1:1 conversation with `targetUsername`, denied the same way a blocked profile 404s. */
export async function openConversationWith(viewerId: string, targetUsername: string): Promise<ConversationWithOtherUser> {
  const target = await requireOtherUser(targetUsername, viewerId);
  await assertNotBlocked(viewerId, target.id);
  const existing = await conversationsRepo.findConversationBetween(viewerId, target.id);
  if (!existing) {
    // Only a brand-new DM is blocked — an already-existing conversation
    // keeps working, matching the spec's "restricted" (not "suspended")
    // distinction: this is about starting new contact, not cutting off
    // conversations that already exist.
    await assertNotRestricted(viewerId, "start a new conversation");
  }
  const conversation = existing ?? (await conversationsRepo.createConversation(viewerId, target.id));
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    otherUser: { id: target.id, username: target.username, displayName: target.displayName },
  };
}

export async function listConversations(viewerId: string, limit: number, offset: number): Promise<ConversationSummary[]> {
  return conversationsRepo.listConversationsForUser(viewerId, limit, offset);
}

export async function getUnreadConversationCount(viewerId: string): Promise<number> {
  return conversationsRepo.countUnreadConversations(viewerId);
}

async function requireParticipant(conversationId: string, viewerId: string): Promise<ConversationRow> {
  const conversation = await conversationsRepo.findConversationById(conversationId);
  if (!conversation || (conversation.userAId !== viewerId && conversation.userBId !== viewerId)) {
    throw new HttpError(404, "Conversation not found.");
  }
  return conversation;
}

function otherParticipant(conversation: ConversationRow, viewerId: string): string {
  return conversation.userAId === viewerId ? conversation.userBId : conversation.userAId;
}

export interface SendMessageInput {
  body: string | null;
  storyId: string | null;
}

export async function sendMessage(viewerId: string, conversationId: string, input: SendMessageInput): Promise<MessageRow> {
  const conversation = await requireParticipant(conversationId, viewerId);
  const otherId = otherParticipant(conversation, viewerId);
  await assertNotBlocked(viewerId, otherId); // re-checked at send time, not just at conversation creation

  if (input.storyId) {
    // Reuses the exact same view-access + allowSharing rule and analytics
    // logging as the Share sheet's other two options (native share, copy
    // link) — see engagement.service.shareStory. A "Send to a Katkee user"
    // that skipped this check could leak a followers-only Story to someone
    // who couldn't otherwise see it.
    await engagementService.shareStory(viewerId, input.storyId);
  }

  return conversationsRepo.createMessage(conversationId, viewerId, input.body, input.storyId);
}

export type MessageDeliveryStatus = "sent" | "delivered" | "read";

export interface MessageWithStatus extends MessageRow {
  /** Only present on the viewer's OWN messages — spec: Sending/Failed are
   * purely client-local (never reach here at all); a message that exists
   * in the database is definitionally at least "sent". Absent entirely on
   * messages from the other participant — there's nothing to show a
   * viewer about the delivery status of a message they received. */
  status?: MessageDeliveryStatus;
}

export async function listMessages(
  viewerId: string,
  conversationId: string,
  limit: number,
  offset: number,
): Promise<MessageWithStatus[]> {
  const conversation = await requireParticipant(conversationId, viewerId);
  const otherId = otherParticipant(conversation, viewerId);

  const [rows] = await Promise.all([
    conversationsRepo.listMessages(conversationId, limit, offset),
    // Fetching messages at all is itself the real "my client received
    // this" signal (see markDelivered's own comment) — every fetch, not
    // just the first page, since even loading older history proves the
    // client is online and synced up through now.
    conversationsRepo.markDelivered(conversationId, viewerId),
  ]);

  const mine = rows.filter((m) => m.senderId === viewerId);
  if (mine.length === 0) return rows;

  const otherState = await conversationsRepo.getReadState(conversationId, otherId);
  const lastReadMs = new Date(otherState.lastReadAt).getTime();
  const lastDeliveredMs = new Date(otherState.lastDeliveredAt).getTime();

  return rows.map((m) => {
    if (m.senderId !== viewerId) return m;
    const createdAtMs = new Date(m.createdAt).getTime();
    const status: MessageDeliveryStatus =
      createdAtMs <= lastReadMs ? "read" : createdAtMs <= lastDeliveredMs ? "delivered" : "sent";
    return { ...m, status };
  });
}

export async function markConversationRead(viewerId: string, conversationId: string): Promise<void> {
  await requireParticipant(conversationId, viewerId);
  await conversationsRepo.markRead(conversationId, viewerId);
}
