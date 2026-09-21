import type { IncomingMessage, ServerResponse } from "node:http";

export interface KatkeeRequest extends IncomingMessage {
  params: Record<string, string>;
  body: unknown;
  userId?: string;
}

export type Handler = (req: KatkeeRequest, res: ServerResponse) => Promise<void> | void;

export interface RouteOptions {
  /**
   * Skip the server's JSON body parsing for this route and leave the
   * request stream untouched — for binary uploads (media), which the
   * handler itself pipes to disk instead of buffering as JSON in memory.
   */
  rawBody?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  options: RouteOptions;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: RouteOptions = {}): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler, options });
  }

  get(path: string, handler: Handler, options?: RouteOptions): void {
    this.add("GET", path, handler, options);
  }
  post(path: string, handler: Handler, options?: RouteOptions): void {
    this.add("POST", path, handler, options);
  }
  delete(path: string, handler: Handler, options?: RouteOptions): void {
    this.add("DELETE", path, handler, options);
  }
  patch(path: string, handler: Handler, options?: RouteOptions): void {
    this.add("PATCH", path, handler, options);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string>; options: RouteOptions } | null {
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
      if (matched) return { handler: route.handler, params, options: route.options };
    }
    return null;
  }
}
