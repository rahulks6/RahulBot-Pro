import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../lib/errors.ts';
import type { SafeHtml } from './html.ts';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  form: Record<string, string>;
  formAll: Record<string, string[]>;
  raw: IncomingMessage;
}

export type Result =
  | { type: 'html'; body: SafeHtml; status?: number }
  | { type: 'redirect'; location: string }
  | { type: 'json'; body: unknown; filename?: string }
  | { type: 'file'; path: string; mime: string }
  | { type: 'text'; body: string; status?: number };

export type Handler = (req: Req) => Result | Promise<Result>;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  maxBody: number;
}

export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler, 0);
  }

  post(path: string, handler: Handler, maxBody = 4 * 1024 * 1024): void {
    this.add('POST', path, handler, maxBody);
  }

  private add(method: 'GET' | 'POST', path: string, handler: Handler, maxBody: number): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([a-zA-Z]+)(\*)?/g, (_m, key: string, star?: string) => {
          keys.push(key);
          return star ? '(.+)' : '([A-Za-z0-9_][A-Za-z0-9_.-]*)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern, keys, handler, maxBody });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { route, params };
    }
    return undefined;
  }
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes)
    throw new AppError(
      'VALIDATION_FAILED',
      `Request body too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes)
      throw new AppError(
        'VALIDATION_FAILED',
        `Request body too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      );
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseForm(body: string): { form: Record<string, string>; formAll: Record<string, string[]> } {
  const params = new URLSearchParams(body);
  const form: Record<string, string> = {};
  const formAll: Record<string, string[]> = {};
  for (const [k, v] of params) {
    form[k] = v;
    (formAll[k] ??= []).push(v);
  }
  return { form, formAll };
}

/** Security headers for every response (local app, no third-party resources). */
export function securityHeaders(res: ServerResponse): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * CSRF protection for state-changing requests: the form must carry the
 * per-process token AND the Origin/Referer (when sent) must be this host.
 */
export function checkCsrf(req: IncomingMessage, form: Record<string, string>, token: string): boolean {
  if (form['_csrf'] !== token) return false;
  const host = req.headers.host;
  const origin = req.headers.origin ?? req.headers.referer;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
