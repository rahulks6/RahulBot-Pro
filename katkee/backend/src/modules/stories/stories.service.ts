import { config } from "../../config/env";
import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as mediaRepo from "../media/media.repository";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "./stories.repository";
import * as likesRepo from "./likes.repository";
import * as commentsRepo from "./comments.repository";
import * as highlightsRepo from "../highlights/highlights.repository";
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

/**
 * The shared access-check core. `ignoreExpiry` is the one deliberate
 * exception — set only by the Highlight-scoped variants below, and only
 * ever reached after a caller has separately confirmed the Story is
 * actually a member of a Highlight (see highlights.service.ts and
 * canAccessMediaViaStory below). Block/private-account/audience rules
 * apply identically either way — a Highlight keeps a Story visible past
 * its normal expiry, it never loosens who was allowed to see it.
 */
async function checkStoryAccess(
  storyId: string,
  viewerId: string,
  options: { ignoreExpiry?: boolean } = {},
): Promise<PublicStory> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.deletedAt !== null) throw new HttpError(404, "Story not found.");
  if (story.ownerId === viewerId) return toPublicStory(story);

  if (!options.ignoreExpiry && !isActive(story)) throw new HttpError(404, "Story not found.");

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

/** Owner can always fetch their own (even expired, as the foundation Archive/Highlights use) — anyone else needs an active, visible Story. */
export async function getStoryForViewer(storyId: string, viewerId: string): Promise<PublicStory> {
  return checkStoryAccess(storyId, viewerId);
}

/** Same rules as getStoryForViewer, minus the expiry check — for a Story a caller has already confirmed is a Highlight member (see highlights.service.ts). */
export async function getStoryForHighlightViewer(storyId: string, viewerId: string): Promise<PublicStory> {
  return checkStoryAccess(storyId, viewerId, { ignoreExpiry: true });
}

export interface StoryDetail extends PublicStory {
  likeCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
}

async function attachEngagementCounts(story: PublicStory, viewerId: string): Promise<StoryDetail> {
  const [likeCount, commentCount, viewerHasLiked] = await Promise.all([
    likesRepo.countLikes(story.id),
    commentsRepo.countComments(story.id),
    likesRepo.hasLiked(story.id, viewerId),
  ]);
  return { ...story, likeCount, commentCount, viewerHasLiked };
}

/**
 * The single-story fetch (what the viewer actually calls as it plays)
 * gets engagement counts; list/feed endpoints deliberately don't — see
 * this function's own extra queries vs. the plain toPublicStory() used
 * everywhere else, so listing 20 Stories doesn't fire 60 extra queries.
 */
export async function getStoryDetailForViewer(storyId: string, viewerId: string): Promise<StoryDetail> {
  const story = await getStoryForViewer(storyId, viewerId);
  return attachEngagementCounts(story, viewerId);
}

/** The Highlight-scoped counterpart to getStoryDetailForViewer — see getStoryForHighlightViewer. */
export async function getStoryDetailForHighlightViewer(storyId: string, viewerId: string): Promise<StoryDetail> {
  const story = await getStoryForHighlightViewer(storyId, viewerId);
  return attachEngagementCounts(story, viewerId);
}

/**
 * Used by the media module to decide whether a non-owner may fetch a
 * media file that's been published as a Story — media itself stays
 * owner-only (see media.routes.ts) except through this one door, which
 * just reuses getStoryForViewer's full rule set (audience, blocks,
 * private-account gating, expiry) rather than re-implementing it. Falls
 * back to the Highlight-scoped variant only for a Story actually confirmed
 * to be a Highlight member — that's what lets a Highlight's cover/items
 * keep rendering after the underlying Story would otherwise have expired.
 */
export async function canAccessMediaViaStory(mediaId: string, viewerId: string): Promise<boolean> {
  const story = await storiesRepo.findStoryByMediaId(mediaId);
  if (!story) return false;
  try {
    await getStoryForViewer(story.id, viewerId);
    return true;
  } catch {
    // fall through to the Highlight-scoped check below
  }
  if (!(await highlightsRepo.storyIsInAnyHighlight(story.id))) return false;
  try {
    await getStoryForHighlightViewer(story.id, viewerId);
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

async function softDeleteStoryAndCleanUp(storyId: string): Promise<void> {
  await storiesRepo.softDeleteStory(storyId);
  // "Gone even to the owner afterward" (see deleteStory's own history) has
  // to mean gone from every Highlight it was ever added to as well — a
  // Highlight that's outlived its Story's normal expiry shouldn't be the
  // one place a "deleted" Story keeps rendering.
  await highlightsRepo.removeStoryFromAllHighlights(storyId);
}

export async function deleteStory(ownerId: string, storyId: string): Promise<void> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.ownerId !== ownerId || story.deletedAt !== null) {
    throw new HttpError(404, "Story not found.");
  }
  await softDeleteStoryAndCleanUp(storyId);
}

/** Privileged: no ownership check. Only ever called from moderation.service.ts after a moderator resolves a report — see requireModerator there. */
export async function moderatorDeleteStory(storyId: string): Promise<void> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.deletedAt !== null) throw new HttpError(404, "Story not found.");
  await softDeleteStoryAndCleanUp(storyId);
}

/** Every non-deleted Story an owner has ever published — the private Archive (spec), not shown to anyone else. */
export async function listMyArchivedStories(ownerId: string, limit: number, offset: number): Promise<PublicStory[]> {
  const stories = await storiesRepo.listArchivedStoriesForOwner(ownerId, limit, offset);
  return stories.map(toPublicStory);
}

export async function getViewCount(ownerId: string, storyId: string): Promise<number> {
  const story = await storiesRepo.findStoryById(storyId);
  if (!story || story.ownerId !== ownerId) throw new HttpError(404, "Story not found.");
  return storiesRepo.countViews(storyId);
}

/**
 * A Story's owner *username* — mobile clients that only hold a storyId
 * (a DM's shared_story_id, a notification's story reference) need this to
 * deep-link into StoryViewer, which addresses creators by username, not
 * id. Reuses getStoryForViewer's full access-check rule set rather than
 * exposing owner identity to someone who couldn't otherwise see the Story.
 */
export async function getStoryOwnerUsername(storyId: string, viewerId: string): Promise<string> {
  const story = await getStoryForViewer(storyId, viewerId);
  const owner = await usersRepo.findUserById(story.ownerId);
  if (!owner) throw new HttpError(404, "Story not found.");
  return owner.username;
}
