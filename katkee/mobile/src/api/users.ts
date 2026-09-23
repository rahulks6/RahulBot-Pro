import { apiGet, apiPatch, apiPost, apiDelete } from "./client";

/**
 * Shapes here mirror backend/src/modules/users/profiles.service.ts
 * (ProfileView) and social.service.ts — kept in lockstep by hand until a
 * shared types package exists (same caveat as api/client.ts).
 */
export interface ProfileView {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  isSelf: boolean;
  followerCount: number;
  followingCount: number;
  viewer: {
    isFollowing: boolean;
    isFollowedBy: boolean;
    hasPendingRequestFromViewer: boolean;
    hasPendingRequestFromTarget: boolean;
    isMutedByViewer: boolean;
  };
}

export interface SearchResult {
  id: string;
  username: string;
  displayName: string;
  bio: string;
}

export type FollowStatus = { status: "following" } | { status: "requested" };

export function getProfile(username: string, accessToken: string): Promise<{ profile: ProfileView }> {
  return apiGet<{ profile: ProfileView }>(`/api/v1/users/${encodeURIComponent(username)}`, accessToken);
}

export function updateMyProfile(
  input: { displayName?: string; bio?: string; isPrivate?: boolean },
  accessToken: string,
) {
  return apiPatch<{ user: unknown }>("/api/v1/users/me", input, accessToken);
}

export function searchUsers(
  query: string,
  accessToken: string,
): Promise<{ results: SearchResult[]; limit: number; offset: number }> {
  return apiGet(`/api/v1/search/users?q=${encodeURIComponent(query)}`, accessToken);
}

export function followUser(username: string, accessToken: string): Promise<FollowStatus> {
  return apiPost(`/api/v1/users/${encodeURIComponent(username)}/follow`, undefined, accessToken);
}

export function unfollowUser(username: string, accessToken: string): Promise<void> {
  return apiDelete(`/api/v1/users/${encodeURIComponent(username)}/follow`, accessToken);
}

export function blockUser(username: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/users/${encodeURIComponent(username)}/block`, undefined, accessToken);
}

export function muteUser(username: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/users/${encodeURIComponent(username)}/mute`, undefined, accessToken);
}

export interface FollowedUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  followedAt: string;
}

export interface IncomingFollowRequest {
  requestId: string;
  requesterId: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export function listFollowRequests(
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ requests: IncomingFollowRequest[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/follow-requests${qs ? `?${qs}` : ""}`, accessToken);
}

export function acceptFollowRequest(requestId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/follow-requests/${requestId}/accept`, undefined, accessToken);
}

export function declineFollowRequest(requestId: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/follow-requests/${requestId}/decline`, undefined, accessToken);
}

export function getFollowing(
  username: string,
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ following: FollowedUser[]; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiGet(`/api/v1/users/${encodeURIComponent(username)}/following${qs ? `?${qs}` : ""}`, accessToken);
}
