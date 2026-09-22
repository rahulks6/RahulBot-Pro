import { apiGet, apiPost } from "./client";

/**
 * Mirrors backend/src/modules/conversations/conversations.repository.ts —
 * see the note atop client.ts about keeping these in lockstep by hand
 * until there's a shared types package.
 */
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

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  sharedStoryId: string | null;
  createdAt: string;
}

export interface ConversationWithOtherUser {
  id: string;
  createdAt: string;
  otherUser: { id: string; username: string; displayName: string };
}

export function openConversation(username: string, accessToken: string): Promise<{ conversation: ConversationWithOtherUser }> {
  return apiPost(`/api/v1/users/${username}/conversation`, undefined, accessToken);
}

export function listConversations(
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ conversations: ConversationSummary[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/conversations${qs ? `?${qs}` : ""}`, accessToken);
}

export function getUnreadConversationCount(accessToken: string): Promise<{ count: number }> {
  return apiGet("/api/v1/conversations/unread-count", accessToken);
}

export function listMessages(
  conversationId: string,
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ messages: Message[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`, accessToken);
}

export function sendMessage(
  conversationId: string,
  input: { body?: string; storyId?: string },
  accessToken: string,
): Promise<{ message: Message }> {
  return apiPost(`/api/v1/conversations/${conversationId}/messages`, input, accessToken);
}

export function markConversationRead(conversationId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/conversations/${conversationId}/read`, undefined, accessToken);
}
