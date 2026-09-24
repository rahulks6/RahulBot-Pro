import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { HttpError } from "../../http/errors";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import { parseCreateReportInput, parseResolveReportInput, parsePromoteInput } from "./dto";
import * as moderationService from "./moderation.service";
import type { ReportStatus, TargetType } from "./moderation.repository";

const STATUSES: ReportStatus[] = ["pending", "dismissed", "actioned"];
const CONTENT_TARGET_TYPES: TargetType[] = ["story", "comment"];

function parseContentTargetType(value: string | undefined): TargetType {
  if (value !== "story" && value !== "comment") {
    throw new HttpError(422, `type must be one of: ${CONTENT_TARGET_TYPES.join(", ")}.`);
  }
  return value;
}

function parseOptionalReason(body: unknown): string | null {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const reason = b.reason;
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string" || reason.length > 500) throw new HttpError(422, "reason must be a string of at most 500 characters.");
  return reason.trim() || null;
}

export function registerModerationRoutes(router: Router): void {
  router.post("/api/v1/reports", async (req, res) => {
    requireAuth(req);
    const input = parseCreateReportInput(req.body);
    const report = await moderationService.createReport(req.userId as string, input);
    sendJson(res, 201, { report });
  });

  router.get("/api/v1/moderation/reports", async (req, res) => {
    requireAuth(req);
    const query = parseQueryString(req.url ?? "");
    const status = (query.status ?? "pending") as ReportStatus;
    if (!STATUSES.includes(status)) {
      throw new HttpError(422, `status must be one of: ${STATUSES.join(", ")}.`);
    }
    const { limit, offset } = parsePagination(query);
    const reports = await moderationService.listReportsQueue(req.userId as string, status, limit, offset);
    sendJson(res, 200, { reports, limit, offset });
  });

  router.post("/api/v1/moderation/reports/:id/resolve", async (req, res) => {
    requireAuth(req);
    const input = parseResolveReportInput(req.body);
    const report = await moderationService.resolveReport(req.userId as string, req.params.id as string, input);
    sendJson(res, 200, { report });
  });

  router.post("/api/v1/moderation/users/:username/suspend", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await moderationService.suspendUserByUsername(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/moderation/users/:username/unsuspend", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await moderationService.unsuspendUserByUsername(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  // Admin-only (see moderation.service.ts's requireAdmin) — granting/
  // revoking moderator or admin access, and listing who currently has it.
  router.get("/api/v1/admin/staff", async (req, res) => {
    requireAuth(req);
    const staff = await moderationService.listStaff(req.userId as string);
    sendJson(res, 200, { staff });
  });

  router.post("/api/v1/admin/staff", async (req, res) => {
    requireAuth(req);
    const input = parsePromoteInput(req.body);
    const member = await moderationService.promoteUser(req.userId as string, input);
    sendJson(res, 200, { member });
  });

  router.delete("/api/v1/admin/staff/:username", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const member = await moderationService.demoteUser(req.userId as string, username);
    sendJson(res, 200, { member });
  });

  // --- New, granular-permission-gated Admin Console actions ---------------
  // (see permissions.service.ts's requirePermission) — distinct from the
  // role-only checks the routes above use, and reachable independently of
  // any underlying report.

  router.post("/api/v1/admin/console/content/:type/:id/remove", async (req, res) => {
    requireAuth(req);
    const type = parseContentTargetType(req.params.type);
    const reason = parseOptionalReason(req.body);
    await moderationService.removeContent(req.userId as string, type, req.params.id as string, reason);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/admin/console/content/:type/:id/restore", async (req, res) => {
    requireAuth(req);
    const type = parseContentTargetType(req.params.type);
    await moderationService.restoreContent(req.userId as string, type, req.params.id as string);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/admin/console/users/:username/restrict", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const reason = parseOptionalReason(req.body);
    await moderationService.restrictUserByUsername(req.userId as string, username, reason);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/admin/console/users/:username/unrestrict", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await moderationService.unrestrictUserByUsername(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/admin/console/moderation-history", async (req, res) => {
    requireAuth(req);
    const query = parseQueryString(req.url ?? "");
    const { limit, offset } = parsePagination(query);
    const targetType = query.targetType as TargetType | undefined;
    const targetId = query.targetId;
    const entries = await moderationService.listModerationHistory(req.userId as string, targetType, targetId, limit, offset);
    sendJson(res, 200, { entries, limit, offset });
  });
}
