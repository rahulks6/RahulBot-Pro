import { config } from "../config/env";
import { RateLimiter } from "./rateLimiter";

/** Applied to every request in server.ts — a generous per-IP safety net against basic abuse/scraping. */
export const globalRateLimiter = new RateLimiter(config.rateLimit.globalWindowMs, config.rateLimit.globalMax);

/** Applied specifically to signup/login/refresh (auth.routes.ts) — the endpoints brute-forcing an account actually needs. */
export const authRateLimiter = new RateLimiter(config.rateLimit.authWindowMs, config.rateLimit.authMax);
