import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as notificationsRepo from "./notifications.repository";
import type { NotificationRecord, NotificationPreferences } from "./notifications.repository";
import type { UpdateNotificationPreferencesInput } from "./dto";

export async function listNotifications(recipientId: string, limit: number, offset: number): Promise<NotificationRecord[]> {
  return notificationsRepo.listForRecipient(recipientId, limit, offset);
}

export async function getUnreadCount(recipientId: string): Promise<number> {
  return notificationsRepo.countUnread(recipientId);
}

export async function markRead(recipientId: string, notificationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(notificationId)) throw new HttpError(404, "Notification not found.");
  await notificationsRepo.markRead(notificationId, recipientId);
}

export async function markAllRead(recipientId: string): Promise<void> {
  await notificationsRepo.markAllRead(recipientId);
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  return notificationsRepo.getPreferences(userId);
}

export async function updateNotificationPreferences(
  userId: string,
  input: UpdateNotificationPreferencesInput,
): Promise<NotificationPreferences> {
  return notificationsRepo.upsertPreferences(userId, input);
}

export async function notifyLike(actorId: string, storyOwnerId: string, storyId: string): Promise<void> {
  await notificationsRepo.createNotification({ recipientId: storyOwnerId, actorId, type: "like", storyId });
}

export async function notifyComment(actorId: string, storyOwnerId: string, storyId: string, commentId: string): Promise<void> {
  await notificationsRepo.createNotification({ recipientId: storyOwnerId, actorId, type: "comment", storyId, commentId });
}

export async function notifyFollow(actorId: string, followeeId: string): Promise<void> {
  await notificationsRepo.createNotification({ recipientId: followeeId, actorId, type: "follow" });
}

export async function notifyFollowRequest(actorId: string, targetId: string, followRequestId: string): Promise<void> {
  await notificationsRepo.createNotification({ recipientId: targetId, actorId, type: "follow_request", followRequestId });
}

const MENTION_RE = /@([a-z0-9_.]{3,30})/gi;
const MAX_MENTIONS_PER_COMMENT = 10;

/**
 * Real @username detection in comment text (not the Story-editor mention
 * sticker from spec section 24, which is out of scope — see
 * backend/README.md). Each resolved, distinct, non-self user mentioned
 * gets a real 'mention' notification; unknown usernames are silently
 * ignored rather than erroring, the same way a typo in a real app's
 * mention just doesn't link to anyone.
 */
export async function notifyMentions(actorId: string, storyId: string, commentId: string, commentBody: string): Promise<void> {
  const usernames = new Set<string>();
  for (const match of commentBody.matchAll(MENTION_RE)) {
    const username = match[1]?.toLowerCase();
    if (username) usernames.add(username);
    if (usernames.size >= MAX_MENTIONS_PER_COMMENT) break;
  }
  if (usernames.size === 0) return;

  for (const username of usernames) {
    const user = await usersRepo.findUserByUsername(username);
    if (!user || user.id === actorId) continue;
    await notificationsRepo.createNotification({
      recipientId: user.id,
      actorId,
      type: "mention",
      storyId,
      commentId,
    });
  }
}
