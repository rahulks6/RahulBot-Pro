/**
 * The closed set of granular Admin Console permissions (migration 0021).
 * These gate the *new* Admin Console surfaces this module and the
 * moderation/ads modules add. They deliberately do not replace or gate the
 * existing, simpler role-only checks in moderation.service.ts
 * (requireModerator/requireAdmin) — those keep working exactly as they do
 * today for the existing mobile-embedded moderation queue, unchanged.
 */
export const PERMISSIONS = [
  "reports.read",
  "reports.review",
  "content.remove",
  "content.restore",
  "users.view",
  "users.restrict",
  "users.suspend",
  "moderation.history.read",
  "ads.create",
  "ads.edit",
  "ads.review",
  "ads.pause",
  "ads.analytics.read",
  "admins.read",
  "admins.create",
  "admins.update",
  "admins.disable",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}
