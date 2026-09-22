import { config } from "../../config/env";
import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as mediaRepo from "../media/media.repository";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "./stories.repository";
import * as likesRepo from "./likes.repository";
import * as commentsRepo from "./comments.repository";
import type { StoryRecord } from "./stories.repository";
import type { PublishStoryInput } from "./dto";

export interface PublicStory {
  id: string;
  ownerId: string;
  mediaId: string;
  caption: string;
  audience: storiesRepo.Audience;
  allowComments: storiesRepo.CommentSetting;
  allowSharing: boolean;
  createdAt: string;
  expiresAt: string;
}

function toPublicStory(story: StoryRecord): PublicStory {
  return {
    id: story.id,
    ownerId: story.ownerId,
    mediaId: story.mediaId,
    caption: story.caption,
    audience: story.audience,
    allowComments: story.allowComments,
    allowSharing: story.allowSharing,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
  };
}

function isActive(story: StoryRecord): boolean {
  return story.deletedAt === null && new Date(story.expiresAt).getTime() > Date.now();
}

export async function publishStory(
  ownerId: string,
  input: PublishStoryInput,
  options: { ttlSecondsOverride?: number } = {},
): Promise<PublicStory> {
  const media = await mediaRepo.findMediaById(input.mediaId);
  if (!media || media.ownerId !== ownerId) {
    throw new HttpError(404, "Media not found.");
  }
  if (media.status !== "ready") {
    throw new HttpError(409, "This media isn't ready to publish yet.");
  }
  const existing = await storiesRepo.findStoryByMediaId(input.mediaId);
  if (existing) {
    throw new HttpError(409, "This media has already been published as a Story.");
  }

  const ttlSeconds = options.ttlSecondsOverride ?? config.stories.ttlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const story = await storiesRepo.createStory({
    ownerId,
    mediaId: input.mediaId,
    caption: input.caption,
    audience: input.audience,
    allowComments: input.allowComments,
    allowSharing: input.allowSharing,
    expiresAt,
  });
  return toPublicStory(story);
}

/** Owner can always fetch their own (even expired, as a foundation for Archive later) — anyone else needs an active, visible Story. */
export async function getStoryForViewer(storyId: string, viewerId: string): Promise<PublicStory> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.deletedAt !== null) throw new HttpError(404, "Story not found.");
  if (story.ownerId === viewerId) return toPublicStory(story);

  if (!isActive(story)) throw new HttpError(404, "Story not found.");

  const owner = await usersRepo.findUserById(story.ownerId);
  if (!owner) throw new HttpError(404, "Story not found.");

  const blocked = await socialRepo.anyBlockBetween(viewerId, owner.id);
  if (blocked) throw new HttpError(404, "Story not found.");

  const relationship = await socialRepo.getRelationship(viewerId, owner.id);
  const accountGatesEverything = owner.isPrivate && !relationship.isFollowing;
  if (accountGatesEverything) throw new HttpError(403, "This account is private.");
  if (story.audience === "followers" && !relationship.isFollowing) {
    throw new HttpError(403, "This Story is visible to followers only.");
  }

  return toPublicStory(story);
}

export interface StoryDetail extends PublicStory {
  likeCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
}

/**
 * The single-story fetch (what the viewer actually calls as it plays)
 * gets engagement counts; list/feed endpoints deliberately don't — see
 * this function's own extra queries vs. the plain toPublicStory() used
 * everywhere else, so listing 20 Stories doesn't fire 60 extra queries.
 */
export async function getStoryDetailForViewer(storyId: string, viewerId: string): Promise<StoryDetail> {
  const story = await getStoryForViewer(storyId, viewerId);
  const [likeCount, commentCount, viewerHasLiked] = await Promise.all([
    likesRepo.countLikes(storyId),
    commentsRepo.countComments(storyId),
    likesRepo.hasLiked(storyId, viewerId),
  ]);
  return { ...story, likeCount, commentCount, viewerHasLiked };
}

/**
 * Used by the media module to decide whether a non-owner may fetch a
 * media file that's been published as a Story — media itself stays
 * owner-only (see media.routes.ts) except through this one door, which
 * just reuses getStoryForViewer's full rule set (audience, blocks,
 * private-account gating, expiry) rather than re-implementing it.
 */
export async function canAccessMediaViaStory(mediaId: string, viewerId: string): Promise<boolean> {
  const story = await storiesRepo.findStoryByMediaId(mediaId);
  if (!story) return false;
  try {
    await getStoryForViewer(story.id, viewerId);
    return true;
  } catch {
    return false;
  }
}

export async function listMyActiveStories(ownerId: string): Promise<PublicStory[]> {
  const stories = await storiesRepo.listActiveStoriesForOwner(ownerId);
  return stories.map(toPublicStory);
}

export async function listUserActiveStories(username: string, viewerId: string): Promise<PublicStory[]> {
  const owner = await usersRepo.findUserByUsername(username);
  if (!owner) throw new HttpError(404, "User not found.");

  if (owner.id === viewerId) {
    return listMyActiveStories(owner.id);
  }

  const blocked = await socialRepo.anyBlockBetween(viewerId, owner.id);
  if (blocked) throw new HttpError(404, "User not found.");

  const relationship = await socialRepo.getRelationship(viewerId, owner.id);
  if (owner.isPrivate && !relationship.isFollowing) {
    throw new HttpError(403, "This account is private.");
  }

  const stories = await storiesRepo.listActiveStoriesForOwner(owner.id);
  const visible = stories.filter((s) => s.audience === "public" || relationship.isFollowing);
  return visible.map(toPublicStory);
}

export interface FeedEntry {
  owner: { id: string; username: string; displayName: string };
  stories: PublicStory[];
}

export async function getFollowingFeed(viewerId: string): Promise<FeedEntry[]> {
  const owners = await storiesRepo.listActiveStoryOwnersForViewer(viewerId, true);
  const entries: FeedEntry[] = [];
  for (const { ownerId } of owners) {
    const owner = await usersRepo.findUserById(ownerId);
    if (!owner) continue;
    const stories = await storiesRepo.listActiveStoriesForOwner(ownerId);
    entries.push({
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      stories: stories.map(toPublicStory),
    });
  }
  // Own Stories, if any, lead the feed — consistent with listActiveStoryOwnersForViewer's ordering intent.
  entries.sort((a, b) => (a.owner.id === viewerId ? -1 : b.owner.id === viewerId ? 1 : 0));
  return entries;
}

export async function recordView(storyId: string, viewerId: string): Promise<void> {
  const story = await getStoryForViewer(storyId, viewerId); // reuses all the same access rules
  if (story.ownerId === viewerId) return; // self-views aren't a real signal — see spec section 11
  await storiesRepo.recordView(storyId, viewerId);
}

export async function deleteStory(ownerId: string, storyId: string): Promise<void> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.ownerId !== ownerId || story.deletedAt !== null) {
    throw new HttpError(404, "Story not found.");
  }
  await storiesRepo.softDeleteStory(storyId);
}

export async function getViewCount(ownerId: string, storyId: string): Promise<number> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.ownerId !== ownerId) throw new HttpError(404, "Story not found.");
  return storiesRepo.countViews(storyId);
}
