import { API_BASE_URL, apiDelete, apiGet, apiPost } from "./client";

/** Mirrors backend/src/modules/stories/stories.service.ts's PublicStory — kept in lockstep by hand, same as the rest of src/api/. */
export interface PublicStory {
  id: string;
  ownerId: string;
  mediaId: string;
  caption: string;
  audience: "public" | "followers";
  allowComments: "everyone" | "followers" | "disabled";
  allowSharing: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface FeedEntry {
  owner: { id: string; username: string; displayName: string };
  stories: PublicStory[];
}

export interface PublishStoryInput {
  mediaId: string;
  caption?: string;
  audience?: "public" | "followers";
  allowComments?: "everyone" | "followers" | "disabled";
  allowSharing?: boolean;
}

export function publishStory(input: PublishStoryInput, accessToken: string): Promise<{ story: PublicStory }> {
  return apiPost("/api/v1/stories", input, accessToken);
}

export function getFollowingFeed(accessToken: string): Promise<{ feed: FeedEntry[] }> {
  return apiGet("/api/v1/stories/feed/following", accessToken);
}

export function getMyActiveStories(accessToken: string): Promise<{ stories: PublicStory[] }> {
  return apiGet("/api/v1/stories/mine/active", accessToken);
}

export function getUserActiveStories(username: string, accessToken: string): Promise<{ stories: PublicStory[] }> {
  return apiGet(`/api/v1/users/${encodeURIComponent(username)}/stories`, accessToken);
}

export function recordStoryView(storyId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/stories/${storyId}/view`, undefined, accessToken);
}

export function deleteStory(storyId: string, accessToken: string): Promise<void> {
  return apiDelete(`/api/v1/stories/${storyId}`, accessToken);
}

export function getViewCount(storyId: string, accessToken: string): Promise<{ views: number }> {
  return apiGet(`/api/v1/stories/${storyId}/views`, accessToken);
}

export function mediaFileUrl(mediaId: string): string {
  // Consumed with an Authorization header by the viewer (Image/Video source supports a `headers` field).
  return `${API_BASE_URL}/api/v1/media/${mediaId}/file`;
}
