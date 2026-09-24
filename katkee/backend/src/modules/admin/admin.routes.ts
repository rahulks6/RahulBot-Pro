import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import { HttpError } from "../../http/errors";
import { parseUsernameOnlyInput, parseGrantPermissionInput } from "./dto";
import * as permissionsService from "./permissions.service";
import * as flagsService from "../feature-flags/flags.service";

/**
 * The JSON API the Admin Console (see console.routes.ts) is a thin,
 * fetch()-driven client of — every one of these routes independently
 * re-verifies auth + role + permission itself (via permissions.service.ts),
 * exactly like every other route in this codebase; the console's HTML/JS
 * shell carries no authority of its own; hiding a button there is a UX
 * nicety only, never the actual access control.
 */
export function registerAdminRoutes(router: Router): void {
  router.get("/api/v1/admin/console/permissions/catalog", async (req, res) => {
    requireAuth(req);
    sendJson(res, 200, { permissions: permissionsService.permissionsCatalog() });
  });

  router.get("/api/v1/admin/console/admins", async (req, res) => {
    requireAuth(req);
    const admins = await permissionsService.listAdminsWithPermissions(req.userId as string);
    sendJson(res, 200, { admins });
  });

  router.post("/api/v1/admin/console/admins", async (req, res) => {
    requireAuth(req);
    const input = parseUsernameOnlyInput(req.body);
    const admin = await permissionsService.createAdmin(req.userId as string, input.username);
    sendJson(res, 201, { admin });
  });

  router.post("/api/v1/admin/console/admins/:username/disable", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await permissionsService.disableAdmin(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/admin/console/admins/:username/permissions", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const input = parseGrantPermissionInput(req.body);
    const admin = await permissionsService.grantPermission(req.userId as string, username, input.permission);
    sendJson(res, 200, { admin });
  });

  router.delete("/api/v1/admin/console/admins/:username/permissions/:permission", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const permission = req.params.permission as string;
    const admin = await permissionsService.revokePermission(req.userId as string, username, permission);
    sendJson(res, 200, { admin });
  });

  router.get("/api/v1/admin/console/audit-logs", async (req, res) => {
    requireAuth(req);
    const query = parseQueryString(req.url ?? "");
    const { limit, offset } = parsePagination(query);
    const entries = await permissionsService.listAuditLog(req.userId as string, limit, offset);
    sendJson(res, 200, { entries, limit, offset });
  });

  router.get("/api/v1/admin/console/flags", async (req, res) => {
    requireAuth(req);
    const flags = await flagsService.listFlags(req.userId as string);
    sendJson(res, 200, { flags });
  });

  router.post("/api/v1/admin/console/flags/:key", async (req, res) => {
    requireAuth(req);
    const b = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    if (typeof b.enabled !== "boolean") throw new HttpError(422, "enabled must be a boolean.");
    const flags = await flagsService.setFlag(req.userId as string, req.params.key as string, b.enabled);
    sendJson(res, 200, { flags });
  });
}
