import { ValidationError } from "../auth/dto";

export interface UpdateNotificationPreferencesInput {
  likesEnabled?: boolean;
  commentsEnabled?: boolean;
  followsEnabled?: boolean;
  mentionsEnabled?: boolean;
}

export function parseUpdateNotificationPreferencesInput(body: unknown): UpdateNotificationPreferencesInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const result: UpdateNotificationPreferencesInput = {};

  const fields: Array<[keyof UpdateNotificationPreferencesInput, string]> = [
    ["likesEnabled", "likesEnabled"],
    ["commentsEnabled", "commentsEnabled"],
    ["followsEnabled", "followsEnabled"],
    ["mentionsEnabled", "mentionsEnabled"],
  ];

  for (const [key, bodyKey] of fields) {
    const value = b[bodyKey];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      errors[bodyKey] = `${bodyKey} must be a boolean.`;
    } else {
      result[key] = value;
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return result;
}
