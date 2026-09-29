import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, makeClient, uniqueUser } from "./helpers";
import { query } from "../src/db/psql";

let client: ReturnType<typeof makeClient>;
let baseUrl: string;
const server = buildApp();

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signupUser() {
  const input = uniqueUser();
  const res = await client.post("/api/v1/auth/signup", input);
  return {
    input,
    accessToken: res.body.tokens.accessToken as string,
    id: res.body.user.id as string,
  };
}

/**
 * The real DB constraint this whole module is built around — a unique
 * partial index on is_primary_admin — means at most one row in the
 * *entire* test database can ever hold it, not one per test. So this
 * file seeds exactly one, once, and shares it across every test below;
 * every other "admin" a test needs is created through the real
 * `POST /api/v1/admin/staff`, using that one shared primary admin's
 * credentials — exactly the out-of-band-bootstrap-then-real-API-from-there-on
 * flow scripts/seedPrimaryAdmin.ts is meant to enable.
 */
async function grantPrimaryAdmin(userId: string): Promise<void> {
  await query(`UPDATE users SET role = 'admin', is_primary_admin = true WHERE id = :'id'`, { id: userId });
}

let primaryAdmin: Awaited<ReturnType<typeof signupUser>>;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = makeClient(baseUrl);

  primaryAdmin = await signupUser();
  await grantPrimaryAdmin(primaryAdmin.id);
});

describe("admin staff management", () => {
  it("a plain user gets 403 from every admin/staff endpoint", async () => {
    const user = await signupUser();
    const list = await client.get("/api/v1/admin/staff", authHeader(user.accessToken));
    assert.equal(list.status, 403);
    const promote = await client.post("/api/v1/admin/staff", { username: "someone", role: "moderator" }, authHeader(user.accessToken));
    assert.equal(promote.status, 403);
    const demote = await client.delete("/api/v1/admin/staff/someone", authHeader(user.accessToken));
    assert.equal(demote.status, 403);
  });

  it("a moderator (not an admin) also gets 403 from admin/staff endpoints — moderator and admin are different tiers", async () => {
    const target = await signupUser();
    await client.post("/api/v1/admin/staff", { username: target.input.username, role: "moderator" }, authHeader(primaryAdmin.accessToken));

    const list = await client.get("/api/v1/admin/staff", authHeader(target.accessToken));
    assert.equal(list.status, 403, "a moderator is not automatically an admin");
  });

  it("an admin can promote a user to moderator, and that moderator can resolve reports", async () => {
    const target = await signupUser();

    const promote = await client.post(
      "/api/v1/admin/staff",
      { username: target.input.username, role: "moderator" },
      authHeader(primaryAdmin.accessToken),
    );
    assert.equal(promote.status, 200);
    assert.equal(promote.body.member.role, "moderator");
    assert.equal(promote.body.member.username, target.input.username);

    const queue = await client.get("/api/v1/moderation/reports", authHeader(target.accessToken));
    assert.equal(queue.status, 200, "the newly-promoted moderator can reach a moderator-only endpoint");
  });

  it("an admin can promote a user straight to admin, and that new admin can promote/demote others too", async () => {
    const newAdmin = await signupUser();
    await client.post("/api/v1/admin/staff", { username: newAdmin.input.username, role: "admin" }, authHeader(primaryAdmin.accessToken));

    const thirdUser = await signupUser();
    const promoted = await client.post(
      "/api/v1/admin/staff",
      { username: thirdUser.input.username, role: "moderator" },
      authHeader(newAdmin.accessToken),
    );
    assert.equal(promoted.status, 200, "an admin created by another admin has full admin rights, not a lesser tier");
  });

  it("demoting a moderator back to a plain user actually revokes access", async () => {
    const target = await signupUser();
    await client.post("/api/v1/admin/staff", { username: target.input.username, role: "moderator" }, authHeader(primaryAdmin.accessToken));

    const demote = await client.delete(`/api/v1/admin/staff/${target.input.username}`, authHeader(primaryAdmin.accessToken));
    assert.equal(demote.status, 200);
    assert.equal(demote.body.member.role, "user");

    const queue = await client.get("/api/v1/moderation/reports", authHeader(target.accessToken));
    assert.equal(queue.status, 403, "access is revoked immediately, not just cosmetically");
  });

  it("lists the current staff roster, primary admin first", async () => {
    const mod = await signupUser();
    await client.post("/api/v1/admin/staff", { username: mod.input.username, role: "moderator" }, authHeader(primaryAdmin.accessToken));

    const list = await client.get("/api/v1/admin/staff", authHeader(primaryAdmin.accessToken));
    assert.equal(list.status, 200);
    const usernames = list.body.staff.map((s: any) => s.username);
    assert.ok(usernames.includes(primaryAdmin.input.username));
    assert.ok(usernames.includes(mod.input.username));
    assert.equal(list.body.staff[0].isPrimaryAdmin, true, "the primary admin sorts first");
  });

  it("rejects an invalid role and a nonexistent username", async () => {
    const badRole = await client.post(
      "/api/v1/admin/staff",
      { username: primaryAdmin.input.username, role: "superuser" },
      authHeader(primaryAdmin.accessToken),
    );
    assert.equal(badRole.status, 422);

    const noSuchUser = await client.post(
      "/api/v1/admin/staff",
      { username: "no_such_user_at_all", role: "moderator" },
      authHeader(primaryAdmin.accessToken),
    );
    assert.equal(noSuchUser.status, 404);

    const demoteNoSuchUser = await client.delete("/api/v1/admin/staff/no_such_user_at_all", authHeader(primaryAdmin.accessToken));
    assert.equal(demoteNoSuchUser.status, 404);
  });

  it("the primary admin can never be demoted, by anyone, including another admin", async () => {
    const otherAdmin = await signupUser();
    await client.post("/api/v1/admin/staff", { username: otherAdmin.input.username, role: "admin" }, authHeader(primaryAdmin.accessToken));

    const demote = await client.delete(`/api/v1/admin/staff/${primaryAdmin.input.username}`, authHeader(otherAdmin.accessToken));
    assert.equal(demote.status, 403);

    const stillAdmin = await client.get("/api/v1/admin/staff", authHeader(primaryAdmin.accessToken));
    assert.equal(stillAdmin.status, 200, "the primary admin's own access is unaffected");
  });

  it("the primary admin can never be suspended — not directly, and not via a resolved user report", async () => {
    const otherAdmin = await signupUser();
    await client.post("/api/v1/admin/staff", { username: otherAdmin.input.username, role: "admin" }, authHeader(primaryAdmin.accessToken));

    const directSuspend = await client.post(
      `/api/v1/moderation/users/${primaryAdmin.input.username}/suspend`,
      undefined,
      authHeader(otherAdmin.accessToken),
    );
    assert.equal(directSuspend.status, 403);

    const reporter = await signupUser();
    const report = await client.post(
      "/api/v1/reports",
      { targetType: "user", targetId: primaryAdmin.id, reason: "other" },
      authHeader(reporter.accessToken),
    );
    const resolve = await client.post(
      `/api/v1/moderation/reports/${report.body.report.id}/resolve`,
      { action: "suspend_user" },
      authHeader(otherAdmin.accessToken),
    );
    assert.equal(resolve.status, 403, "the same protection applies through the report-resolution path, not just the direct endpoint");

    const stillWorks = await client.post("/api/v1/auth/login", {
      email: primaryAdmin.input.email,
      password: primaryAdmin.input.password,
    });
    assert.equal(stillWorks.status, 200, "the primary admin can still log in — never actually suspended");
  });
});
