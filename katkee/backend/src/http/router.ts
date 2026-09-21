import type { IncomingMessage, ServerResponse } from "node:http";

export interface KatkeeRequest extends IncomingMessage {
  params: Record<string, string>;
  body: unknown;
  userId?: string;
}

export type Handler = (req: KatkeeRequest, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
  }

  get(path: string, handler: Handler): void {
    this.add("GET", path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add("POST", path, handler);
  }
  delete(path: string, handler: Handler): void {
    this.add("DELETE", path, handler);
  }
  patch(path: string, handler: Handler): void {
    this.add("PATCH", path, handler);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const requestSegments = splitPath(path.split("?")[0] ?? "");
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== requestSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i] as string;
        const reqSeg = requestSegments[i] as string;
        if (routeSeg.startsWith(":")) {
          params[routeSeg.slice(1)] = decodeURIComponent(reqSeg);
        } else if (routeSeg !== reqSeg) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}
