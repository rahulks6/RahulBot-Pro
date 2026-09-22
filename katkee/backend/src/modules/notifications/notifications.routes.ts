import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import * as notificationsService from "./notifications.service";

export function registerNotificationsRoutes(router: Router): void {
  router.get("/api/v1/notifications", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const notifications = await notificationsService.listNotifications(req.userId as string, limit, offset);
    sendJson(res, 200, { notifications, limit, offset });
  });

  router.get("/api/v1/notifications/unread-count", async (req, res) => {
    requireAuth(req);
    const count = await notificationsService.getUnreadCount(req.userId as string);
    sendJson(res, 200, { count });
  });

  router.post("/api/v1/notifications/read-all", async (req, res) => {
    requireAuth(req);
    await notificationsService.markAllRead(req.userId as string);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/notifications/:id/read", async (req, res) => {
    requireAuth(req);
    await notificationsService.markRead(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });
}
