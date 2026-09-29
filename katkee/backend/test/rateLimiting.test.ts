// Set before importing "./env" (whose RATE_LIMIT_AUTH_MAX default uses
// `??=`, so this wins) and, critically, before config/env.ts is first
// imported by anything below — Node's test runner isolates each test
// file into its own process, so this doesn't affect any other test file's
// (much more generous) limits.
process.env.RATE_LIMIT_AUTH_MAX = "3";
process.env.RATE_LIMIT_AUTH_WINDOW_MS = "60000";

import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { makeClient, uniqueUser } from "./helpers";
import { RateLimiter } from "../src/http/rateLimiter";

let client: ReturnType<typeof makeClient>;
const server = buildApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  client = makeClient(`http://127.0.0.1:${address.port}`);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("RateLimiter (unit)", () => {
  it("allows up to max requests per window, then throws an HttpError shaped like a 429", () => {
    const limiter = new RateLimiter(10_000, 2);
    limiter.check("a");
    limiter.check("a");
    assert.throws(() => limiter.check("a"), (err: any) => err.status === 429);
  });

  it("tracks each key's budget independently", () => {
    const limiter = new RateLimiter(10_000, 1);
    limiter.check("a");
    assert.throws(() => limiter.check("a"), "a's budget is exhausted");
    assert.doesNotThrow(() => limiter.check("b"), "b has never been checked — its own budget");
  });

  it("resets a key's budget once its window has really elapsed", async () => {
    const limiter = new RateLimiter(150, 1);
    limiter.check("a");
    assert.throws(() => limiter.check("a"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.doesNotThrow(() => limiter.check("a"), "a new window should have started for real");
  });

  it("reset() clears all state immediately, for tests that need a clean slate", () => {
    const limiter = new RateLimiter(10_000, 1);
    limiter.check("a");
    assert.throws(() => limiter.check("a"));
    limiter.reset();
    assert.doesNotThrow(() => limiter.check("a"));
  });
});

describe("the auth rate limiter is wired into signup/login/refresh", () => {
  it("returns 429 once the per-IP auth budget (3, for this file) is exhausted", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 4; i++) {
      const res = await client.post("/api/v1/auth/signup", uniqueUser());
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, "the 4th signup from the same IP within the window must be rejected");
  });

  it("shares that same exhausted budget with login — one budget per IP across the whole auth family", async () => {
    const res = await client.post("/api/v1/auth/login", { email: "nobody@example.com", password: "whatever12" });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "http_error", "a 429 uses the same standard error shape as any other HttpError");
  });
});
