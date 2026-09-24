import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import { parsePublishStoryInput } from "./dto";
import * as storiesService from "./stories.service";

export function registerStoriesRoutes(router: Router): void {
  router.post("/api/v1/stories", async (req, res) => {
    requireAuth(req);
    const input = parsePublishStoryInput(req.body);
    const story = await storiesService.publishStory(req.userId as string, input);
    sendJson(res, 201, { story });
  });

  // Registered before "/api/v1/stories/:id" so "feed" is never mistaken for a story id.
  router.get("/api/v1/stories/feed/following", async (req, res) => {
    requireAuth(req);
    const feed = await storiesService.getFollowingFeed(req.userId as string);
    sendJson(res, 200, { feed });
  });

  router.get("/api/v1/stories/mine/active", async (req, res) => {
    requireAuth(req);
    const stories = await storiesService.listMyActiveStories(req.userId as string);
    sendJson(res, 200, { stories });
  });

  // Registered alongside "mine/active" for the same "feed" reason above — never mistaken for a story id.
  router.get("/api/v1/stories/mine/archive", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const stories = await storiesService.listMyArchivedStories(req.userId as string, limit, offset);
    sendJson(res, 200, { stories, limit, offset });
  });

  // "Per-sequence Insights" (spec) — every currently-active Story the
  // caller owns, at once. Same "mine/..." literal-path convention as
  // above; always the caller's own, so no :id at all.
  router.get("/api/v1/stories/mine/sequence-insights", async (req, res) => {
    requireAuth(req);
    const insights = await storiesService.getSequenceInsights(req.userId as string);
    sendJson(res, 200, { insights });
  });

  router.get("/api/v1/stories/:id", async (req, res) => {
    requireAuth(req);
    const story = await storiesService.getStoryDetailForViewer(req.params.id as string, req.userId as string);
    sendJson(res, 200, { story });
  });

  router.delete("/api/v1/stories/:id", async (req, res) => {
    requireAuth(req);
    await storiesService.deleteStory(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });

  router.post("/api/v1/stories/:id/view", async (req, res) => {
    requireAuth(req);
    await storiesService.recordView(req.params.id as string, req.userId as string);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/stories/:id/views", async (req, res) => {
    requireAuth(req);
    const count = await storiesService.getViewCount(req.userId as string, req.params.id as string);
    sendJson(res, 200, { views: count });
  });

  // Owner-only — the identities behind /views' count (see stories.service.ts's getStoryViewers).
  router.get("/api/v1/stories/:id/viewers", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const viewers = await storiesService.getStoryViewers(req.userId as string, req.params.id as string, limit, offset);
    sendJson(res, 200, { viewers, limit, offset });
  });

  // Owner-only — completion %, following-vs-discovery, and profile-visit rate for this one Story.
  router.get("/api/v1/stories/:id/insights", async (req, res) => {
    requireAuth(req);
    const insights = await storiesService.getStoryInsights(req.userId as string, req.params.id as string);
    sendJson(res, 200, { insights });
  });

  router.get("/api/v1/stories/:id/owner", async (req, res) => {
    requireAuth(req);
    const username = await storiesService.getStoryOwnerUsername(req.params.id as string, req.userId as string);
    sendJson(res, 200, { username });
  });

  router.get("/api/v1/users/:username/stories", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const stories = await storiesService.listUserActiveStories(username, req.userId as string);
    sendJson(res, 200, { stories });
  });
}
