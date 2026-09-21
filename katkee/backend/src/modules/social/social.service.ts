import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import * as socialRepo from "./social.repository";

async function requireOtherUser(username: string, viewerId: string): Promise<usersRepo.UserRecord> {
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.id === viewerId) throw new HttpError(400, "You can't do that to your own account.");
  return target;
}

export type FollowResult = { status: "following" } | { status: "requested" };

export async function follow(viewerId: string, targetUsername: string): Promise<FollowResult> {
  const target = await requireOtherUser(targetUsername, viewerId);

  const blocked = await socialRepo.anyBlockBetween(viewerId, target.id);
  if (blocked) throw new HttpError(404, "User not found.");

  const relationship = await socialRepo.getRelationship(viewerId, target.id);
  if (relationship.isFollowing) return { status: "following" };

  if (target.isPrivate) {
    if (!relationship.hasPendingRequestFromViewer) {
      await socialRepo.createFollowRequest(viewerId, target.id);
    }
    return { status: "requested" };
  }

  await socialRepo.createFollow(viewerId, target.id);
  return { status: "following" };
}

export async function unfollow(viewerId: string, targetUsername: string): Promise<void> {
  const target = await requireOtherUser(targetUsername, viewerId);
  await socialRepo.deleteFollow(viewerId, target.id);
  await socialRepo.deletePendingFollowRequest(viewerId, target.id);
}

export async function listFollowRequests(viewerId: string, limit: number, offset: number) {
  return socialRepo.listIncomingRequests(viewerId, limit, offset);
}

async function requireOwnedPendingRequest(requestId: string, viewerId: string) {
  const request = await socialRepo.findFollowRequestById(requestId);
  if (!request || request.targetId !== viewerId) throw new HttpError(404, "Follow request not found.");
  if (request.status !== "pending") throw new HttpError(409, "This request has already been resolved.");
  return request;
}

export async function acceptFollowRequest(viewerId: string, requestId: string): Promise<void> {
  const request = await requireOwnedPendingRequest(requestId, viewerId);
  await socialRepo.createFollow(request.requesterId, request.targetId);
  await socialRepo.resolveFollowRequest(requestId, "accepted");
}

export async function declineFollowRequest(viewerId: string, requestId: string): Promise<void> {
  await requireOwnedPendingRequest(requestId, viewerId);
  await socialRepo.resolveFollowRequest(requestId, "declined");
}

export async function block(viewerId: string, targetUsername: string): Promise<void> {
  const target = await requireOtherUser(targetUsername, viewerId);
  await socialRepo.createBlock(viewerId, target.id);
  await socialRepo.deleteFollowsBothDirections(viewerId, target.id);
  await socialRepo.deletePendingFollowRequestsBothDirections(viewerId, target.id);
}

export async function unblock(viewerId: string, targetUsername: string): Promise<void> {
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) return; // nothing to unblock — idempotent
  await socialRepo.deleteBlock(viewerId, target.id);
}

export async function listBlocked(viewerId: string, limit: number, offset: number) {
  return socialRepo.listBlocked(viewerId, limit, offset);
}

export async function mute(viewerId: string, targetUsername: string): Promise<void> {
  const target = await requireOtherUser(targetUsername, viewerId);
  await socialRepo.createMute(viewerId, target.id);
}

export async function unmute(viewerId: string, targetUsername: string): Promise<void> {
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) return;
  await socialRepo.deleteMute(viewerId, target.id);
}

export async function listMuted(viewerId: string, limit: number, offset: number) {
  return socialRepo.listMuted(viewerId, limit, offset);
}
