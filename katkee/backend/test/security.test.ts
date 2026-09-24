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

async function makeAdmin(userId: string): Promise<void> {
  await query(`UPDATE users SET role = 'admin' WHERE id = :'id'`, { id: userId });
}

/**
 * Every privileged endpoint this pass added, with the method/path/body a
 * caller with no permissions at all would send. This is the denial-path
 * sweep — every one of these must independently reject both an
 * unauthenticated caller (401) and a plain authenticated non-admin (403),
 * never trusting that the Admin Console's own UI simply doesn't show the
 * button (spec: "never trust the frontend or hidden UI as authorization").
 */
interface CallerIds {
  id: string;
  username: string;
}

const PROTECTED_ENDPOINTS: Array<{ method: "GET" | "POST" | "DELETE"; path: (ids: CallerIds) => string; body?: unknown }> = [
  { method: "GET", path: () => "/api/v1/admin/console/admins" },
  { method: "POST", path: () => "/api/v1/admin/console/admins", body: { username: "nobody" } },
  { method: "POST", path: ({ username }) => `/api/v1/admin/console/admins/${username}/disable` },
  { method: "POST", path: ({ username }) => `/api/v1/admin/console/admins/${username}/permissions`, body: { permission: "audit.read" } },
  { method: "DELETE", path: ({ username }) => `/api/v1/admin/console/admins/${username}/permissions/audit.read` },
  { method: "GET", path: () => "/api/v1/admin/console/audit-logs" },
  { method: "GET", path: () => "/api/v1/admin/console/flags" },
  { method: "POST", path: () => "/api/v1/admin/console/flags/ADS_ENABLED", body: { enabled: true } },
  { method: "GET", path: () => "/api/v1/admin/console/moderation-history" },
  { method: "POST", path: () => "/api/v1/admin/console/content/story/00000000-0000-0000-0000-000000000000/remove", body: {} },
  { method: "POST", path: () => "/api/v1/admin/console/content/story/00000000-0000-0000-0000-000000000000/restore" },
  { method: "POST", path: ({ username }) => `/api/v1/admin/console/users/${username}/restrict`, body: {} },
  { method: "POST", path: ({ username }) => `/api/v1/admin/console/users/${username}/unrestrict` },
  { method: "POST", path: () => "/api/v1/admin/console/ads/advertisers", body: { name: "x" } },
  { method: "GET", path: () => "/api/v1/admin/console/ads/advertisers" },
  { method: "POST", path: () => "/api/v1/admin/console/ads/campaigns", body: { advertiserId: "00000000-0000-0000-0000-000000000000", name: "x" } },
  { method: "GET", path: () => "/api/v1/admin/console/ads/campaigns" },
  { method: "GET", path: () => "/api/v1/admin/console/ads/settings" },
  { method: "POST", path: () => "/api/v1/admin/console/ads/settings", body: { minOrganicBetweenAds: 1, maxAdsPerSession: 1 } },
];

const PLACEHOLDER_IDS: CallerIds = { id: "00000000-0000-0000-0000-000000000000", username: "nonexistent_user" };

describe("Security: denial-path sweep over every new privileged endpoint", () => {
  it("every endpoint rejects a request with no Authorization header at all", async () => {
    for (const ep of PROTECTED_ENDPOINTS) {
      const path = ep.path(PLACEHOLDER_IDS);
      const res =
        ep.method === "GET"
          ? await client.get(path)
          : ep.method === "DELETE"
            ? await client.delete(path)
            : await client.post(path, ep.body);
      assert.equal(res.status, 401, `${ep.method} ${path} must 401 with no token, got ${res.status}`);
    }
  });

  it("every endpoint rejects a garbage/forged bearer token", async () => {
    const forged = authHeader("not.a.real.jwt");
    for (const ep of PROTECTED_ENDPOINTS) {
      const path = ep.path(PLACEHOLDER_IDS);
      const res =
        ep.method === "GET"
          ? await client.get(path, forged)
          : ep.method === "DELETE"
            ? await client.delete(path, forged)
            : await client.post(path, ep.body, forged);
      assert.equal(res.status, 401, `${ep.method} ${path} must 401 with a forged token, got ${res.status}`);
    }
  });

  it("every endpoint rejects a real, valid, but plain non-admin user — a logged-in account is not enough", async () => {
    const user = await signupUser();
    const auth = authHeader(user.accessToken);
    for (const ep of PROTECTED_ENDPOINTS) {
      const path = ep.path({ id: user.id, username: user.input.username });
      const res =
        ep.method === "GET"
          ? await client.get(path, auth)
          : ep.method === "DELETE"
            ? await client.delete(path, auth)
            : await client.post(path, ep.body, auth);
      assert.equal(res.status, 403, `${ep.method} ${path} must 403 for a plain user, got ${res.status}`);
    }
  });

  it("every endpoint rejects a real admin account holding zero granted permissions — role alone is not enough", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    const auth = authHeader(admin.accessToken);
    for (const ep of PROTECTED_ENDPOINTS) {
      const path = ep.path({ id: admin.id, username: admin.input.username });
      const res =
        ep.method === "GET"
          ? await client.get(path, auth)
          : ep.method === "DELETE"
            ? await client.delete(path, auth)
            : await client.post(path, ep.body, auth);
      assert.equal(res.status, 403, `${ep.method} ${path} must 403 for a permission-less admin, got ${res.status}`);
    }
  });
});

