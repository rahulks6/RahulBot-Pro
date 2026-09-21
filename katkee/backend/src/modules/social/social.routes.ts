import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import * as socialService from "./social.service";

export function registerSocialRoutes(router: Router): void {
  router.post("/api/v1/users/:username/follow", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const result = await socialService.follow(req.userId as string, username);
    sendJson(res, 200, result);
  });

  router.delete("/api/v1/users/:username/follow", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await socialService.unfollow(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/follow-requests", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const requests = await socialService.listFollowRequests(req.userId as string, limit, offset);
    sendJson(res, 200, { requests, limit, offset });
  });

  router.post("/api/v1/follow-requests/:id/accept", async (req, res) => {
    requireAuth(req);
    await socialService.acceptFollowRequest(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/follow-requests/:id/decline", async (req, res) => {
    requireAuth(req);
    await socialService.declineFollowRequest(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/users/:username/block", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await socialService.block(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.delete("/api/v1/users/:username/block", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await socialService.unblock(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/blocks", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const blocked = await socialService.listBlocked(req.userId as string, limit, offset);
    sendJson(res, 200, { blocked, limit, offset });
  });

  router.post("/api/v1/users/:username/mute", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await socialService.mute(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.delete("/api/v1/users/:username/mute", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    await socialService.unmute(req.userId as string, username);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/mutes", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const muted = await socialService.listMuted(req.userId as string, limit, offset);
    sendJson(res, 200, { muted, limit, offset });
  });
}
