import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import type { UserRecord, UserRole } from "../users/users.repository";
import * as storiesRepo from "../stories/stories.repository";
import * as commentsRepo from "../stories/comments.repository";
import * as storiesService from "../stories/stories.service";
import * as engagementService from "../stories/engagement.service";
import * as refreshTokensRepo from "../auth/refresh-tokens.repository";
import * as moderationRepo from "./moderation.repository";
import type { ReportRow, ReportStatus, TargetType } from "./moderation.repository";
import type { CreateReportInput, ResolveReportInput, PromoteInput } from "./dto";

/** An admin can do everything a moderator can, plus grant/revoke staff access (see requireAdmin below). */
async function requireModerator(viewerId: string): Promise<void> {
  const user = await usersRepo.findUserById(viewerId);
  if (!user || (user.role !== "moderator" && user.role !== "admin")) {
    throw new HttpError(403, "Moderator access required.");
  }
}

async function requireAdmin(viewerId: string): Promise<UserRecord> {
  const user = await usersRepo.findUserById(viewerId);
  if (!user || user.role !== "admin") throw new HttpError(403, "Admin access required.");
  return user;
}

async function assertReportableAndNotSelf(reporterId: string, targetType: TargetType, targetId: string): Promise<void> {
  if (targetType === "user") {
    if (targetId === reporterId) throw new HttpError(400, "You can't report yourself.");
    const user = await usersRepo.findUserById(targetId);
    if (!user) throw new HttpError(404, "User not found.");
    return;
  }
  if (targetType === "story") {
    const story = await storiesRepo.findStoryById(targetId);
    if (!story || story.deletedAt !== null) throw new HttpError(404, "Story not found.");
    if (story.ownerId === reporterId) throw new HttpError(400, "You can't report your own Story.");
    return;
  }
  const comment = await commentsRepo.findCommentWithStoryOwner(targetId);
  if (!comment) throw new HttpError(404, "Comment not found.");
  if (comment.userId === reporterId) throw new HttpError(400, "You can't report your own comment.");
}

export async function createReport(reporterId: string, input: CreateReportInput): Promise<ReportRow> {
  await assertReportableAndNotSelf(reporterId, input.targetType, input.targetId);
  return moderationRepo.createReport({
    reporterId,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    details: input.details,
  });
}

export type ReportTarget =
  | { type: "user"; username: string; displayName: string; isActive: boolean }
  | { type: "story"; ownerUsername: string; audience: string; deleted: boolean }
  | { type: "comment"; authorUsername: string; body: string; storyId: string; deleted: boolean }
  | { type: "unknown" };

export interface ReportQueueEntry extends ReportRow {
  reporter: { username: string; displayName: string };
  target: ReportTarget;
}

async function denormalizeTarget(report: ReportRow): Promise<ReportTarget> {
  if (report.targetType === "user") {
    const user = await usersRepo.findUserById(report.targetId);
    if (!user) return { type: "unknown" };
    return { type: "user", username: user.username, displayName: user.displayName, isActive: user.isActive };
  }
  if (report.targetType === "story") {
    const story = await storiesRepo.findStoryById(report.targetId);
    if (!story) return { type: "unknown" };
    const owner = await usersRepo.findUserById(story.ownerId);
    return { type: "story", ownerUsername: owner?.username ?? "(unknown)", audience: story.audience, deleted: story.deletedAt !== null };
  }
  const comment = await commentsRepo.findCommentForModeration(report.targetId);
  if (!comment) return { type: "unknown" };
  return {
    type: "comment",
    authorUsername: comment.username,
    body: comment.body,
    storyId: comment.storyId,
    deleted: comment.deletedAt !== null,
  };
}

export async function listReportsQueue(
  moderatorId: string,
  status: ReportStatus,
  limit: number,
  offset: number,
): Promise<ReportQueueEntry[]> {
  await requireModerator(moderatorId);
  const reports = await moderationRepo.listReports(status, limit, offset);
  const entries: ReportQueueEntry[] = [];
  for (const report of reports) {
    const reporter = await usersRepo.findUserById(report.reporterId);
    const target = await denormalizeTarget(report);
    entries.push({
      ...report,
      reporter: { username: reporter?.username ?? "(unknown)", displayName: reporter?.displayName ?? "Unknown" },
      target,
    });
  }
  return entries;
}

