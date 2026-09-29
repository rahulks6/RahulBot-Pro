import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, makeClient, uniqueUser } from "./helpers";
import { buildTestPng } from "./fixtures";
import { query } from "../src/db/psql";

let client: ReturnType<typeof makeClient>;
let baseUrl: string;
const server = buildApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = makeClient(baseUrl);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signupUser() {
  const input = uniqueUser();
  const res = await client.post("/api/v1/auth/signup", input);
  return { input, accessToken: res.body.tokens.accessToken as string, id: res.body.user.id as string };
}

/**
 * This file never touches is_primary_admin (a unique partial index across
 * the whole shared test DB — see test/admin.test.ts's own note on why only
 * one file may ever seed that). Every admin here is a plain, non-primary
 * 'admin' role granted directly by SQL, with specific admin_permissions
 * rows granted the same way — admin_permissions has no such uniqueness
 * constraint, so any number of test files can freely insert into it.
 */
async function makeAdmin(userId: string): Promise<void> {
  await query(`UPDATE users SET role = 'admin' WHERE id = :'id'`, { id: userId });
}

async function grantPermission(userId: string, permission: string, grantedBy: string): Promise<void> {
  await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'user_id', :'permission', :'granted_by')`, {
    user_id: userId,
    permission,
    granted_by: grantedBy,
  });
}

async function uploadPhoto(accessToken: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/media/photos`, {
    method: "POST",
    headers: { "Content-Type": "image/png", ...authHeader(accessToken) },
    body: buildTestPng(4, 4),
  });
  const body = (await res.json()) as { media: { id: string } };
  return body.media.id;
}

