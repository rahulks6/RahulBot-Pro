import { HttpError } from "../../http/errors";
import { assertNotRestricted } from "../../shared/accountStatus";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "./stories.repository";
import * as likesRepo from "./likes.repository";
import * as commentsRepo from "./comments.repository";
import * as sharesRepo from "./shares.repository";
import * as notificationsService from "../notifications/notifications.service";
import type { CommentRecord } from "./comments.repository";
import { getStoryForViewer } from "./stories.service";

export async function likeStory(viewerId: string, storyId: string): Promise<void> {
  const story = await getStoryForViewer(storyId, viewerId); // access check — reused, not re-implemented
  const isNewLike = await likesRepo.likeStory(storyId, viewerId);
  if (isNewLike) {
    await notificationsService.notifyLike(viewerId, story.ownerId, storyId);
  }
}

export async function unlikeStory(viewerId: string, storyId: string): Promise<void> {
  await getStoryForViewer(storyId, viewerId);
  await likesRepo.unlikeStory(storyId, viewerId);
}

async function assertCanComment(storyId: string, viewerId: string): Promise<storiesRepo.StoryRecord> {
  await getStoryForViewer(storyId, viewerId); // must be able to view it at all
  const story = await storiesRepo.findStoryById(storyId);
  if (!story) throw new HttpError(404, "Story not found.");

  if (story.ownerId === viewerId) return story; // owners can always comment on their own Story

  if (story.allowComments === "disabled") {
    throw new HttpError(403, "Comments are disabled on this Story.");
  }
  if (story.allowComments === "followers") {
    const relationship = await socialRepo.getRelationship(viewerId, story.ownerId);
    if (!relationship.isFollowing) {
      throw new HttpError(403, "Only followers can comment on this Story.");
    }
  }
  return story;
}

export async function createComment(viewerId: string, storyId: string, body: string): Promise<CommentRecord> {
  await assertNotRestricted(viewerId, "post a comment");
  const story = await assertCanComment(storyId, viewerId);
  const comment = await commentsRepo.createComment(storyId, viewerId, body);
  await notificationsService.notifyComment(viewerId, story.ownerId, storyId, comment.id);
  await notificationsService.notifyMentions(viewerId, storyId, comment.id, body);
  return comment;
}

export async function listComments(
  viewerId: string,
  storyId: string,
  limit: number,
  offset: number,
): Promise<CommentRecord[]> {
  await getStoryForViewer(storyId, viewerId); // reading comments only needs Story view access, not comment-post permission
  return commentsRepo.listComments(storyId, limit, offset);
}

export async function deleteComment(viewerId: string, commentId: string): Promise<void> {
  const comment = await commentsRepo.findCommentWithStoryOwner(commentId);
  if (!comment) throw new HttpError(404, "Comment not found.");
  if (comment.userId !== viewerId && comment.storyOwnerId !== viewerId) {
    throw new HttpError(403, "You can only delete your own comments, or comments on your own Story.");
  }
  await commentsRepo.softDeleteComment(commentId);
}

/** Privileged: no ownership check. See stories.service.ts's moderatorDeleteStory for why this takes moderatorId/reason and writes moderation_status. */
export async function moderatorDeleteComment(commentId: string, moderatorId: string, reason: string | null = null): Promise<void> {
  const comment = await commentsRepo.findCommentWithStoryOwner(commentId);
  if (!comment) throw new HttpError(404, "Comment not found.");
  await commentsRepo.moderateRemove(commentId, moderatorId, reason);
}

/** The undo side of moderatorDeleteComment. */
export async function moderatorRestoreComment(commentId: string): Promise<void> {
  const restored = await commentsRepo.moderateRestore(commentId);
  if (!restored) throw new HttpError(409, "This comment wasn't removed by moderation, or has already been restored.");
}

export async function shareStory(viewerId: string, storyId: string): Promise<void> {
  await getStoryForViewer(storyId, viewerId);
  const story = await storiesRepo.findStoryById(storyId);
  if (!story) throw new HttpError(404, "Story not found.");
  if (!story.allowSharing) {
    throw new HttpError(403, "Sharing is disabled on this Story.");
  }
  await sharesRepo.recordShare(storyId, viewerId);
}
