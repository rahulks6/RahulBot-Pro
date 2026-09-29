import * as http from "node:http";
import { ValidationError } from "../modules/auth/dto";
import { AuthError } from "../modules/auth/auth.service";
import { DatabaseError } from "../db/psql";
import { HttpError } from "./errors";
import { sendJson } from "./respond";
import { globalRateLimiter } from "./rateLimiters";
import { clientIp } from "./rateLimiter";
import type { KatkeeRequest, Router } from "./router";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ValidationError) {
    sendJson(res, 422, { error: "validation_error", fields: error.fieldErrors });
    return;
  }
  if (error instanceof AuthError) {
    sendJson(res, error.status, { error: "auth_error", message: error.message });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: "http_error", message: error.message, fields: error.fieldErrors });
    return;
  }
  if (error instanceof DatabaseError) {
    console.error("Database error:", error.detail);
    sendJson(res, 500, { error: "internal_error", message: "Something went wrong." });
    return;
  }
  console.error("Unhandled error:", error);
  sendJson(res, 500, { error: "internal_error", message: "Something went wrong." });
}

function logRequest(req: http.IncomingMessage, res: http.ServerResponse, durationMs: number): void {
  // One structured JSON line per request — real production observability
  // without an external logging package (this sandbox can't install one
  // anyway). The path is logged without its query string: nothing here
  // uses query params for secrets today, but stripping them is a cheap
  // habit that stays correct if that ever changes.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: (req.url ?? "").split("?")[0],
      status: res.statusCode,
      durationMs,
      ip: clientIp(req),
    }),
  );
}

export function createServer(router: Router): http.Server {
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => logRequest(req, res, Date.now() - startedAt));

    void (async () => {
      try {
        globalRateLimiter.check(clientIp(req));

        const url = req.url ?? "/";
        const match = router.match(req.method ?? "GET", url);
        if (!match) {
          sendJson(res, 404, { error: "not_found", message: `No route for ${req.method} ${url}` });
          return;
        }

        // DELETE is included too — HTTP (RFC 7231) doesn't forbid a body on
        // DELETE, and account deletion's password confirmation needs one.
        // Every existing DELETE route sends no body at all, so readBody()
        // just resolves those to undefined exactly as before — this is
        // additive, not a behavior change for them.
        const isBodyMethod = ["POST", "PUT", "PATCH", "DELETE"].includes((req.method ?? "").toUpperCase());
        const body = isBodyMethod && !match.options.rawBody ? await readBody(req) : undefined;

        const katkeeReq = req as KatkeeRequest;
        katkeeReq.params = match.params;
        katkeeReq.body = body;

        await match.handler(katkeeReq, res);
      } catch (error) {
        handleError(res, error);
      }
    })();
  });

  // Headers must arrive quickly regardless of a request's body size — this
  // specifically targets a slow/trickling-headers (slowloris-style)
  // connection without punishing a legitimate large video upload on a slow
  // network, which needs `requestTimeout` (left at Node's own 5-minute
  // default) to stay generous.
  server.headersTimeout = 10_000;

  return server;
}
