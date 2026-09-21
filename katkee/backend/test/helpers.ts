import { randomUUID } from "node:crypto";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export function makeClient(baseUrl: string) {
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  return {
    get: (path: string, headers?: Record<string, string>) => request("GET", path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => request("POST", path, body, headers),
    patch: (path: string, body?: unknown, headers?: Record<string, string>) => request("PATCH", path, body, headers),
    delete: (path: string, headers?: Record<string, string>) => request("DELETE", path, undefined, headers),
  };
}

export function uniqueUser() {
  const suffix = randomUUID().slice(0, 8);
  return {
    username: `test_${suffix}`,
    email: `test_${suffix}@example.com`,
    password: "correcthorsebattery",
    displayName: `Test ${suffix}`,
  };
}

export function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}
