import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { parsePagination, parseQueryString } from "../../http/pagination";
import { parseSearchQuery } from "../users/dto";
import * as usersRepo from "../users/users.repository";

export function registerSearchRoutes(router: Router): void {
  router.get("/api/v1/search/users", async (req, res) => {
    requireAuth(req);
    const parsedQuery = parseQueryString(req.url ?? "");
    const term = parseSearchQuery(parsedQuery.q);
    const { limit, offset } = parsePagination(parsedQuery);
    const results = await usersRepo.searchUsers(term, req.userId as string, limit, offset);
    sendJson(res, 200, { results, limit, offset });
  });
}
