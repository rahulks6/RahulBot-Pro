import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as storiesRepo from "../stories/stories.repository";
import * as storiesService from "../stories/stories.service";
import type { StoryDetail } from "../stories/stories.service";
import * as highlightsRepo from "./highlights.repository";
import type { HighlightWithItems } from "./highlights.repository";
import { ValidationError } from "../auth/dto";
import type { CreateHighlightInput, ReorderHighlightsInput, UpdateHighlightInput } from "./dto";

async function requireOwnedNonDeletedStories(ownerId: string, storyIds: string[]): Promise<void> {
  for (const storyId of storyIds) {
    const story = await storiesRepo.findStoryById(storyId);
    if (!story || story.ownerId !== ownerId || story.deletedAt !== null) {
      throw new HttpError(404, `Story ${storyId} not found.`);
    }
  }
}

export interface HighlightSummary {
  id: string;
  title: string;
  coverMediaId: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightDetail extends HighlightSummary {
  ownerId: string;
  items: { storyId: string; mediaId: string; position: number; addedAt: string }[];
}

/** A non-owner viewer only ever sees a Highlight's 'public' items — a followers-only Story keeps that rule inside a Highlight too, not just outside one. */
function filterVisible(highlight: HighlightWithItems, canSeeFollowersOnly: boolean): HighlightWithItems {
  if (canSeeFollowersOnly) return highlight;
  return { ...highlight, items: highlight.items.filter((item) => item.audience === "public") };
}

function toSummary(highlight: HighlightWithItems): HighlightSummary {
  return {
    id: highlight.id,
    title: highlight.title,
    coverMediaId: highlight.items[0]?.mediaId ?? null,
    itemCount: highlight.items.length,
    createdAt: highlight.createdAt,
    updatedAt: highlight.updatedAt,
  };
}

function toDetail(highlight: HighlightWithItems): HighlightDetail {
  return {
    ...toSummary(highlight),
    ownerId: highlight.ownerId,
    items: highlight.items.map((item) => ({
      storyId: item.storyId,
      mediaId: item.mediaId,
      position: item.position,
      addedAt: item.addedAt,
    })),
  };
}

export async function createHighlight(ownerId: string, input: CreateHighlightInput): Promise<HighlightDetail> {
  await requireOwnedNonDeletedStories(ownerId, input.storyIds);
  const highlight = await highlightsRepo.createHighlight(ownerId, input.title);
  await highlightsRepo.replaceHighlightItems(highlight.id, input.storyIds);
  const withItems = await highlightsRepo.getWithItems(highlight.id);
  if (!withItems) throw new Error("Highlight not found immediately after creating it");
  return toDetail(withItems);
}

async function requireOwnedHighlight(highlightId: string, ownerId: string): Promise<HighlightWithItems> {
  const highlight = await highlightsRepo.getWithItems(highlightId);
  if (!highlight || highlight.ownerId !== ownerId) throw new HttpError(404, "Highlight not found.");
  return highlight;
}

export async function updateHighlight(
  ownerId: string,
  highlightId: string,
  input: UpdateHighlightInput,
): Promise<HighlightDetail> {
  await requireOwnedHighlight(highlightId, ownerId);

  if (input.storyIds) {
    await requireOwnedNonDeletedStories(ownerId, input.storyIds);
    await highlightsRepo.replaceHighlightItems(highlightId, input.storyIds);
  }
  if (input.title) {
    await highlightsRepo.renameHighlight(highlightId, input.title);
  }

  const updated = await highlightsRepo.getWithItems(highlightId);
  if (!updated) throw new Error("Highlight not found immediately after updating it");
  return toDetail(updated);
}

export async function deleteHighlight(ownerId: string, highlightId: string): Promise<void> {
  await requireOwnedHighlight(highlightId, ownerId);
  await highlightsRepo.deleteHighlight(highlightId);
}

/**
 * The client always sends its *entire* current Highlight order (it
 * already has the full list to drag around — that's how the reorder UI
 * gets built in the first place), never a partial reshuffle — the same
 * "full replace, not a diff/patch" shape as replaceHighlightItems one
 * level down. Rejects anything that isn't exactly this owner's current
 * set: a stale client (another device edited the list in between), a
 * missing id, or someone else's Highlight id, are all real bugs to
 * surface immediately rather than silently drop or duplicate a row.
 */
export async function reorderHighlights(ownerId: string, input: ReorderHighlightsInput): Promise<HighlightSummary[]> {
  const current = await highlightsRepo.listForOwner(ownerId);
  const currentIds = new Set(current.map((h) => h.id));
  const givenIds = new Set(input.highlightIds);

  if (currentIds.size !== givenIds.size || [...currentIds].some((id) => !givenIds.has(id))) {
    throw new ValidationError({
      highlightIds: "highlightIds must contain exactly your current set of Highlights, in the new order.",
    });
  }

  await highlightsRepo.reorderHighlights(ownerId, input.highlightIds);
  const reordered = await highlightsRepo.listForOwner(ownerId);
  return reordered.map((h) => toSummary(h));
}

export async function listHighlightsForUser(username: string, viewerId: string): Promise<HighlightSummary[]> {
  const owner = await usersRepo.findUserByUsername(username);
  if (!owner) throw new HttpError(404, "User not found.");

  let canSeeFollowersOnly = owner.id === viewerId;
  if (owner.id !== viewerId) {
    const blocked = await socialRepo.anyBlockBetween(viewerId, owner.id);
    if (blocked) throw new HttpError(404, "User not found.");
    const relationship = await socialRepo.getRelationship(viewerId, owner.id);
    if (owner.isPrivate && !relationship.isFollowing) {
      throw new HttpError(403, "This account is private.");
    }
    canSeeFollowersOnly = relationship.isFollowing;
  }

  const highlights = await highlightsRepo.listForOwner(owner.id);
  return highlights.map((h) => toSummary(filterVisible(h, canSeeFollowersOnly)));
}

async function requireVisibleHighlight(
  highlightId: string,
  viewerId: string,
): Promise<{ highlight: HighlightWithItems; canSeeFollowersOnly: boolean }> {
  const highlight = await highlightsRepo.getWithItems(highlightId);
  if (!highlight) throw new HttpError(404, "Highlight not found.");
  if (highlight.ownerId === viewerId) return { highlight, canSeeFollowersOnly: true };

  const blocked = await socialRepo.anyBlockBetween(viewerId, highlight.ownerId);
  if (blocked) throw new HttpError(404, "Highlight not found.");

  const owner = await usersRepo.findUserById(highlight.ownerId);
  if (!owner) throw new HttpError(404, "Highlight not found.");
  const relationship = await socialRepo.getRelationship(viewerId, highlight.ownerId);
  if (owner.isPrivate && !relationship.isFollowing) {
    throw new HttpError(403, "This account is private.");
  }
  return { highlight, canSeeFollowersOnly: relationship.isFollowing };
}

export async function getHighlightDetail(highlightId: string, viewerId: string): Promise<HighlightDetail> {
  const { highlight, canSeeFollowersOnly } = await requireVisibleHighlight(highlightId, viewerId);
  return toDetail(filterVisible(highlight, canSeeFollowersOnly));
}

/**
 * Full story detail (engagement counts included) for one item, played
 * from inside a Highlight — the one path that's allowed to ignore a
 * Story's normal 24h expiry, and only after confirming real membership
 * here first (see stories.service.getStoryForHighlightViewer's own
 * comment on why that ordering matters).
 */
export async function getHighlightItemDetail(highlightId: string, storyId: string, viewerId: string): Promise<StoryDetail> {
  const { highlight } = await requireVisibleHighlight(highlightId, viewerId);
  const isMember = highlight.items.some((item) => item.storyId === storyId);
  if (!isMember) throw new HttpError(404, "Not found in this Highlight.");
  return storiesService.getStoryDetailForHighlightViewer(storyId, viewerId);
}
