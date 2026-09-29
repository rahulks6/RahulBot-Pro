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

/** See test/admin-console.test.ts's own note: plain 'admin' role + admin_permissions rows, never is_primary_admin. */
async function makeAdminWithPermissions(userId: string, permissions: string[]): Promise<void> {
  await query(`UPDATE users SET role = 'admin' WHERE id = :'id'`, { id: userId });
  for (const permission of permissions) {
    await query(`INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES (:'user_id', :'permission', :'granted_by')`, {
      user_id: userId,
      permission,
      granted_by: userId,
    });
  }
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

async function makeApprovedCampaign(admin: { accessToken: string }): Promise<{ campaignId: string; creativeId: string }> {
  const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme " + Date.now() }, authHeader(admin.accessToken));
  const campaign = await client.post(
    "/api/v1/admin/console/ads/campaigns",
    { advertiserId: adv.body.advertiser.id, name: "Campaign " + Date.now() },
    authHeader(admin.accessToken),
  );
  const campaignId = campaign.body.campaign.id as string;
  const mediaId = await uploadPhoto(admin.accessToken);
  const creative = await client.post(
    `/api/v1/admin/console/ads/campaigns/${campaignId}/creatives`,
    { mediaId, headline: "Big Sale", ctaUrl: "https://example.com" },
    authHeader(admin.accessToken),
  );
  await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/submit`, undefined, authHeader(admin.accessToken));
  await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/approve`, undefined, authHeader(admin.accessToken));
  return { campaignId, creativeId: creative.body.creative.id as string };
}

