import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parseRecordEventInput } from "./events.dto";
import * as eventsService from "./events.service";

export function registerEventsRoutes(router: Router): void {
  router.post("/api/v1/events", async (req, res) => {
    requireAuth(req);
    const input = parseRecordEventInput(req.body);
    await eventsService.recordEvent(req.userId as string, input);
    sendJson(res, 204, undefined);
  });
}
