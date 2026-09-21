import { nullable, query, queryOne, type Row } from "../../db/psql";

export interface Relationship {
  isFollowing: boolean; // viewer -> target
  isFollowedBy: boolean; // target -> viewer
  hasPendingRequestFromViewer: boolean;
  hasPendingRequestFromTarget: boolean;
  viewerBlockedTarget: boolean;
  targetBlockedViewer: boolean;
  isMutedByViewer: boolean;
}

function toBool(row: Row, key: string): boolean {
  return row[key] === "t";
}

export async function getRelationship(viewerId: string, targetId: string): Promise<Relationship> {
  if (viewerId === targetId) {
    return {
      isFollowing: false,
      isFollowedBy: false,
      hasPendingRequestFromViewer: false,
      hasPendingRequestFromTarget: false,
      viewerBlockedTarget: false,
      targetBlockedViewer: false,
      isMutedByViewer: false,
    };
  }
  const row = await queryOne(
    `SELECT
       EXISTS(SELECT 1 FROM follows WHERE follower_id = :'viewer_id' AND followee_id = :'target_id') AS is_following,
       EXISTS(SELECT 1 FROM follows WHERE follower_id = :'target_id' AND followee_id = :'viewer_id') AS is_followed_by,
       EXISTS(SELECT 1 FROM follow_requests WHERE requester_id = :'viewer_id' AND target_id = :'target_id' AND status = 'pending') AS req_from_viewer,
       EXISTS(SELECT 1 FROM follow_requests WHERE requester_id = :'target_id' AND target_id = :'viewer_id' AND status = 'pending') AS req_from_target,
       EXISTS(SELECT 1 FROM blocks WHERE blocker_id = :'viewer_id' AND blocked_id = :'target_id') AS viewer_blocked,
       EXISTS(SELECT 1 FROM blocks WHERE blocker_id = :'target_id' AND blocked_id = :'viewer_id') AS target_blocked,
       EXISTS(SELECT 1 FROM mutes WHERE muter_id = :'viewer_id' AND muted_id = :'target_id') AS is_muted`,
    { viewer_id: viewerId, target_id: targetId },
  );
  if (!row) throw new Error("Relationship query returned no row");
  return {
    isFollowing: toBool(row, "is_following"),
    isFollowedBy: toBool(row, "is_followed_by"),
    hasPendingRequestFromViewer: toBool(row, "req_from_viewer"),
    hasPendingRequestFromTarget: toBool(row, "req_from_target"),
    viewerBlockedTarget: toBool(row, "viewer_blocked"),
    targetBlockedViewer: toBool(row, "target_blocked"),
    isMutedByViewer: toBool(row, "is_muted"),
  };
}

export async function anyBlockBetween(userIdA: string, userIdB: string): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = :'a' AND blocked_id = :'b') OR (blocker_id = :'b' AND blocked_id = :'a')
     LIMIT 1`,
    { a: userIdA, b: userIdB },
  );
  return rows.length > 0;
}

export async function followCounts(userId: string): Promise<{ followers: number; following: number }> {
  const row = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM follows WHERE followee_id = :'user_id') AS followers,
       (SELECT COUNT(*) FROM follows WHERE follower_id = :'user_id') AS following`,
    { user_id: userId },
  );
  return {
    followers: Number(row?.followers ?? 0),
    following: Number(row?.following ?? 0),
  };
}

// --- follows -----------------------------------------------------------

export async function createFollow(followerId: string, followeeId: string): Promise<void> {
  await query(
    `INSERT INTO follows (follower_id, followee_id)
     VALUES (:'follower_id', :'followee_id')
     ON CONFLICT (follower_id, followee_id) DO NOTHING`,
    { follower_id: followerId, followee_id: followeeId },
  );
}

export async function deleteFollow(followerId: string, followeeId: string): Promise<void> {
  await query(`DELETE FROM follows WHERE follower_id = :'follower_id' AND followee_id = :'followee_id'`, {
    follower_id: followerId,
    followee_id: followeeId,
  });
}

export async function deleteFollowsBothDirections(userIdA: string, userIdB: string): Promise<void> {
  await query(
    `DELETE FROM follows
     WHERE (follower_id = :'a' AND followee_id = :'b') OR (follower_id = :'b' AND followee_id = :'a')`,
    { a: userIdA, b: userIdB },
  );
}

interface FollowRow {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  followedAt: string;
}

function mapFollowRow(row: Row): FollowRow {
  return {
    id: row.id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    bio: row.bio as string,
    isPrivate: row.is_private === "t",
    followedAt: row.followed_at as string,
  };
}

export async function listFollowers(userId: string, limit: number, offset: number): Promise<FollowRow[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.bio, u.is_private, f.created_at AS followed_at
     FROM follows f
     JOIN users u ON u.id = f.follower_id
     WHERE f.followee_id = :'user_id' AND u.deleted_at IS NULL
     ORDER BY f.created_at DESC, u.id DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { user_id: userId, limit, offset },
  );
  return rows.map(mapFollowRow);
}

export async function listFollowing(userId: string, limit: number, offset: number): Promise<FollowRow[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.bio, u.is_private, f.created_at AS followed_at
     FROM follows f
     JOIN users u ON u.id = f.followee_id
     WHERE f.follower_id = :'user_id' AND u.deleted_at IS NULL
     ORDER BY f.created_at DESC, u.id DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { user_id: userId, limit, offset },
  );
  return rows.map(mapFollowRow);
}

