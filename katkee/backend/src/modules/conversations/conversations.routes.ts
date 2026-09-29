import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseUsernameParam } from "../../shared/validation";
import { parseSendMessageInput } from "./dto";
import * as conversationsService from "./conversations.service";

export function registerConversationsRoutes(router: Router): void {
  router.post("/api/v1/users/:username/conversation", async (req, res) => {
    requireAuth(req);
    const username = parseUsernameParam(req.params.username);
    const conversation = await conversationsService.openConversationWith(req.userId as string, username);
    sendJson(res, 200, { conversation });
  });

  router.get("/api/v1/conversations", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const conversations = await conversationsService.listConversations(req.userId as string, limit, offset);
    sendJson(res, 200, { conversations, limit, offset });
  });

  router.get("/api/v1/conversations/unread-count", async (req, res) => {
    requireAuth(req);
    const count = await conversationsService.getUnreadConversationCount(req.userId as string);
    sendJson(res, 200, { count });
  });

  router.get("/api/v1/conversations/:id/messages", async (req, res) => {
    requireAuth(req);
    const { limit, offset } = parsePagination(parseQueryString(req.url ?? ""));
    const messages = await conversationsService.listMessages(req.userId as string, req.params.id as string, limit, offset);
    sendJson(res, 200, { messages, limit, offset });
  });

  router.post("/api/v1/conversations/:id/messages", async (req, res) => {
    requireAuth(req);
    const input = parseSendMessageInput(req.body);
    const message = await conversationsService.sendMessage(req.userId as string, req.params.id as string, input);
    sendJson(res, 201, { message });
  });

  router.post("/api/v1/conversations/:id/read", async (req, res) => {
    requireAuth(req);
    await conversationsService.markConversationRead(req.userId as string, req.params.id as string);
    sendJson(res, 204, undefined);
  });
}