describe("Admin Console: granular permission gating", () => {
  it("an admin without the specific permission gets 403 from a permission-gated action", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    const target = await signupUser();

    const res = await client.post(
      `/api/v1/admin/console/users/${target.input.username}/restrict`,
      { reason: "test" },
      authHeader(admin.accessToken),
    );
    assert.equal(res.status, 403);
  });

  it("a plain (non-admin) user gets 403 even with a stray permission row somehow present", async () => {
    const user = await signupUser();
    await grantPermission(user.id, "users.restrict", user.id);
    const target = await signupUser();
    const res = await client.post(`/api/v1/admin/console/users/${target.input.username}/restrict`, {}, authHeader(user.accessToken));
    assert.equal(res.status, 403, "role must be 'admin' first — a permission row alone is never enough");
  });

  it("granting the specific permission makes the same action succeed", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "users.restrict", admin.id);
    const target = await signupUser();

    const res = await client.post(`/api/v1/admin/console/users/${target.input.username}/restrict`, {}, authHeader(admin.accessToken));
    assert.equal(res.status, 204);
  });

  it("restricting a user blocks publishing a new Story but not reading their own profile, and unrestricting lifts it", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "users.restrict", admin.id);
    const victim = await signupUser();

    await client.post(`/api/v1/admin/console/users/${victim.input.username}/restrict`, {}, authHeader(admin.accessToken));

    const mediaId = await uploadPhoto(victim.accessToken);
    const publishAttempt = await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(victim.accessToken),
    );
    assert.equal(publishAttempt.status, 403);

    const me = await client.get("/api/v1/auth/me", authHeader(victim.accessToken));
    assert.equal(me.status, 200, "a restricted user can still browse — only specific write actions are blocked");

    await client.post(`/api/v1/admin/console/users/${victim.input.username}/unrestrict`, undefined, authHeader(admin.accessToken));
    const secondAttempt = await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(victim.accessToken),
    );
    assert.equal(secondAttempt.status, 201, "unrestricting lifts the block");
  });

  it("content.remove hides a Story and writes it as moderator-removed; content.restore undoes it, and only it", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "content.remove", admin.id);
    await grantPermission(admin.id, "content.restore", admin.id);

    const owner = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const publish = await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(owner.accessToken),
    );
    const storyId = publish.body.story.id as string;

    const remove = await client.post(`/api/v1/admin/console/content/story/${storyId}/remove`, { reason: "policy" }, authHeader(admin.accessToken));
    assert.equal(remove.status, 204);

    const gone = await client.get(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(gone.status, 404, "removed content is hidden the same way owner-deleted content is");

    const restore = await client.post(`/api/v1/admin/console/content/story/${storyId}/restore`, undefined, authHeader(admin.accessToken));
    assert.equal(restore.status, 204);

    const backAgain = await client.get(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(backAgain.status, 200);

    const doubleRestore = await client.post(`/api/v1/admin/console/content/story/${storyId}/restore`, undefined, authHeader(admin.accessToken));
    assert.equal(doubleRestore.status, 409, "restoring something that isn't in a moderator-removed state is rejected, not a silent no-op");
  });

  it("restore never resurrects a Story its own owner deleted", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "content.restore", admin.id);

    const owner = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const publish = await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(owner.accessToken),
    );
    const storyId = publish.body.story.id as string;

    await client.delete(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    const restore = await client.post(`/api/v1/admin/console/content/story/${storyId}/restore`, undefined, authHeader(admin.accessToken));
    assert.equal(restore.status, 409, "an owner's own deletion never carries moderation_status='removed_by_moderation'");
  });

  it("moderation.history.read shows both the remove and the restore, gated by its own permission", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "content.remove", admin.id);
    await grantPermission(admin.id, "content.restore", admin.id);

    const owner = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const publish = await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(owner.accessToken),
    );
    const storyId = publish.body.story.id as string;

    await client.post(`/api/v1/admin/console/content/story/${storyId}/remove`, { reason: "x" }, authHeader(admin.accessToken));
    await client.post(`/api/v1/admin/console/content/story/${storyId}/restore`, undefined, authHeader(admin.accessToken));

    const deniedHistory = await client.get(
      `/api/v1/admin/console/moderation-history?targetType=story&targetId=${storyId}`,
      authHeader(owner.accessToken),
    );
    assert.equal(deniedHistory.status, 403, "moderation.history.read is its own gated permission, not implied by being logged in");

    await grantPermission(admin.id, "moderation.history.read", admin.id);
    const history = await client.get(
      `/api/v1/admin/console/moderation-history?targetType=story&targetId=${storyId}`,
      authHeader(admin.accessToken),
    );
    assert.equal(history.status, 200);
    const actionTypes = history.body.entries.map((e: any) => e.actionType);
    assert.ok(actionTypes.includes("remove_content"));
    assert.ok(actionTypes.includes("restore_content"));
  });

  it("an admin can never create or disable their own account through these endpoints", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "admins.create", admin.id);
    await grantPermission(admin.id, "admins.disable", admin.id);

    const selfCreate = await client.post("/api/v1/admin/console/admins", { username: admin.input.username }, authHeader(admin.accessToken));
    assert.equal(selfCreate.status, 403);

    const selfDisable = await client.post(`/api/v1/admin/console/admins/${admin.input.username}/disable`, undefined, authHeader(admin.accessToken));
    assert.equal(selfDisable.status, 403);
  });

  it("admins.create promotes a plain user to 'admin' (never higher), gated by its own permission", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    const target = await signupUser();

    const denied = await client.post("/api/v1/admin/console/admins", { username: target.input.username }, authHeader(admin.accessToken));
    assert.equal(denied.status, 403);

    await grantPermission(admin.id, "admins.create", admin.id);
    const created = await client.post("/api/v1/admin/console/admins", { username: target.input.username }, authHeader(admin.accessToken));
    assert.equal(created.status, 201);
    assert.equal(created.body.admin.isPrimaryAdmin, false);
    assert.deepEqual(created.body.admin.permissions, []);
  });

  it("admins.disable revokes the role and wipes every permission the account held", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "admins.disable", admin.id);

    const target = await signupUser();
    await makeAdmin(target.id);
    await grantPermission(target.id, "ads.create", admin.id);

    const disable = await client.post(`/api/v1/admin/console/admins/${target.input.username}/disable`, undefined, authHeader(admin.accessToken));
    assert.equal(disable.status, 204);

    const rows = await query(`SELECT role FROM users WHERE id = :'id'`, { id: target.id });
    assert.equal(rows[0]?.role, "user");
    const perms = await query(`SELECT permission FROM admin_permissions WHERE user_id = :'id'`, { id: target.id });
    assert.equal(perms.length, 0);
  });

  it("permission grant/revoke and admin creation/disable are all rejected when ADMIN_CONSOLE_ENABLED is off", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await grantPermission(admin.id, "users.restrict", admin.id);
    const target = await signupUser();

    await query(`UPDATE feature_flags SET enabled = false WHERE key = 'ADMIN_CONSOLE_ENABLED'`, {});
    try {
      const res = await client.post(`/api/v1/admin/console/users/${target.input.username}/restrict`, {}, authHeader(admin.accessToken));
      assert.equal(res.status, 404, "the whole new console (this permission-gated path) is off, not just hidden in the UI");
    } finally {
      await query(`UPDATE feature_flags SET enabled = true WHERE key = 'ADMIN_CONSOLE_ENABLED'`, {});
    }
  });

  it("the legacy mobile-facing moderator queue is unaffected by ADMIN_CONSOLE_ENABLED", async () => {
    const mod = await signupUser();
    await query(`UPDATE users SET role = 'moderator' WHERE id = :'id'`, { id: mod.id });

    await query(`UPDATE feature_flags SET enabled = false WHERE key = 'ADMIN_CONSOLE_ENABLED'`, {});
    try {
      const res = await client.get("/api/v1/moderation/reports?status=pending", authHeader(mod.accessToken));
      assert.equal(res.status, 200, "requireModerator/requireAdmin never call assertConsoleEnabled — only the new permissions.service functions do");
    } finally {
      await query(`UPDATE feature_flags SET enabled = true WHERE key = 'ADMIN_CONSOLE_ENABLED'`, {});
    }
  });
});
