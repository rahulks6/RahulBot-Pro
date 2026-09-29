import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import type { UserRecord } from "../users/users.repository";
import * as auditRepo from "../audit/audit.repository";
import * as flagsRepo from "../feature-flags/flags.repository";
import * as permissionsRepo from "./permissions.repository";
import { PERMISSIONS, isPermission, type Permission } from "./permissions";

/**
 * Every function below this point (requirePermission, requireSuperAdmin)
 * is exclusively the entry point for the *new* Admin Console's endpoints —
 * never the legacy, role-only-gated moderation.service.ts functions
 * (requireModerator/requireAdmin) the mobile app still calls. Gating here,
 * rather than in every individual route, is what makes ADMIN_CONSOLE_ENABLED
 * actually turn the whole new console off without touching anything the
 * mobile app depends on.
 */
async function assertConsoleEnabled(): Promise<void> {
  const enabled = await flagsRepo.isEnabled("ADMIN_CONSOLE_ENABLED");
  if (!enabled) throw new HttpError(404, "The Admin Console is currently disabled.");
}

/**
 * The one function every Admin Console route (and every ads/moderation
 * route this phase adds) calls to authorize itself — server-side, on every
 * request, never trusting that the browser only *shows* the button for
 * permitted actions. A SUPER_ADMIN (is_primary_admin — see migration 0020)
 * implicitly holds every permission and is never a row in admin_permissions;
 * a plain ADMIN needs an explicit granted row for the specific permission
 * being checked. Anyone else (including the legacy 'moderator' tier, and
 * plain users) is rejected outright — the new Admin Console does not
 * recognize 'moderator' at all, only 'admin' + granular permissions.
 */
export async function requirePermission(viewerId: string, permission: Permission): Promise<UserRecord> {
  await assertConsoleEnabled();
  const user = await usersRepo.findUserById(viewerId);
  if (!user || user.role !== "admin") {
    throw new HttpError(403, "Admin access required.");
  }
  if (user.isPrimaryAdmin) return user;
  const granted = await permissionsRepo.hasPermission(user.id, permission);
  if (!granted) {
    throw new HttpError(403, `Missing required permission: ${permission}.`);
  }
  return user;
}

/** SUPER_ADMIN-only gate — admin account/permission management, ads review, audit reading by default. */
export async function requireSuperAdmin(viewerId: string): Promise<UserRecord> {
  await assertConsoleEnabled();
  const user = await usersRepo.findUserById(viewerId);
  if (!user || !user.isPrimaryAdmin) {
    throw new HttpError(403, "Super admin access required.");
  }
  return user;
}

export interface AdminWithPermissions {
  id: string;
  username: string;
  displayName: string;
  isPrimaryAdmin: boolean;
  permissions: Permission[];
}

async function toAdminWithPermissions(user: UserRecord): Promise<AdminWithPermissions> {
  const granted = user.isPrimaryAdmin ? [...PERMISSIONS] : (await permissionsRepo.listForUser(user.id)).map((g) => g.permission);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isPrimaryAdmin: user.isPrimaryAdmin,
    permissions: granted,
  };
}

/** SUPER_ADMIN-only — the roster + permission matrix the Admin Console's admin-management screen renders. */
export async function listAdminsWithPermissions(viewerId: string): Promise<AdminWithPermissions[]> {
  await requireSuperAdmin(viewerId);
  const staff = await usersRepo.listStaff();
  const admins = staff.filter((u) => u.role === "admin");
  return Promise.all(admins.map(toAdminWithPermissions));
}

export function permissionsCatalog(): readonly Permission[] {
  return PERMISSIONS;
}

/**
 * Grants one specific permission to one specific admin. SUPER_ADMIN-only —
 * an ADMIN can never grant a permission (to themselves or anyone else),
 * matching the spec's explicit "ADMIN can never... grant themselves
 * permissions" rule. The self-grant guard applies even to the SUPER_ADMIN
 * granting to their own account: they already implicitly hold every
 * permission, so there is never a legitimate reason to write a row for
 * themselves, and blocking it outright removes any need to reason about it.
 */
