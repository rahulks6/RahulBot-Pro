import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parseUsernameParam } from "../../shared/validation";
import { parseCreateHighlightInput, parseReorderHighlightsInput, parseUpdateHighlightInput } from "./dto";
import * as highlightsService from "./highlights.service";

export function registerHighlightsRoutes(router: Router): void {
  router.post("/api/v1/highlights", async (req, res) => {
    requireAuth(req);
    const input = parseCreateHighlightInput(req.body);
    const highlight = await highlightsService.createHighlight(req.userId as string, input);
    sendJson(res, 201, { highlight });
  });

  // Registered as its own literal path, not "/api/v1/highlights/:id" —
  // an action endpoint (spec: drag-and-drop reordering), same convention
  // as /follow, /block, /read elsewhere in this codebase.
  router.post("/api/v1/highlights/reorder", async (req, res) => {
    requireAuth(req);
    const input = parseReorderHighlightsInput(req.body);
    const highlights = await highlightsService.reorderHighlights(req.userId as string, input);
    sendJson(res, 200, { highlights });
  });

  router.get("/api/v1/users/:username/highlights", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const highlights = await highlightsService.listHighlightsForUser(username, req.userId as string);
    sendJson(res, 200, { highlights });
  });

  router.get("/api/v1/highlights/:id", async (req, res) => {
    requireAuth(req);
    const highlight = await highlightsService.getHighlightDetail(req.params.id as string, req.userId as string);
    sendJson(res, 200, { highlight });
  });

  router.patch("/api/v1/highlights/:id", async (req, res) => {
    requireAuth(req);
    const input = parseUpdateHighlightInput(req.body);
    const highlight = await highlightsService.updateHighlight(req.userId as string, req.params.id as string, input);
    sendJson(res, 200, { highlight });
  });

  router.delete("/api/v1/highlights/:id", async (req, res) => {
    requireAuth(req);
    await highlightsService.deleteHighlight(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/highlights/:id/items/:storyId", async (req, res) => {
    requireAuth(req);
    const story = await highlightsService.getHighlightItemDetail(
      req.params.id as string,
      req.params.storyId as string,
      req.userId as string,
    );
    sendJson(res, 200, { story });
  });
}
