import type { KatkeeRequest, Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { HttpError } from "../../http/errors";
import { sendJson } from "../../http/respond";
import { authRateLimiter } from "../../http/rateLimiters";
import { clientIp } from "../../http/rateLimiter";
import { parseLoginInput, parseRefreshInput, parseSignupInput } from "./dto";
import * as authService from "./auth.service";

export function registerAuthRoutes(router: Router): void {
  router.post("/api/v1/auth/signup", async (req, res) => {
    authRateLimiter.check(clientIp(req));
    const input = parseSignupInput(req.body);
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const result = await authService.signup(input, userAgent);
    sendJson(res, 201, result);
  });

  router.post("/api/v1/auth/login", async (req, res) => {
    // The same limiter/bucket as signup — an attacker guessing passwords
    // and an attacker mass-creating accounts are the same shape of abuse
    // against this endpoint family, so they share one budget per IP.
    authRateLimiter.check(clientIp(req));
    const input = parseLoginInput(req.body);
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const result = await authService.login(input, userAgent);
    sendJson(res, 200, result);
  });

  router.post("/api/v1/auth/refresh", async (req, res) => {
    authRateLimiter.check(clientIp(req));
    const input = parseRefreshInput(req.body);
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const tokens = await authService.refresh(input.refreshToken, userAgent);
    sendJson(res, 200, { tokens });
  });

  router.post("/api/v1/auth/logout", async (req, res) => {
    const input = parseRefreshInput(req.body);
    await authService.logout(input.refreshToken);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/auth/me", async (req: KatkeeRequest, res) => {
    requireAuth(req);
    const user = await authService.getPublicUserById(req.userId as string);
    if (!user) throw new HttpError(404, "User not found.");
    sendJson(res, 200, { user });
  });
}
