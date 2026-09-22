import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as eventsRepo from "../recommendations/events.repository";

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

export async function getProfileByUsername(username: string, viewerId: string): Promise<ProfileView> {
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");

  if (target.id !== viewerId) {
    const blocked = await socialRepo.anyBlockBetween(viewerId, target.id);
    if (blocked) throw new HttpError(404, "User not found.");
    // Real profile_visit signal for recommendation scoring (spec section
    // 7/12) — emitted here, server-side, rather than trusted from the
    // client, since this is exactly where a genuine profile view happens.
    await eventsRepo.insertEvent({ viewerId, eventType: "profile_visit", creatorId: target.id });
  }

  const [relationship, counts] = await Promise.all([
    socialRepo.getRelationship(viewerId, target.id),
    socialRepo.followCounts(target.id),
  ]);

  return {
    id: target.id,
    username: target.username,
    displayName: target.displayName,
    bio: target.bio,
    isPrivate: target.isPrivate,
    isSelf: target.id === viewerId,
    followerCount: counts.followers,
    followingCount: counts.following,
    viewer: {
      isFollowing: relationship.isFollowing,
      isFollowedBy: relationship.isFollowedBy,
      hasPendingRequestFromViewer: relationship.hasPendingRequestFromViewer,
      hasPendingRequestFromTarget: relationship.hasPendingRequestFromTarget,
      isMutedByViewer: relationship.isMutedByViewer,
    },
  };
}

/** Followers/following lists are gated the same way a private account's Stories will be: owner, or an accepted follower. */
async function assertCanViewConnections(target: usersRepo.UserRecord, viewerId: string): Promise<void> {
  if (target.id === viewerId) return;
  const blocked = await socialRepo.anyBlockBetween(viewerId, target.id);
  if (blocked) throw new HttpError(404, "User not found.");
  if (!target.isPrivate) return;
  const relationship = await socialRepo.getRelationship(viewerId, target.id);
  if (!relationship.isFollowing) {
    throw new HttpError(403, "This account is private.");
  }
}

export async function getFollowers(username: string, viewerId: string, limit: number, offset: number) {
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");
  await assertCanViewConnections(target, viewerId);
  return socialRepo.listFollowers(target.id, limit, offset);
}

export async function getFollowing(username: string, viewerId: string, limit: number, offset: number) {
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");
  await assertCanViewConnections(target, viewerId);
  return socialRepo.listFollowing(target.id, limit, offset);
}

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
  isPrivate?: boolean;
}

export async function updateMyProfile(userId: string, input: UpdateProfileInput): Promise<usersRepo.UserRecord> {
  const current = await usersRepo.findUserById(userId);
  if (!current) throw new HttpError(404, "User not found.");
  return usersRepo.setProfile(userId, {
    displayName: input.displayName ?? current.displayName,
    bio: input.bio ?? current.bio,
    isPrivate: input.isPrivate ?? current.isPrivate,
  });
}
