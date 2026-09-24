import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (payload === undefined) {
    res.writeHead(status, { "Content-Length": "0" });
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The Admin Console (see modules/admin/console.routes.ts) is server-rendered
 * static HTML/CSS/vanilla JS with zero build step — this is its one other
 * response shape, alongside the JSON every other route in this codebase
 * already returns.
 */
export function sendHtml(res: ServerResponse, status: number, html: string, contentType = "text/html; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}
