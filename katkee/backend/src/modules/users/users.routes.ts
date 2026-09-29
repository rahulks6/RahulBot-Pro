import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import { parseDeleteAccountInput, parseUpdateProfileInput } from "./dto";
import * as profilesService from "./profiles.service";

export function registerUserRoutes(router: Router): void {
  router.get("/api/v1/users/:username", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const profile = await profilesService.getProfileByUsername(username, req.userId as string);
    sendJson(res, 200, { profile });
  });

  router.patch("/api/v1/users/me", async (req, res) => {
    requireAuth(req);
    const input = parseUpdateProfileInput(req.body);
    const user = await profilesService.updateMyProfile(req.userId as string, input);
    sendJson(res, 200, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        bio: user.bio,
        isPrivate: user.isPrivate,
        role: user.role,
        isPrimaryAdmin: user.isPrimaryAdmin,
      },
    });
  });

  router.delete("/api/v1/users/me", async (req, res) => {
    requireAuth(req);
    const { password } = parseDeleteAccountInput(req.body);
    await profilesService.deleteMyAccount(req.userId as string, password);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/users/:username/followers", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const followers = await profilesService.getFollowers(username, req.userId as string, limit, offset);
    sendJson(res, 200, { followers, limit, offset });
  });

  router.get("/api/v1/users/:username/following", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const following = await profilesService.getFollowing(username, req.userId as string, limit, offset);
    sendJson(res, 200, { following, limit, offset });
  });
}
