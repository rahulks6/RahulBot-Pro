import { apiDelete, apiGet, apiPost } from "./client";

export interface StoryDetail {
  id: string;
  ownerId: string;
  mediaId: string;
  caption: string;
  audience: "public" | "followers";
  allowComments: "everyone" | "followers" | "disabled";
  allowSharing: boolean;
  createdAt: string;
  expiresAt: string;
  likeCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
}

export interface Comment {
  id: string;
  storyId: string;
  userId: string;
  username: string;
  displayName: string;
  body: string;
  createdAt: string;
}

export function getStoryDetail(storyId: string, accessToken: string): Promise<{ story: StoryDetail }> {
  return apiGet(`/api/v1/stories/${storyId}`, accessToken);
}

export function likeStory(storyId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/stories/${storyId}/like`, undefined, accessToken);
}

export function unlikeStory(storyId: string, accessToken: string): Promise<void> {
  return apiDelete(`/api/v1/stories/${storyId}/like`, accessToken);
}

export function listComments(
  storyId: string,
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ comments: Comment[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/stories/${storyId}/comments${qs ? `?${qs}` : ""}`, accessToken);
}

export function postComment(storyId: string, body: string, accessToken: string): Promise<{ comment: Comment }> {
  return apiPost(`/api/v1/stories/${storyId}/comments`, { body }, accessToken);
}

export function deleteComment(commentId: string, accessToken: string): Promise<void> {
  return apiDelete(`/api/v1/comments/${commentId}`, accessToken);
}

export function shareStory(storyId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/stories/${storyId}/share`, undefined, accessToken);
}
