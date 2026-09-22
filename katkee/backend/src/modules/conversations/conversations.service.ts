import { HttpError } from "../../http/errors";
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

export async function listMessages(
  viewerId: string,
  conversationId: string,
  limit: number,
  offset: number,
): Promise<MessageRow[]> {
  await requireParticipant(conversationId, viewerId);
  return conversationsRepo.listMessages(conversationId, limit, offset);
}

export async function markConversationRead(viewerId: string, conversationId: string): Promise<void> {
  await requireParticipant(conversationId, viewerId);
  await conversationsRepo.markRead(conversationId, viewerId);
}
