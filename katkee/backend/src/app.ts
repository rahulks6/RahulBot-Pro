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
import { registerEventsRoutes } from "./modules/recommendations/events.routes";
import { registerRecommendationRoutes } from "./modules/recommendations/recommendation.routes";
import { registerNotificationsRoutes } from "./modules/notifications/notifications.routes";
import { registerConversationsRoutes } from "./modules/conversations/conversations.routes";
import { registerHighlightsRoutes } from "./modules/highlights/highlights.routes";

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
  registerEventsRoutes(router);
  registerRecommendationRoutes(router);
  registerNotificationsRoutes(router);
  registerConversationsRoutes(router);
  registerHighlightsRoutes(router);

  return createServer(router);
}