// --- follow requests -----------------------------------------------------

export interface FollowRequestRow {
  id: string;
  requesterId: string;
  targetId: string;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
}

function mapFollowRequestRow(row: Row): FollowRequestRow {
  return {
    id: row.id as string,
    requesterId: row.requester_id as string,
    targetId: row.target_id as string,
    status: row.status as "pending" | "accepted" | "declined",
    createdAt: row.created_at as string,
  };
}

export async function createFollowRequest(requesterId: string, targetId: string): Promise<void> {
  await query(
    `INSERT INTO follow_requests (requester_id, target_id)
     VALUES (:'requester_id', :'target_id')
     ON CONFLICT (requester_id, target_id) WHERE status = 'pending' DO NOTHING`,
    { requester_id: requesterId, target_id: targetId },
  );
}

export async function deletePendingFollowRequest(requesterId: string, targetId: string): Promise<void> {
  await query(
    `DELETE FROM follow_requests
     WHERE requester_id = :'requester_id' AND target_id = :'target_id' AND status = 'pending'`,
    { requester_id: requesterId, target_id: targetId },
  );
}

export async function deletePendingFollowRequestsBothDirections(userIdA: string, userIdB: string): Promise<void> {
  await query(
    `DELETE FROM follow_requests
     WHERE status = 'pending'
       AND ((requester_id = :'a' AND target_id = :'b') OR (requester_id = :'b' AND target_id = :'a'))`,
    { a: userIdA, b: userIdB },
  );
}

export async function findFollowRequestById(id: string): Promise<FollowRequestRow | null> {
  const row = await queryOne(
    `SELECT id, requester_id, target_id, status, created_at FROM follow_requests WHERE id = :'id'`,
    { id },
  );
  return row ? mapFollowRequestRow(row) : null;
}

export async function resolveFollowRequest(id: string, status: "accepted" | "declined"): Promise<void> {
  await query(`UPDATE follow_requests SET status = :'status', resolved_at = now() WHERE id = :'id'`, { id, status });
}

interface IncomingRequestRow {
  requestId: string;
  requesterId: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export async function listIncomingRequests(
  targetId: string,
  limit: number,
  offset: number,
): Promise<IncomingRequestRow[]> {
  const rows = await query(
    `SELECT fr.id AS request_id, fr.requester_id, u.username, u.display_name, fr.created_at
     FROM follow_requests fr
     JOIN users u ON u.id = fr.requester_id
     WHERE fr.target_id = :'target_id' AND fr.status = 'pending' AND u.deleted_at IS NULL
     ORDER BY fr.created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { target_id: targetId, limit, offset },
  );
  return rows.map((row) => ({
    requestId: row.request_id as string,
    requesterId: row.requester_id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    createdAt: row.created_at as string,
  }));
}

// --- blocks --------------------------------------------------------------

export async function createBlock(blockerId: string, blockedId: string): Promise<void> {
  await query(
    `INSERT INTO blocks (blocker_id, blocked_id) VALUES (:'blocker_id', :'blocked_id')
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    { blocker_id: blockerId, blocked_id: blockedId },
  );
}

export async function deleteBlock(blockerId: string, blockedId: string): Promise<void> {
  await query(`DELETE FROM blocks WHERE blocker_id = :'blocker_id' AND blocked_id = :'blocked_id'`, {
    blocker_id: blockerId,
    blocked_id: blockedId,
  });
}

interface BlockedUserRow {
  id: string;
  username: string;
  displayName: string;
  blockedAt: string;
}

export async function listBlocked(blockerId: string, limit: number, offset: number): Promise<BlockedUserRow[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, b.created_at AS blocked_at
     FROM blocks b
     JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = :'blocker_id' AND u.deleted_at IS NULL
     ORDER BY b.created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { blocker_id: blockerId, limit, offset },
  );
  return rows.map((row) => ({
    id: row.id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    blockedAt: row.blocked_at as string,
  }));
}

// --- mutes -----------------------------------------------------------------

export async function createMute(muterId: string, mutedId: string): Promise<void> {
  await query(
    `INSERT INTO mutes (muter_id, muted_id) VALUES (:'muter_id', :'muted_id')
     ON CONFLICT (muter_id, muted_id) DO NOTHING`,
    { muter_id: muterId, muted_id: mutedId },
  );
}

export async function deleteMute(muterId: string, mutedId: string): Promise<void> {
  await query(`DELETE FROM mutes WHERE muter_id = :'muter_id' AND muted_id = :'muted_id'`, {
    muter_id: muterId,
    muted_id: mutedId,
  });
}

interface MutedUserRow {
  id: string;
  username: string;
  displayName: string;
  mutedAt: string;
}

export async function listMuted(muterId: string, limit: number, offset: number): Promise<MutedUserRow[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, m.created_at AS muted_at
     FROM mutes m
     JOIN users u ON u.id = m.muted_id
     WHERE m.muter_id = :'muter_id' AND u.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { muter_id: muterId, limit, offset },
  );
  return rows.map((row) => ({
    id: row.id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    mutedAt: row.muted_at as string,
  }));
}

export { nullable };
