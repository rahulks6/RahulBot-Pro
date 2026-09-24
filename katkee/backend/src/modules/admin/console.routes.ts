import * as fs from "node:fs";
import * as path from "node:path";
import type { Router } from "../../http/router";
import type { ServerResponse } from "node:http";
import { sendHtml } from "../../http/respond";
import * as flagsRepo from "../feature-flags/flags.repository";

/**
 * The Admin Console's static shell — plain HTML/CSS/vanilla JS with zero
 * build step, served directly by this project's existing hand-rolled HTTP
 * server (see http/server.ts). Files live under backend/public/admin and
 * are read fresh on every request (resolved from cwd, matching
 * config/env.ts's own reasoning for why that's correct whether this is
 * running from source or from dist/) — editing one takes effect on the
 * next request, no restart, no bundler.
 *
 * These pages carry zero authority: they contain no user data at all, only
 * the JS that will immediately call the JSON API (see admin.routes.ts) and
 * bounce to its own login view if that 401s. Every real access decision is
 * made server-side, in the API itself.
 */
const PUBLIC_ADMIN_DIR = path.resolve(process.cwd(), "public", "admin");

function readAsset(filename: string): string {
  return fs.readFileSync(path.join(PUBLIC_ADMIN_DIR, filename), "utf8");
}

async function ifConsoleEnabled(res: ServerResponse, serve: () => void): Promise<void> {
  const enabled = await flagsRepo.isEnabled("ADMIN_CONSOLE_ENABLED");
  if (!enabled) {
    sendHtml(res, 404, "Not found.", "text/plain; charset=utf-8");
    return;
  }
  serve();
}

export function registerAdminConsoleRoutes(router: Router): void {
  router.get("/admin", async (_req, res) => {
    await ifConsoleEnabled(res, () => sendHtml(res, 200, readAsset("index.html")));
  });
  router.get("/admin/", async (_req, res) => {
    await ifConsoleEnabled(res, () => sendHtml(res, 200, readAsset("index.html")));
  });
  router.get("/admin/app.js", async (_req, res) => {
    await ifConsoleEnabled(res, () => sendHtml(res, 200, readAsset("app.js"), "text/javascript; charset=utf-8"));
  });
  router.get("/admin/style.css", async (_req, res) => {
    await ifConsoleEnabled(res, () => sendHtml(res, 200, readAsset("style.css"), "text/css; charset=utf-8"));
  });
}