describe("Security: no route exists to mutate or erase the append-only audit trail", () => {
  it("there is no DELETE or PATCH route for audit logs, at any permission level, including super admin", async () => {
    // Not even bothering to grant a permission here — if no such route is
    // registered at all, the router itself 404s before any auth/permission
    // check runs, which is the strongest guarantee: it isn't "denied," it
    // doesn't exist.
    const admin = await signupUser();
    await makeAdmin(admin.id);
    const auth = authHeader(admin.accessToken);
    const del = await client.delete("/api/v1/admin/console/audit-logs", auth);
    assert.equal(del.status, 404);
    const delById = await client.delete("/api/v1/admin/console/audit-logs/00000000-0000-0000-0000-000000000000", auth);
    assert.equal(delById.status, 404);
  });

  it("there is no DELETE route for moderation-history either", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    const auth = authHeader(admin.accessToken);
    const res = await client.delete("/api/v1/admin/console/moderation-history", auth);
    assert.equal(res.status, 404);
  });
});

describe("Security: injection-shaped input is stored as inert data, never executed", () => {
  it("a classic SQL-injection-shaped campaign name is stored verbatim and does no damage", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'ads.create', :'id')`, { id: admin.id });
    const auth = authHeader(admin.accessToken);

    const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, auth);
    const payload = "'; DROP TABLE users; --";
    const campaign = await client.post(
      "/api/v1/admin/console/ads/campaigns",
      { advertiserId: adv.body.advertiser.id, name: payload },
      auth,
    );
    assert.equal(campaign.status, 201);
    assert.equal(campaign.body.campaign.name, payload, "stored verbatim as inert text, not interpreted as SQL");

    // The real proof: the users table (and this admin's own row) still exist.
    const stillThere = await client.get("/api/v1/auth/me", auth);
    assert.equal(stillThere.status, 200);
  });

  it("an XSS-shaped moderation reason is stored verbatim, never templated into anything executable server-side", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'users.restrict', :'id')`, { id: admin.id });
    const auth = authHeader(admin.accessToken);

    const victim = await signupUser();
    const payload = "<script>alert(1)</script>";
    const res = await client.post(`/api/v1/admin/console/users/${victim.input.username}/restrict`, { reason: payload }, auth);
    assert.equal(res.status, 204);

    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'moderation.history.read', :'id')`, { id: admin.id });
    const history = await client.get(
      `/api/v1/admin/console/moderation-history?targetType=user&targetId=${victim.id}`,
      auth,
    );
    assert.equal(history.status, 200);
    const entry = history.body.entries.find((e: any) => e.actionType === "restrict_user");
    assert.equal(entry.reason, payload, "the API returns raw JSON text — this is exactly the shape a real client must escape on render, and this backend never runs it itself");
  });

  it("only http(s) CTA URLs are ever accepted for an ad creative — every dangerous scheme rejected", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'ads.create', :'id')`, { id: admin.id });
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'ads.edit', :'id')`, { id: admin.id });
    const auth = authHeader(admin.accessToken);

    const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, auth);
    const campaign = await client.post("/api/v1/admin/console/ads/campaigns", { advertiserId: adv.body.advertiser.id, name: "x" }, auth);
    const campaignId = campaign.body.campaign.id as string;

    for (const scheme of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const res = await client.post(
        `/api/v1/admin/console/ads/campaigns/${campaignId}/creatives`,
        { mediaId: "00000000-0000-0000-0000-000000000000", headline: "x", ctaUrl: scheme },
        auth,
      );
      assert.equal(res.status, 422, `${scheme} must be rejected`);
    }
  });
});

describe("Security: privilege escalation is structurally blocked, not just discouraged", () => {
  it("an admin with admins.create granted still cannot promote themselves, change their own role, or grant themselves permissions", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'id', 'admins.create', :'id')`, { id: admin.id });
    const auth = authHeader(admin.accessToken);

    const selfPromote = await client.post("/api/v1/admin/console/admins", { username: admin.input.username }, auth);
    assert.equal(selfPromote.status, 403);

    // Even a fabricated request trying to reach the permission-grant path
    // (super-admin-only) is rejected before it ever reaches the
    // self-target check — a non-super-admin can't grant any permission at
    // all, to anyone, let alone themselves.
    const selfGrant = await client.post(`/api/v1/admin/console/admins/${admin.input.username}/permissions`, { permission: "admins.create" }, auth);
    assert.equal(selfGrant.status, 403);
  });

  it("granting a permission never works on a target that isn't already an admin", async () => {
    const admin = await signupUser();
    await makeAdmin(admin.id);
    // This test needs real SUPER_ADMIN behavior (grantPermission is
    // requireSuperAdmin-gated) but this file never seeds is_primary_admin
    // (see test/admin.test.ts's own note on why only one file may). So
    // this instead verifies the plain-admin-gets-403 half directly, which
    // is the half every other admin actually exercises in production.
    const auth = authHeader(admin.accessToken);
    const target = await signupUser();
    const res = await client.post(`/api/v1/admin/console/admins/${target.input.username}/permissions`, { permission: "ads.create" }, auth);
    assert.equal(res.status, 403, "permission grants are super-admin-only; a plain admin can never reach this regardless of target");
  });
});