async function suspendUser(userId: string): Promise<void> {
  const target = await usersRepo.findUserById(userId);
  // The primary admin is never suspendable through any path that reaches
  // this function — a direct suspend, or a user-report's suspend_user
  // resolution — regardless of who's asking. There is deliberately no
  // override; restoring a wrongly-suspended primary admin would need a
  // direct DB write, the same as granting primary-admin status itself.
  if (target?.isPrimaryAdmin) throw new HttpError(403, "The primary admin can't be suspended.");
  await usersRepo.setActive(userId, false);
  // Revoking every existing refresh token closes the main persistent
  // bypass: refresh() now re-checks isActive (see auth.service.ts), so a
  // suspended user can't mint a new access token even from an
  // otherwise-still-valid refresh token. A short-lived access token
  // issued just before suspension stays valid for its own TTL regardless
  // — see backend/README.md's Phase 10 section for that bounded, accepted gap.
  await refreshTokensRepo.revokeAllRefreshTokensForUser(userId);
}

export async function resolveReport(moderatorId: string, reportId: string, input: ResolveReportInput): Promise<ReportRow> {
  await requireModerator(moderatorId);
  const report = await moderationRepo.findReportById(reportId);
  if (!report) throw new HttpError(404, "Report not found.");
  if (report.status !== "pending") throw new HttpError(409, "This report has already been resolved.");

  if (input.action === "dismiss") {
    await moderationRepo.resolveReport(reportId, moderatorId, "dismissed", input.note);
  } else if (input.action === "remove_content") {
    if (report.targetType === "story") {
      await storiesService.moderatorDeleteStory(report.targetId);
    } else if (report.targetType === "comment") {
      await engagementService.moderatorDeleteComment(report.targetId);
    } else {
      throw new HttpError(400, "remove_content only applies to story or comment reports.");
    }
    await moderationRepo.resolveReport(reportId, moderatorId, "actioned", input.note);
  } else {
    // suspend_user
    if (report.targetType !== "user") {
      throw new HttpError(400, "suspend_user only applies to user reports.");
    }
    await suspendUser(report.targetId);
    await moderationRepo.resolveReport(reportId, moderatorId, "actioned", input.note);
  }

  const updated = await moderationRepo.findReportById(reportId);
  if (!updated) throw new Error("Report not found immediately after resolving it");
  return updated;
}

export async function suspendUserByUsername(moderatorId: string, username: string): Promise<void> {
  await requireModerator(moderatorId);
  const user = await usersRepo.findUserByUsername(username);
  if (!user) throw new HttpError(404, "User not found.");
  await suspendUser(user.id);
}

export async function unsuspendUserByUsername(moderatorId: string, username: string): Promise<void> {
  await requireModerator(moderatorId);
  const user = await usersRepo.findUserByUsername(username);
  if (!user) throw new HttpError(404, "User not found.");
  await usersRepo.setActive(user.id, true);
}

export interface StaffMember {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isPrimaryAdmin: boolean;
}

function toStaffMember(user: UserRecord): StaffMember {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin };
}

/** Admin-only — the roster the admin management screen lists and picks a target from. */
export async function listStaff(adminId: string): Promise<StaffMember[]> {
  await requireAdmin(adminId);
  const staff = await usersRepo.listStaff();
  return staff.map(toStaffMember);
}

/**
 * Grants moderator or admin access. Any admin can promote any other
 * account (including straight to 'admin', not just 'moderator') — the
 * spec here is "an admin can create other admins if they want to," not a
 * multi-step approval chain. The one thing no admin can ever do through
 * this path is touch is_primary_admin — that's set exactly once, out of
 * band (see scripts/seedPrimaryAdmin.ts and users.repository.ts's own
 * comment on why).
 */
export async function promoteUser(adminId: string, input: PromoteInput): Promise<StaffMember> {
  await requireAdmin(adminId);
  const target = await usersRepo.findUserByUsername(input.username);
  if (!target) throw new HttpError(404, "User not found.");
  await usersRepo.setRole(target.id, input.role);
  return toStaffMember({ ...target, role: input.role });
}

/**
 * Revokes moderator/admin access, back to a plain 'user'. The primary
 * admin can never be demoted — not by another admin, and not by
 * themselves — matching the same "can't be removed from this position"
 * rule suspendUser enforces for suspension.
 */
export async function demoteUser(adminId: string, username: string): Promise<StaffMember> {
  await requireAdmin(adminId);
  const target = await usersRepo.findUserByUsername(username);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.isPrimaryAdmin) throw new HttpError(403, "The primary admin can't be demoted.");
  await usersRepo.setRole(target.id, "user");
  return toStaffMember({ ...target, role: "user" });
}
