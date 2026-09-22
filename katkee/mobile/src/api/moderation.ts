import { apiPost } from "./client";

/** Mirrors backend/src/modules/moderation/moderation.repository.ts — kept in lockstep by hand, same as the rest of src/api/. */
export type ReportTargetType = "story" | "comment" | "user";
export type ReportReason = "spam" | "harassment" | "nudity" | "violence" | "hate_speech" | "self_harm" | "other";

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
