import { apiDelete, apiGet, apiPost } from "./client";
import type { UserRole } from "./client";

/**
 * Mirrors backend/src/modules/moderation/{moderation.repository,moderation.service}.ts
 * — see the note atop client.ts about keeping these in lockstep by hand.
 * Moderator-and-up only (see ModerationQueueScreen.tsx); admin-only calls
 * are the staff-management functions further down.
 */
export type ReportStatus = "pending" | "dismissed" | "actioned";
export type ReportReason = "spam" | "harassment" | "nudity" | "violence" | "hate_speech" | "self_harm" | "other";
export type ReportTargetType = "story" | "comment" | "user";

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "nudity", label: "Nudity or sexual content" },
  { value: "violence", label: "Violence" },
  { value: "hate_speech", label: "Hate speech" },
  { value: "self_harm", label: "Self-harm" },
  { value: "other", label: "Something else" },
];

export function createReport(
  input: { targetType: ReportTargetType; targetId: string; reason: ReportReason; details?: string },
  accessToken: string,
): Promise<void> {
  return apiPost("/api/v1/reports", input, accessToken);
}

export type ReportTarget =
  | { type: "user"; username: string; displayName: string; isActive: boolean }
  | { type: "story"; ownerUsername: string; audience: string; deleted: boolean }
  | { type: "comment"; authorUsername: string; body: string; storyId: string; deleted: boolean }
  | { type: "unknown" };

export interface ReportQueueEntry {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolutionNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  reporter: { username: string; displayName: string };
  target: ReportTarget;
}

export function listReportsQueue(
  status: ReportStatus,
  accessToken: string,
  params: { limit?: number; offset?: number } = {},
): Promise<{ reports: ReportQueueEntry[]; limit: number; offset: number }> {
  const query = new URLSearchParams({ status });
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  return apiGet(`/api/v1/moderation/reports?${query.toString()}`, accessToken);
}

export type ResolveAction = "dismiss" | "remove_content" | "suspend_user";

export function resolveReport(
  reportId: string,
  input: { action: ResolveAction; note?: string },
  accessToken: string,
): Promise<{ report: ReportQueueEntry }> {
  return apiPost(`/api/v1/moderation/reports/${reportId}/resolve`, input, accessToken);
}

export function suspendUserByUsername(username: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/moderation/users/${encodeURIComponent(username)}/suspend`, undefined, accessToken);
}

export function unsuspendUserByUsername(username: string, accessToken: string): Promise<void> {
  return apiPost(`/api/v1/moderation/users/${encodeURIComponent(username)}/unsuspend`, undefined, accessToken);
}

// --- admin-only staff management -----------------------------------------

export interface StaffMember {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isPrimaryAdmin: boolean;
}

export function listStaff(accessToken: string): Promise<{ staff: StaffMember[] }> {
  return apiGet("/api/v1/admin/staff", accessToken);
}

/** Any admin can grant either tier — see backend/README.md's "an admin can create other admins if they want" design. */
export function promoteToStaff(
  username: string,
  role: "moderator" | "admin",
  accessToken: string,
): Promise<{ member: StaffMember }> {
  return apiPost("/api/v1/admin/staff", { username, role }, accessToken);
}

/** 403s if the target is the primary admin — see moderation.service.ts's demoteUser. */
export function demoteFromStaff(username: string, accessToken: string): Promise<{ member: StaffMember }> {
  return apiDelete(`/api/v1/admin/staff/${encodeURIComponent(username)}`, accessToken);
}
