import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";

let baseUrl: string;
const server = buildApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function uniqueUser() {
  const suffix = randomUUID().slice(0, 8);
  return {
    username: `test_${suffix}`,
    email: `test_${suffix}@example.com`,
    password: "correcthorsebattery",
    displayName: `Test ${suffix}`,
  };
}

async function postJson(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("health", () => {
  it("responds 200 ok", async () => {
    const res = await getJson("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });
});

describe("signup", () => {
  it("creates a user and returns a token pair", async () => {
    const input = uniqueUser();
    const res = await postJson("/api/v1/auth/signup", input);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, input.username);
    assert.equal(res.body.user.email, input.email);
    assert.equal(res.body.user.passwordHash, undefined, "password hash must never be returned");
    assert.ok(res.body.tokens.accessToken);
    assert.ok(res.body.tokens.refreshToken);
  });

  it("rejects a duplicate username or email with 409", async () => {
    const input = uniqueUser();
    await postJson("/api/v1/auth/signup", input);
    const res = await postJson("/api/v1/auth/signup", input);
    assert.equal(res.status, 409);
  });

  it("rejects invalid input with 422 and per-field messages", async () => {
    const res = await postJson("/api/v1/auth/signup", {
      username: "a",
      email: "not-an-email",
      password: "short",
      displayName: "",
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "validation_error");
    assert.ok(res.body.fields.username);
    assert.ok(res.body.fields.email);
    assert.ok(res.body.fields.password);
    assert.ok(res.body.fields.displayName);
  });
});

describe("login", () => {
  it("logs in with correct credentials", async () => {
    const input = uniqueUser();
    await postJson("/api/v1/auth/signup", input);
    const res = await postJson("/api/v1/auth/login", { email: input.email, password: input.password });
    assert.equal(res.status, 200);
    assert.ok(res.body.tokens.accessToken);
  });

  it("rejects a wrong password with 401", async () => {
    const input = uniqueUser();
    await postJson("/api/v1/auth/signup", input);
    const res = await postJson("/api/v1/auth/login", { email: input.email, password: "wrong-password" });
    assert.equal(res.status, 401);
  });

  it("rejects an unknown email with 401 (not 404 — avoids user enumeration)", async () => {
    const res = await postJson("/api/v1/auth/login", { email: "nobody@example.com", password: "whatever123" });
    assert.equal(res.status, 401);
  });
});

describe("/api/v1/auth/me", () => {
  it("returns the authenticated user for a valid access token", async () => {
    const input = uniqueUser();
    const signup = await postJson("/api/v1/auth/signup", input);
    const res = await getJson("/api/v1/auth/me", {
      Authorization: `Bearer ${signup.body.tokens.accessToken}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, input.username);
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await getJson("/api/v1/auth/me");
    assert.equal(res.status, 401);
  });

  it("returns 401 for a garbage token", async () => {
    const res = await getJson("/api/v1/auth/me", { Authorization: "Bearer not-a-real-token" });
    assert.equal(res.status, 401);
  });
});

describe("refresh token rotation", () => {
  it("issues a new token pair and revokes the old refresh token", async () => {
    const input = uniqueUser();
    const signup = await postJson("/api/v1/auth/signup", input);
    const firstRefresh = signup.body.tokens.refreshToken;

    const refreshed = await postJson("/api/v1/auth/refresh", { refreshToken: firstRefresh });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.tokens.refreshToken, firstRefresh);

    const reuse = await postJson("/api/v1/auth/refresh", { refreshToken: firstRefresh });
    assert.equal(reuse.status, 401, "a rotated refresh token must not be usable again");
  });

  it("rejects an already-used-then-logged-out refresh token", async () => {
    const input = uniqueUser();
    const signup = await postJson("/api/v1/auth/signup", input);
    const refreshToken = signup.body.tokens.refreshToken;

    const logout = await postJson("/api/v1/auth/logout", { refreshToken });
    assert.equal(logout.status, 204);

    const afterLogout = await postJson("/api/v1/auth/refresh", { refreshToken });
    assert.equal(afterLogout.status, 401);
  });
});
