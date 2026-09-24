import { ValidationError } from "../auth/dto";
import { USERNAME_RE } from "../../shared/validation";
import type { ReportReason, TargetType } from "./moderation.repository";
import type { UserRole } from "../users/users.repository";

const PROMOTABLE_ROLES: Extract<UserRole, "moderator" | "admin">[] = ["moderator", "admin"];

export interface PromoteInput {
  username: string;
  role: "moderator" | "admin";
}

export function parsePromoteInput(body: unknown): PromoteInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(username)) errors.username = "username is required.";

  const role = b.role as UserRole;
  if (!PROMOTABLE_ROLES.includes(role as "moderator" | "admin")) {
    errors.role = `role must be one of: ${PROMOTABLE_ROLES.join(", ")}.`;
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { username, role: role as "moderator" | "admin" };
}

const TARGET_TYPES: TargetType[] = ["story", "comment", "user"];
const REASONS: ReportReason[] = ["spam", "harassment", "nudity", "violence", "hate_speech", "self_harm", "other"];
const MAX_TEXT_LENGTH = 500;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function parseOptionalText(value: unknown, field: string, errors: Record<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    errors[field] = `${field} must be a string of at most ${MAX_TEXT_LENGTH} characters.`;
    return null;
  }
  return value.trim() || null;
}

export interface CreateReportInput {
  targetType: TargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
}

export function parseCreateReportInput(body: unknown): CreateReportInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const targetType = b.targetType as TargetType;
  if (!TARGET_TYPES.includes(targetType)) {
    errors.targetType = `targetType must be one of: ${TARGET_TYPES.join(", ")}.`;
  }

  const targetId = typeof b.targetId === "string" ? b.targetId : "";
  if (!UUID_RE.test(targetId)) errors.targetId = "targetId must be a valid id.";

  const reason = b.reason as ReportReason;
  if (!REASONS.includes(reason)) errors.reason = `reason must be one of: ${REASONS.join(", ")}.`;

  const details = parseOptionalText(b.details, "details", errors);

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { targetType, targetId, reason, details };
}

export type ResolveAction = "dismiss" | "remove_content" | "suspend_user";
const ACTIONS: ResolveAction[] = ["dismiss", "remove_content", "suspend_user"];

export interface ResolveReportInput {
  action: ResolveAction;
  note: string | null;
}

export function parseResolveReportInput(body: unknown): ResolveReportInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const action = b.action as ResolveAction;
  if (!ACTIONS.includes(action)) errors.action = `action must be one of: ${ACTIONS.join(", ")}.`;

  const note = parseOptionalText(b.note, "note", errors);

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { action, note };
}