export async function grantPermission(actorId: string, targetUsername: string, permission: string): Promise<AdminWithPermissions> {
  const actor = await requireSuperAdmin(actorId);
  if (!isPermission(permission)) {
    throw new HttpError(422, `permission must be one of: ${PERMISSIONS.join(", ")}.`);
  }
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.role !== "admin") throw new HttpError(400, "Only an admin account can hold Admin Console permissions.");
  if (target.id === actor.id) throw new HttpError(403, "You can't modify your own permissions.");

  await permissionsRepo.grant(target.id, permission, actor.id);
  await auditRepo.record({
    actorId: actor.id,
    action: "permission.grant",
    targetType: "user",
    targetId: target.id,
    metadata: { permission, targetUsername: target.username },
  });
  return toAdminWithPermissions(target);
}

export async function revokePermission(actorId: string, targetUsername: string, permission: string): Promise<AdminWithPermissions> {
  const actor = await requireSuperAdmin(actorId);
  if (!isPermission(permission)) {
    throw new HttpError(422, `permission must be one of: ${PERMISSIONS.join(", ")}.`);
  }
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.id === actor.id) throw new HttpError(403, "You can't modify your own permissions.");

  await permissionsRepo.revoke(target.id, permission);
  await auditRepo.record({
    actorId: actor.id,
    action: "permission.revoke",
    targetType: "user",
    targetId: target.id,
    metadata: { permission, targetUsername: target.username },
  });
  return toAdminWithPermissions(target);
}

/**
 * Creates a new admin account (grants the existing 'admin' role — never
 * 'moderator', and never is_primary_admin, which no HTTP path can ever set —
 * see users.repository.ts's grantPrimaryAdmin). Gated by the 'admins.create'
 * permission rather than a blanket admin check: an ADMIN can only do this if
 * a SUPER_ADMIN explicitly granted them that permission, matching the
 * spec's "ADMIN can only do what's explicitly granted" rule. Self-targeting
 * is blocked outright — this also structurally satisfies "ADMIN can never
 * change their own role," since this is the only role-changing path this
 * module exposes.
 */
export async function createAdmin(actorId: string, targetUsername: string): Promise<AdminWithPermissions> {
  const actor = await requirePermission(actorId, "admins.create");
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.id === actor.id) throw new HttpError(403, "You can't change your own role.");
  if (target.role === "admin") throw new HttpError(409, "That user is already an admin.");

  await usersRepo.setRole(target.id, "admin");
  await auditRepo.record({
    actorId: actor.id,
    action: "admin.create",
    targetType: "user",
    targetId: target.id,
    metadata: { targetUsername: target.username },
  });
  return toAdminWithPermissions({ ...target, role: "admin" });
}

/**
 * Disables an admin account: revokes the role back to plain 'user' and
 * wipes every granted permission row (a demoted account should hold none).
 * The SUPER_ADMIN can never be disabled through this path (or any other) —
 * matching moderation.service.demoteUser's identical guard for the legacy
 * staff-management endpoint.
 */
export async function disableAdmin(actorId: string, targetUsername: string): Promise<void> {
  const actor = await requirePermission(actorId, "admins.disable");
  const target = await usersRepo.findUserByUsername(targetUsername);
  if (!target) throw new HttpError(404, "User not found.");
  if (target.id === actor.id) throw new HttpError(403, "You can't disable your own account.");
  if (target.isPrimaryAdmin) throw new HttpError(403, "The super admin can never be disabled.");

  await usersRepo.setRole(target.id, "user");
  await permissionsRepo.revokeAllForUser(target.id);
  await auditRepo.record({
    actorId: actor.id,
    action: "admin.disable",
    targetType: "user",
    targetId: target.id,
    metadata: { targetUsername: target.username },
  });
}

/** 'audit.read'-gated — the Admin Console's audit log viewer. */
export async function listAuditLog(viewerId: string, limit: number, offset: number) {
  await requirePermission(viewerId, "audit.read");
  return auditRepo.list(limit, offset);
}
