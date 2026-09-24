import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import * as recommendationService from "./recommendation.service";

export function registerRecommendationRoutes(router: Router): void {
  // Registered before "/api/v1/stories/:id" so "feed" is never mistaken for a story id.
  router.get("/api/v1/stories/feed/home", async (req, res) => {
    requireAuth(req);
    const feed = await recommendationService.getRankedHomeFeed(req.userId as string);
    sendJson(res, 200, { feed });
  });
}
