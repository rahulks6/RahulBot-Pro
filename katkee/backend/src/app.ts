import type { Server } from "node:http";
import { Router } from "./http/router";
import { createServer } from "./http/server";
import { sendJson } from "./http/respond";
import { registerAuthRoutes } from "./modules/auth/auth.routes";
import { registerUserRoutes } from "./modules/users/users.routes";
import { registerSocialRoutes } from "./modules/social/social.routes";
import { registerSearchRoutes } from "./modules/search/search.routes";
import { registerMediaRoutes } from "./modules/media/media.routes";
import { registerStoriesRoutes } from "./modules/stories/stories.routes";
import { registerEngagementRoutes } from "./modules/stories/engagement.routes";

export function buildApp(): Server {
  const router = new Router();

  router.get("/health", (_req, res) => {
    sendJson(res, 200, { status: "ok", service: "katkee-backend" });
  });

  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerSocialRoutes(router);
  registerSearchRoutes(router);
  registerMediaRoutes(router);
  registerStoriesRoutes(router);
  registerEngagementRoutes(router);

  return createServer(router);
}