describe("Ads: campaign/creative backend", () => {
  it("creating an advertiser and a campaign is gated by ads.create", async () => {
    const admin = await signupUser();
    await query(`UPDATE users SET role = 'admin' WHERE id = :'id'`, { id: admin.id });
    const denied = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, authHeader(admin.accessToken));
    assert.equal(denied.status, 403);

    await makeAdminWithPermissions(admin.id, ["ads.create"]);
    const ok = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, authHeader(admin.accessToken));
    assert.equal(ok.status, 201);
  });

  it("rejects a creative with an unsafe CTA URL", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit"]);
    const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, authHeader(admin.accessToken));
    const campaign = await client.post(
      "/api/v1/admin/console/ads/campaigns",
      { advertiserId: adv.body.advertiser.id, name: "Campaign" },
      authHeader(admin.accessToken),
    );
    const mediaId = await uploadPhoto(admin.accessToken);

    const badScheme = await client.post(
      `/api/v1/admin/console/ads/campaigns/${campaign.body.campaign.id}/creatives`,
      { mediaId, headline: "x", ctaUrl: "javascript:alert(1)" },
      authHeader(admin.accessToken),
    );
    assert.equal(badScheme.status, 422);

    const notAUrl = await client.post(
      `/api/v1/admin/console/ads/campaigns/${campaign.body.campaign.id}/creatives`,
      { mediaId, headline: "x", ctaUrl: "not a url" },
      authHeader(admin.accessToken),
    );
    assert.equal(notAUrl.status, 422);
  });

  it("walks the full campaign state machine and rejects out-of-order transitions", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review", "ads.pause"]);

    const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, authHeader(admin.accessToken));
    const campaign = await client.post(
      "/api/v1/admin/console/ads/campaigns",
      { advertiserId: adv.body.advertiser.id, name: "Campaign" },
      authHeader(admin.accessToken),
    );
    const campaignId = campaign.body.campaign.id as string;
    assert.equal(campaign.body.campaign.status, "draft");

    const activateTooSoon = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));
    assert.equal(activateTooSoon.status, 409);

    const submitEmpty = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/submit`, undefined, authHeader(admin.accessToken));
    assert.equal(submitEmpty.status, 409, "can't submit for review with zero creatives");

    const mediaId = await uploadPhoto(admin.accessToken);
    await client.post(
      `/api/v1/admin/console/ads/campaigns/${campaignId}/creatives`,
      { mediaId, headline: "Big Sale", ctaUrl: "https://example.com" },
      authHeader(admin.accessToken),
    );

    const submit = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/submit`, undefined, authHeader(admin.accessToken));
    assert.equal(submit.status, 200);
    assert.equal(submit.body.campaign.status, "pending_review");

    const doubleSubmit = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/submit`, undefined, authHeader(admin.accessToken));
    assert.equal(doubleSubmit.status, 409, "already pending_review, not draft — optimistic-locked transition rejects it");

    const approve = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/approve`, undefined, authHeader(admin.accessToken));
    assert.equal(approve.status, 200);
    assert.equal(approve.body.campaign.status, "approved");

    const activate = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));
    assert.equal(activate.status, 200);
    assert.equal(activate.body.campaign.status, "active");

    const pause = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/pause`, undefined, authHeader(admin.accessToken));
    assert.equal(pause.status, 200);
    assert.equal(pause.body.campaign.status, "paused");

    const reactivate = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));
    assert.equal(reactivate.status, 200, "paused -> active is a valid transition (resuming)");

    const complete = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/complete`, undefined, authHeader(admin.accessToken));
    assert.equal(complete.status, 200);
    assert.equal(complete.body.campaign.status, "completed");
  });

  it("rejecting a campaign requires a reason and moves it to 'rejected'", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review"]);
    const adv = await client.post("/api/v1/admin/console/ads/advertisers", { name: "Acme" }, authHeader(admin.accessToken));
    const campaign = await client.post(
      "/api/v1/admin/console/ads/campaigns",
      { advertiserId: adv.body.advertiser.id, name: "Campaign" },
      authHeader(admin.accessToken),
    );
    const campaignId = campaign.body.campaign.id as string;
    const mediaId = await uploadPhoto(admin.accessToken);
    await client.post(
      `/api/v1/admin/console/ads/campaigns/${campaignId}/creatives`,
      { mediaId, headline: "x", ctaUrl: "https://example.com" },
      authHeader(admin.accessToken),
    );
    await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/submit`, undefined, authHeader(admin.accessToken));

    const noReason = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/reject`, {}, authHeader(admin.accessToken));
    assert.equal(noReason.status, 422);

    const reject = await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/reject`, { reason: "low quality" }, authHeader(admin.accessToken));
    assert.equal(reject.status, 200);
    assert.equal(reject.body.campaign.status, "rejected");
    assert.equal(reject.body.campaign.rejectionReason, "low quality");
  });

  it("records real ad events and reports real, non-fabricated analytics counts", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review", "ads.analytics.read"]);
    const { campaignId, creativeId } = await makeApprovedCampaign(admin);
    await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));

    const viewer = await signupUser();
    await client.post("/api/v1/ads/events", { campaignId, creativeId, eventType: "impression" }, authHeader(viewer.accessToken));
    await client.post("/api/v1/ads/events", { campaignId, creativeId, eventType: "impression" }, authHeader(viewer.accessToken));
    await client.post("/api/v1/ads/events", { campaignId, creativeId, eventType: "click" }, authHeader(viewer.accessToken));

    const analytics = await client.get(`/api/v1/admin/console/ads/campaigns/${campaignId}/analytics`, authHeader(admin.accessToken));
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.analytics.impressions, 2);
    assert.equal(analytics.body.analytics.clicks, 1);
    assert.equal(analytics.body.analytics.hides, 0);
  });

  it("rejects an ad event whose creativeId doesn't belong to the given campaignId", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review"]);
    const first = await makeApprovedCampaign(admin);
    const second = await makeApprovedCampaign(admin);
    const viewer = await signupUser();

    const res = await client.post(
      "/api/v1/ads/events",
      { campaignId: first.campaignId, creativeId: second.creativeId, eventType: "impression" },
      authHeader(viewer.accessToken),
    );
    assert.equal(res.status, 404);
  });

  it("hiding an ad stops it from being selected for that viewer's feed again", async () => {
    // Earlier tests in this file activate campaigns of their own and never
    // pause them — selectSponsoredSlots round-robins across every eligible
    // active campaign, so without this, a slot could land on one of theirs
    // instead of this test's own. Pausing them first makes this test's
    // campaign the only eligible one, independent of test execution order.
    await query(`UPDATE ad_campaigns SET status = 'paused' WHERE status = 'active'`, {});

    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review"]);
    const { campaignId, creativeId } = await makeApprovedCampaign(admin);
    await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));

    await query(`UPDATE feature_flags SET enabled = true WHERE key IN ('ADS_ENABLED', 'SPONSORED_STORIES_ENABLED')`, {});
    await query(`UPDATE ad_settings SET min_organic_between_ads = 0, max_ads_per_session = 3 WHERE id = 1`, {});
    try {
      const viewer = await signupUser();
      const mediaId = await uploadPhoto(viewer.accessToken);
      await client.post(
        "/api/v1/stories",
        { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
        authHeader(viewer.accessToken),
      );

      const before = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
      assert.ok(before.body.feed.some((e: any) => e.kind === "sponsored" && e.campaignId === campaignId), "sponsored slot appears before hiding");

      await client.post("/api/v1/ads/events", { campaignId, creativeId, eventType: "hide" }, authHeader(viewer.accessToken));

      const after = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
      assert.ok(!after.body.feed.some((e: any) => e.kind === "sponsored" && e.campaignId === campaignId), "hidden campaign never reappears for this viewer");
    } finally {
      await query(`UPDATE feature_flags SET enabled = false WHERE key IN ('ADS_ENABLED', 'SPONSORED_STORIES_ENABLED')`, {});
    }
  });

  it("with ads disabled, the Home feed is exactly what it would be with no ads module at all", async () => {
    const admin = await signupUser();
    await makeAdminWithPermissions(admin.id, ["ads.create", "ads.edit", "ads.review"]);
    const { campaignId } = await makeApprovedCampaign(admin);
    await client.post(`/api/v1/admin/console/ads/campaigns/${campaignId}/activate`, undefined, authHeader(admin.accessToken));

    const viewer = await signupUser();
    const mediaId = await uploadPhoto(viewer.accessToken);
    await client.post(
      "/api/v1/stories",
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      authHeader(viewer.accessToken),
    );

    const feed = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.ok(!feed.body.feed.some((e: any) => e.kind === "sponsored"), "ADS_ENABLED/SPONSORED_STORIES_ENABLED default off — no sponsored entries appear");
    assert.ok(feed.body.feed.every((e: any) => e.kind === "organic"), "every entry is tagged 'organic' even with ads off entirely");
  });
});
