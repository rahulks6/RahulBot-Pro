import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "../stories/stories.repository";
import * as likesRepo from "../stories/likes.repository";
import * as commentsRepo from "../stories/comments.repository";
import * as sharesRepo from "../stories/shares.repository";
import * as eventsRepo from "./events.repository";
import * as recommendationRepo from "./recommendation.repository";
import { creatorAffinity, explorationMultiplier, freshness, storyQuality } from "./scoring";
import type { StoryRecord } from "../stories/stories.repository";

export interface RankedFeedEntry {
  owner: { id: string; username: string; displayName: string };
  isFollowing: boolean;
  stories: Array<{
    id: string;
    mediaId: string;
    caption: string;
    audience: storiesRepo.Audience;
    createdAt: string;
    expiresAt: string;
  }>;
  score: number;
}

function toStorySummary(story: StoryRecord) {
  return {
    id: story.id,
    mediaId: story.mediaId,
    caption: story.caption,
    audience: story.audience,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
  };
}

async function scoreCreator(viewerId: string, creatorId: string, stories: StoryRecord[], isFollowing: boolean): Promise<number> {
  const mostRecent = stories.reduce((latest, s) => (s.createdAt > latest.createdAt ? s : latest), stories[0] as StoryRecord);

  let likeCount = 0;
  let commentCount = 0;
  let shareCount = 0;
  let viewCount = 0;
  for (const story of stories) {
    const [likes, comments, shares, views] = await Promise.all([
      likesRepo.countLikes(story.id),
      commentsRepo.countComments(story.id),
      sharesRepo.countShares(story.id),
      storiesRepo.countViews(story.id),
    ]);
    likeCount += likes;
    commentCount += comments;
    shareCount += shares;
    viewCount += views;
  }
  const quality = storyQuality({ likeCount, commentCount, shareCount, viewCount });
  const fresh = freshness(new Date(mostRecent.createdAt), new Date(mostRecent.expiresAt));

  const [profileVisits, meaningfulReplies, distinctDays, qualifiedViews, completions, sequenceContinues, impressions, lifetimeImpressions] =
    await Promise.all([
      eventsRepo.countViewerEventsForCreator(viewerId, creatorId, "profile_visit"),
      commentsRepo.countCommentsByUserOnCreator(viewerId, creatorId),
      eventsRepo.distinctEngagementDays(viewerId, creatorId),
      eventsRepo.countViewerEventsForCreator(viewerId, creatorId, "qualified_view"),
      eventsRepo.countViewerEventsForCreator(viewerId, creatorId, "story_complete"),
      eventsRepo.countViewerEventsForCreator(viewerId, creatorId, "creator_sequence_continued"),
      eventsRepo.countViewerEventsForCreator(viewerId, creatorId, "creator_impression"),
      eventsRepo.lifetimeImpressionCount(creatorId),
    ]);

  const affinity = creatorAffinity({
    isFollowing,
    profileVisits,
    meaningfulReplies,
    distinctEngagementDays: distinctDays,
    qualifiedViews,
    storyCompletions: completions,
    sequenceContinuations: sequenceContinues,
    impressions,
  });

  const exploration = explorationMultiplier(lifetimeImpressions);

  return quality * affinity * fresh * exploration;
}

/**
 * Phase 6's Home feed: followed creators plus genuine discovery of public
 * creators you don't yet follow, all real-eligibility-filtered (active
 * Story, not blocked/muted/not-interested, private accounts only if
 * followed), scored, and ranked. This is the heuristic described in spec
 * sections 7-11 — see scoring.ts's own docstring for why it's not (and
 * can't yet be) a trained model.
 */
export async function getRankedHomeFeed(viewerId: string): Promise<RankedFeedEntry[]> {
  const [ownStories, viewer, creatorIds] = await Promise.all([
    storiesRepo.listActiveStoriesForOwner(viewerId),
    usersRepo.findUserById(viewerId),
    recommendationRepo.listEligibleCreatorIds(viewerId),
  ]);

  const entries: RankedFeedEntry[] = [];

  // Your own active Stories always lead the feed, unscored — the
  // recommendation formula predicts whether *someone else's* content is
  // worth showing you; it has nothing meaningful to say about your own
  // (score is Infinity purely so the sort below keeps it first).
  if (ownStories.length > 0 && viewer) {
    entries.push({
      owner: { id: viewer.id, username: viewer.username, displayName: viewer.displayName },
      isFollowing: false,
      stories: ownStories.map(toStorySummary),
      score: Infinity,
    });
  }

  for (const creatorId of creatorIds) {
    const [owner, stories, relationship] = await Promise.all([
      usersRepo.findUserById(creatorId),
      storiesRepo.listActiveStoriesForOwner(creatorId),
      socialRepo.getRelationship(viewerId, creatorId),
    ]);
    if (!owner || stories.length === 0) continue;

    const score = await scoreCreator(viewerId, creatorId, stories, relationship.isFollowing);
    entries.push({
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      isFollowing: relationship.isFollowing,
      stories: stories.map(toStorySummary),
      score,
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries;
}
