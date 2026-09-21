import type { Server } from "node:http";
import { Router } from "./http/router";
import { createServer } from "./http/server";
import { sendJson } from "./http/respond";
import { registerAuthRoutes } from "./modules/auth/auth.routes";

export function buildApp(): Server {
  const router = new Router();

  router.get("/health", (_req, res) => {
    sendJson(res, 200, { status: "ok", service: "katkee-backend" });
  });

  registerAuthRoutes(router);

  return createServer(router);
}
