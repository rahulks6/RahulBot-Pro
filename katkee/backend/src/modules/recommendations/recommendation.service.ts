import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "../stories/stories.repository";
import * as likesRepo from "../stories/likes.repository";
import * as commentsRepo from "../stories/comments.repository";
import * as sharesRepo from "../stories/shares.repository";
import * as eventsRepo from "./events.repository";
import * as recommendationRepo from "./recommendation.repository";
import * as adsService from "../ads/ads.service";
import type { SponsoredSlot } from "../ads/ads.service";
import { creatorAffinity, explorationMultiplier, freshness, storyQuality } from "./scoring";
import type { StoryRecord } from "../stories/stories.repository";

export interface OrganicFeedEntry {
  kind: "organic";
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

export interface SponsoredFeedEntry {
  kind: "sponsored";
  label: "Sponsored";
  campaignId: string;
  creativeId: string;
  mediaId: string;
  headline: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

export type FeedEntry = OrganicFeedEntry | SponsoredFeedEntry;

/** @deprecated kept as an alias so any existing import of the pre-ads entry shape still resolves — see OrganicFeedEntry for the current, `kind`-tagged shape. */
export type RankedFeedEntry = OrganicFeedEntry;

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
export async function getRankedHomeFeed(viewerId: string): Promise<FeedEntry[]> {
  const [ownStories, viewer, creatorIds] = await Promise.all([
    storiesRepo.listActiveStoriesForOwner(viewerId),
    usersRepo.findUserById(viewerId),
    recommendationRepo.listEligibleCreatorIds(viewerId),
  ]);

  const entries: OrganicFeedEntry[] = [];

  // Your own active Stories always lead the feed, unscored — the
  // recommendation formula predicts whether *someone else's* content is
  // worth showing you; it has nothing meaningful to say about your own
  // (score is Infinity purely so the sort below keeps it first).
  if (ownStories.length > 0 && viewer) {
    entries.push({
      kind: "organic",
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
      kind: "organic",
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      isFollowing: relationship.isFollowing,
      stories: stories.map(toStorySummary),
      score,
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return interleaveSponsoredSlots(entries, await adsService.selectSponsoredSlots(viewerId, entries.length));
}

function toSponsoredEntry(slot: SponsoredSlot): SponsoredFeedEntry {
  return {
    kind: "sponsored",
    label: "Sponsored",
    campaignId: slot.campaignId,
    creativeId: slot.creativeId,
    mediaId: slot.mediaId,
    headline: slot.headline,
    bodyText: slot.bodyText,
    ctaLabel: slot.ctaLabel,
    ctaUrl: slot.ctaUrl,
  };
}

/**
 * The one place ads and organic ranking ever touch: this only *inserts*
 * sponsored entries at fixed spacing between already-fully-ranked organic
 * entries — it never reorders, drops, or rescoring-influences a single
 * organic entry to make room. An empty `slots` array (ads disabled,
 * unavailable, or nothing eligible) returns `organic` completely
 * untouched — "no ads = normal Home" holds exactly because this function
 * has no other effect when there's nothing to insert.
 */
function interleaveSponsoredSlots(organic: OrganicFeedEntry[], slots: SponsoredSlot[]): FeedEntry[] {
  if (slots.length === 0) return organic;
  // Synchronous placement only — getSlotSpacing's own DB read already
  // happened inside selectSponsoredSlots when it decided how many slots
  // to hand back, so this just needs *a* spacing consistent with that
  // decision, not a second read. Re-deriving it from the same settings
  // selectSponsoredSlots used keeps this function pure and side-effect-free.
  const spacing = Math.max(1, Math.floor(organic.length / (slots.length + 1)) || 1);
  const result: FeedEntry[] = [];
  let slotIndex = 0;
  for (let i = 0; i < organic.length; i++) {
    result.push(organic[i] as OrganicFeedEntry);
    const isSpacingBoundary = (i + 1) % spacing === 0;
    if (isSpacingBoundary && slotIndex < slots.length) {
      result.push(toSponsoredEntry(slots[slotIndex] as SponsoredSlot));
      slotIndex++;
    }
  }
  while (slotIndex < slots.length) {
    result.push(toSponsoredEntry(slots[slotIndex] as SponsoredSlot));
    slotIndex++;
  }
  return result;
}
