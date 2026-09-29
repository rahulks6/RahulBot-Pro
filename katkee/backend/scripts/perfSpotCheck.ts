/**
 * A one-off, honest perf spot-check for Phase 15 — not a load-test suite
 * (the recommendation scoring heuristic is already documented in
 * README.md as "fine at today's scale, revisit as data grows"; this just
 * puts a real number on that claim for the Home feed with today's
 * complexity, including the new ad-interleaving step). Run against a live
 * dev server: `npx ts-node --transpile-only scripts/perfSpotCheck.ts`.
 */
const BASE = "http://localhost:4000";

async function signup(username: string) {
  const res = await fetch(`${BASE}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: "correcthorsebatterystaple", displayName: username }),
  });
  const body = await res.json();
  return { accessToken: body.tokens.accessToken as string, id: body.user.id as string, username };
}

async function uploadPhoto(accessToken: string): Promise<string> {
  // Minimal valid 4x4 RGB PNG, same shape test/fixtures.ts's buildTestPng produces.
  const { execSync } = require("node:child_process");
  const out = execSync(
    `node -e "const {buildTestPng}=require('./dist/test/fixtures'); process.stdout.write(buildTestPng(4,4))"`,
  ) as Buffer;
  const res = await fetch(`${BASE}/api/v1/media/photos`, {
    method: "POST",
    headers: { "Content-Type": "image/png", Authorization: `Bearer ${accessToken}` },
    body: out,
  });
  const body = await res.json();
  return body.media.id as string;
}

async function publishStory(accessToken: string, mediaId: string) {
  await fetch(`${BASE}/api/v1/stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true }),
  });
}

async function follow(accessToken: string, targetUsername: string) {
  await fetch(`${BASE}/api/v1/users/${targetUsername}/follow`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
}

async function timeFeed(accessToken: string, label: string, n: number) {
  const timings: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Date.now();
    await fetch(`${BASE}/api/v1/stories/feed/home`, { headers: { Authorization: `Bearer ${accessToken}` } });
    timings.push(Date.now() - start);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(n * 0.5)];
  const p95 = timings[Math.floor(n * 0.95)] ?? timings[n - 1];
  console.log(`${label}: n=${n} min=${timings[0]}ms p50=${p50}ms p95=${p95}ms max=${timings[n - 1]}ms`);
}

async function main() {
  const suffix = Date.now();
  const CREATOR_COUNT = 25;

  console.log(`Seeding a viewer following ${CREATOR_COUNT} creators, each with one active Story...`);
  const viewer = await signup(`perfviewer${suffix}`);
  for (let i = 0; i < CREATOR_COUNT; i++) {
    const creator = await signup(`perfcreator${suffix}_${i}`);
    const mediaId = await uploadPhoto(creator.accessToken);
    await publishStory(creator.accessToken, mediaId);
    await follow(viewer.accessToken, creator.username);
  }

  await timeFeed(viewer.accessToken, "Home feed, ads disabled (default)", 15);

  console.log("Enabling ads + seeding one active campaign...");
  const admin = await signup(`perfadmin${suffix}`);
  const { execFileSync } = require("node:child_process");
  execFileSync("psql", [
    "-h", "localhost", "-U", "katkee", "-d", "katkee_dev", "-v", "ON_ERROR_STOP=1", "-c",
    `UPDATE users SET role='admin' WHERE id='${admin.id}';
     INSERT INTO admin_permissions (user_id, permission, granted_by) VALUES ('${admin.id}','ads.create','${admin.id}'),('${admin.id}','ads.edit','${admin.id}'),('${admin.id}','ads.review','${admin.id}');
     UPDATE feature_flags SET enabled=true WHERE key IN ('ADS_ENABLED','SPONSORED_STORIES_ENABLED');`,
  ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "" } });

  const adv = await (
    await fetch(`${BASE}/api/v1/admin/console/ads/advertisers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ name: "PerfCheck Co" }),
    })
  ).json();
  const campaign = await (
    await fetch(`${BASE}/api/v1/admin/console/ads/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({ advertiserId: adv.advertiser.id, name: "PerfCheck Campaign" }),
    })
  ).json();
  const adMediaId = await uploadPhoto(admin.accessToken);
  await fetch(`${BASE}/api/v1/admin/console/ads/campaigns/${campaign.campaign.id}/creatives`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({ mediaId: adMediaId, headline: "Spot check", ctaUrl: "https://example.com" }),
  });
  await fetch(`${BASE}/api/v1/admin/console/ads/campaigns/${campaign.campaign.id}/submit`, { method: "POST", headers: { Authorization: `Bearer ${admin.accessToken}` } });
  await fetch(`${BASE}/api/v1/admin/console/ads/campaigns/${campaign.campaign.id}/approve`, { method: "POST", headers: { Authorization: `Bearer ${admin.accessToken}` } });
  await fetch(`${BASE}/api/v1/admin/console/ads/campaigns/${campaign.campaign.id}/activate`, { method: "POST", headers: { Authorization: `Bearer ${admin.accessToken}` } });

  await timeFeed(viewer.accessToken, "Home feed, ads enabled + 1 active campaign", 15);

  // Leave the dev DB flags back at their safe default for anyone else using it.
  execFileSync("psql", [
    "-h", "localhost", "-U", "katkee", "-d", "katkee_dev", "-v", "ON_ERROR_STOP=1", "-c",
    `UPDATE feature_flags SET enabled=false WHERE key IN ('ADS_ENABLED','SPONSORED_STORIES_ENABLED');`,
  ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "" } });

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
