import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as socialRepo from "../social/social.repository";
import * as eventsRepo from "../recommendations/events.repository";
import * as storiesRepo from "../stories/stories.repository";
import * as storiesService from "../stories/stories.service";
import * as refreshTokensRepo from "../auth/refresh-tokens.repository";
import { verifyPassword } from "../auth/password";

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

/**
 * Real, in-app account deletion — required by both App Store review
 * (guideline 5.1.1(v): an app that supports account creation must also
 * support account deletion from inside the app) and Play Store policy,
 * not an optional nicety. Password-confirmed since it's irreversible.
 *
 * Withdraws the account's own active Stories first (soft-delete + the
 * same Highlight cleanup Phase 9 already wired into
 * moderatorDeleteStory), then the account itself, then revokes every
 * refresh token it holds — after this, login, refresh, and every lookup
 * that already filters `deleted_at IS NULL` treat this account as if it
 * never existed. What's deliberately NOT scrubbed: comments this account
 * left on *other* people's Stories, and direct-message history (a shared
 * conversation isn't only this account's to erase) — see
 * legal/PRIVACY_POLICY.md's retention section and
 * backend/README.md's own note on this for why that's a documented
 * scope decision, not an oversight.
 */
export async function deleteMyAccount(userId: string, password: string): Promise<void> {
  const current = await usersRepo.findUserById(userId);
  if (!current) throw new HttpError(404, "User not found.");

  const valid = await verifyPassword(password, current.passwordHash);
  if (!valid) throw new HttpError(401, "Incorrect password.");

  const activeStories = await storiesRepo.listActiveStoriesForOwner(userId);
  for (const story of activeStories) {
    await storiesService.moderatorDeleteStory(story.id);
  }

  await usersRepo.softDeleteUser(userId);
  await refreshTokensRepo.revokeAllRefreshTokensForUser(userId);
}
