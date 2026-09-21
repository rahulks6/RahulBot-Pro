/**
 * Typed HTTP client for the KATKEE backend. Response shapes here are kept in
 * lockstep with backend/src/modules/auth/auth.routes.ts and
 * backend/src/modules/auth/auth.service.ts (PublicUser, TokenPair) — there
 * is no shared package yet, so a backend response shape change must be
 * mirrored here by hand until Phase 1's tooling grows a shared types
 * package.
 */
export const API_BASE_URL = "http://localhost:4000";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message =
      typeof json?.message === "string"
        ? json.message
        : json?.error === "validation_error"
          ? "Please fix the highlighted fields."
          : "Something went wrong.";
    throw new ApiError(res.status, message, json?.fields);
  }

  return json as T;
}

export function apiGet<T>(path: string, accessToken?: string): Promise<T> {
  return request<T>(path, {
    method: "GET",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
}

export function apiPost<T>(path: string, body?: unknown, accessToken?: string): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
