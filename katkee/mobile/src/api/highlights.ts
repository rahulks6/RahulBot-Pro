import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { StoryDetail } from "./engagement";

/**
 * Mirrors backend/src/modules/highlights/highlights.service.ts — kept in
 * lockstep by hand, same as the rest of src/api/.
 */
export interface HighlightSummary {
  id: string;
  title: string;
  coverMediaId: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightItem {
  storyId: string;
  mediaId: string;
  position: number;
  addedAt: string;
}

export interface HighlightDetail extends HighlightSummary {
  ownerId: string;
  items: HighlightItem[];
}

export function createHighlight(
  input: { title: string; storyIds: string[] },
  accessToken: string,
): Promise<{ highlight: HighlightDetail }> {
  return apiPost("/api/v1/highlights", input, accessToken);
}

export function listHighlightsForUser(username: string, accessToken: string): Promise<{ highlights: HighlightSummary[] }> {
  return apiGet(`/api/v1/users/${encodeURIComponent(username)}/highlights`, accessToken);
}

export function getHighlightDetail(highlightId: string, accessToken: string): Promise<{ highlight: HighlightDetail }> {
  return apiGet(`/api/v1/highlights/${highlightId}`, accessToken);
}

export function updateHighlight(
  highlightId: string,
  input: { title?: string; storyIds?: string[] },
  accessToken: string,
): Promise<{ highlight: HighlightDetail }> {
  return apiPatch(`/api/v1/highlights/${highlightId}`, input, accessToken);
}

export function deleteHighlight(highlightId: string, accessToken: string): Promise<void> {
  return apiDelete(`/api/v1/highlights/${highlightId}`, accessToken);
}

/** Bypasses a Story's normal 24h expiry — only valid for a Story that's actually a member of this Highlight. */
export function getHighlightItemDetail(
  highlightId: string,
  storyId: string,
  accessToken: string,
): Promise<{ story: StoryDetail }> {
  return apiGet(`/api/v1/highlights/${highlightId}/items/${storyId}`, accessToken);
}
