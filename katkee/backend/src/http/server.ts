import * as http from "node:http";
import { ValidationError } from "../modules/auth/dto";
import { AuthError } from "../modules/auth/auth.service";
import { DatabaseError } from "../db/psql";
import { HttpError } from "./errors";
import { sendJson } from "./respond";
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

export function createServer(router: Router): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        const match = router.match(req.method ?? "GET", url);
        if (!match) {
          sendJson(res, 404, { error: "not_found", message: `No route for ${req.method} ${url}` });
          return;
        }

        const body = ["POST", "PUT", "PATCH"].includes((req.method ?? "").toUpperCase())
          ? await readBody(req)
          : undefined;

        const katkeeReq = req as KatkeeRequest;
        katkeeReq.params = match.params;
        katkeeReq.body = body;

        await match.handler(katkeeReq, res);
      } catch (error) {
        handleError(res, error);
      }
    })();
  });
}
