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
