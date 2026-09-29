import { apiGet, apiPatch, apiPost } from "./client";

/**
 * Mirrors backend/src/modules/notifications/notifications.repository.ts's
 * NotificationRecord — see the note atop client.ts about keeping these in
 * lockstep by hand until there's a shared types package.
 */
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

export function listNotifications(
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ notifications: NotificationRecord[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/notifications${qs ? `?${qs}` : ""}`, accessToken);
}

export function getUnreadNotificationCount(accessToken: string): Promise<{ count: number }> {
  return apiGet("/api/v1/notifications/unread-count", accessToken);
}

export function markNotificationRead(id: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/notifications/${id}/read`, undefined, accessToken);
}

export function markAllNotificationsRead(accessToken: string): Promise<void> {
  return apiPost("/api/v1/notifications/read-all", undefined, accessToken);
}

export interface NotificationPreferences {
  likesEnabled: boolean;
  commentsEnabled: boolean;
  followsEnabled: boolean;
  mentionsEnabled: boolean;
}

export function getNotificationPreferences(accessToken: string): Promise<{ preferences: NotificationPreferences }> {
  return apiGet("/api/v1/notifications/preferences", accessToken);
}

export function updateNotificationPreferences(
  input: Partial<NotificationPreferences>,
  accessToken: string,
): Promise<{ preferences: NotificationPreferences }> {
  return apiPatch("/api/v1/notifications/preferences", input, accessToken);
}
