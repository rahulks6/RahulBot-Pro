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
  return {
    input,
    accessToken: res.body.tokens.accessToken as string,
    refreshToken: res.body.tokens.refreshToken as string,
    id: res.body.user.id as string,
  };
}

/**
 * There is deliberately no self-serve "become a moderator" endpoint (see
 * moderation.service.ts's requireModerator) — granting it is meant to
 * happen out-of-band, the same way this test does it: a direct DB write,
 * the same technique test/stories.test.ts already uses for a short-TTL
 * Story via storiesService.publishStory reaching one level below the
 * public API for a legitimate bootstrapping need.
 */
async function promoteToModerator(userId: string): Promise<void> {
  await query(`UPDATE users SET is_moderator = true WHERE id = :'id'`, { id: userId });
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

async function publishStory(accessToken: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const mediaId = await uploadPhoto(accessToken);
  const res = await client.post(
    "/api/v1/stories",
    { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true, ...overrides },
    authHeader(accessToken),
  );
  return res.body.story.id as string;
}

describe("filing a report", () => {
  it("reports a Story, a comment, and a user account", async () => {
    const owner = await signupUser();
    const reporter = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const comment = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "spam spam spam" }, authHeader(owner.accessToken));

    const storyReport = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "spam" }, authHeader(reporter.accessToken));
    assert.equal(storyReport.status, 201);
    assert.equal(storyReport.body.report.status, "pending");

    const commentReport = await client.post(
      "/api/v1/reports",
      { targetType: "comment", targetId: comment.body.comment.id, reason: "harassment", details: "not okay" },
      authHeader(reporter.accessToken),
    );
    assert.equal(commentReport.status, 201);

    const userReport = await client.post("/api/v1/reports", { targetType: "user", targetId: owner.id, reason: "other" }, authHeader(reporter.accessToken));
    assert.equal(userReport.status, 201);
  });

  it("rejects reporting your own Story, comment, or account", async () => {
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const comment = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "hi" }, authHeader(owner.accessToken));

    const selfStory = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "other" }, authHeader(owner.accessToken));
    assert.equal(selfStory.status, 400);

    const selfComment = await client.post("/api/v1/reports", { targetType: "comment", targetId: comment.body.comment.id, reason: "other" }, authHeader(owner.accessToken));
    assert.equal(selfComment.status, 400);

    const selfUser = await client.post("/api/v1/reports", { targetType: "user", targetId: owner.id, reason: "other" }, authHeader(owner.accessToken));
    assert.equal(selfUser.status, 400);
  });

  it("404s on a nonexistent or already-deleted target", async () => {
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    await client.delete(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));

    const res = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "spam" }, authHeader(reporter.accessToken));
    assert.equal(res.status, 404);
  });

  it("rejects an invalid reason or targetType with 422", async () => {
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const res = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "not_a_real_reason" }, authHeader(reporter.accessToken));
    assert.equal(res.status, 422);
  });
});

describe("the moderation queue is moderator-only", () => {
  it("denies a non-moderator", async () => {
    const someone = await signupUser();
    const list = await client.get("/api/v1/moderation/reports", authHeader(someone.accessToken));
    assert.equal(list.status, 403);

    const suspend = await client.post(`/api/v1/moderation/users/${someone.input.username}/suspend`, undefined, authHeader(someone.accessToken));
    assert.equal(suspend.status, 403);
  });

  it("lists pending reports oldest-first with denormalized reporter/target info", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "nudity", details: "see attached" }, authHeader(reporter.accessToken));
    await client.post("/api/v1/reports", { targetType: "user", targetId: owner.id, reason: "harassment" }, authHeader(reporter.accessToken));

    const queue = await client.get("/api/v1/moderation/reports?status=pending", authHeader(moderator.accessToken));
    assert.equal(queue.status, 200);
    assert.ok(queue.body.reports.length >= 2);
    const storyEntry = queue.body.reports.find((r: any) => r.targetType === "story" && r.targetId === storyId);
    assert.equal(storyEntry.reporter.username, reporter.input.username);
    assert.equal(storyEntry.target.type, "story");
    assert.equal(storyEntry.target.ownerUsername, owner.input.username);
    assert.equal(storyEntry.details, "see attached");

    const userEntry = queue.body.reports.find((r: any) => r.targetType === "user" && r.targetId === owner.id);
    assert.equal(userEntry.target.type, "user");
    assert.equal(userEntry.target.username, owner.input.username);
  });
});

describe("resolving a report", () => {
  it("dismiss moves it out of the pending queue and into dismissed", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const report = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "other" }, authHeader(reporter.accessToken));
    const reportId = report.body.report.id;

    const resolve = await client.post(`/api/v1/moderation/reports/${reportId}/resolve`, { action: "dismiss", note: "not actually spam" }, authHeader(moderator.accessToken));
    assert.equal(resolve.status, 200);
    assert.equal(resolve.body.report.status, "dismissed");

    const pending = await client.get("/api/v1/moderation/reports?status=pending", authHeader(moderator.accessToken));
    assert.ok(!pending.body.reports.some((r: any) => r.id === reportId));
    const dismissed = await client.get("/api/v1/moderation/reports?status=dismissed", authHeader(moderator.accessToken));
    assert.ok(dismissed.body.reports.some((r: any) => r.id === reportId));

    const reResolve = await client.post(`/api/v1/moderation/reports/${reportId}/resolve`, { action: "dismiss" }, authHeader(moderator.accessToken));
    assert.equal(reResolve.status, 409, "an already-resolved report can't be resolved again");
  });

  it("remove_content actually deletes a reported Story", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const report = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "violence" }, authHeader(reporter.accessToken));

    const resolve = await client.post(`/api/v1/moderation/reports/${report.body.report.id}/resolve`, { action: "remove_content" }, authHeader(moderator.accessToken));
    assert.equal(resolve.status, 200);
    assert.equal(resolve.body.report.status, "actioned");

    const afterRemoval = await client.get(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(afterRemoval.status, 404, "removal is a real soft-delete, gone even to the owner, same as a self-delete");
  });

  it("remove_content actually deletes a reported comment", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const commenter = await signupUser();
    const comment = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "gross" }, authHeader(commenter.accessToken));
    const report = await client.post("/api/v1/reports", { targetType: "comment", targetId: comment.body.comment.id, reason: "harassment" }, authHeader(reporter.accessToken));

    const resolve = await client.post(`/api/v1/moderation/reports/${report.body.report.id}/resolve`, { action: "remove_content" }, authHeader(moderator.accessToken));
    assert.equal(resolve.status, 200);

    const list = await client.get(`/api/v1/stories/${storyId}/comments`, authHeader(owner.accessToken));
    assert.ok(!list.body.comments.some((c: any) => c.id === comment.body.comment.id));
  });

  it("rejects remove_content on a user report, and suspend_user on a story report", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const userReport = await client.post("/api/v1/reports", { targetType: "user", targetId: owner.id, reason: "other" }, authHeader(reporter.accessToken));
    const badRemove = await client.post(`/api/v1/moderation/reports/${userReport.body.report.id}/resolve`, { action: "remove_content" }, authHeader(moderator.accessToken));
    assert.equal(badRemove.status, 400);

    const storyReport = await client.post("/api/v1/reports", { targetType: "story", targetId: storyId, reason: "other" }, authHeader(reporter.accessToken));
    const badSuspend = await client.post(`/api/v1/moderation/reports/${storyReport.body.report.id}/resolve`, { action: "suspend_user" }, authHeader(moderator.accessToken));
    assert.equal(badSuspend.status, 400);
  });

  it("suspend_user actually blocks login and immediately invalidates the user's outstanding refresh token", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const reporter = await signupUser();
    const target = await signupUser();

    const report = await client.post("/api/v1/reports", { targetType: "user", targetId: target.id, reason: "harassment" }, authHeader(reporter.accessToken));
    const resolve = await client.post(`/api/v1/moderation/reports/${report.body.report.id}/resolve`, { action: "suspend_user" }, authHeader(moderator.accessToken));
    assert.equal(resolve.status, 200);

    const login = await client.post("/api/v1/auth/login", { email: target.input.email, password: target.input.password });
    assert.equal(login.status, 401, "a suspended account must not be able to log in");

    const refresh = await client.post("/api/v1/auth/refresh", { refreshToken: target.refreshToken });
    assert.equal(refresh.status, 401, "an outstanding refresh token from before suspension must stop working too");
  });
});

describe("standalone suspend/unsuspend", () => {
  it("suspends and reverses without needing a report on file", async () => {
    const moderator = await signupUser();
    await promoteToModerator(moderator.id);
    const target = await signupUser();

    const suspend = await client.post(`/api/v1/moderation/users/${target.input.username}/suspend`, undefined, authHeader(moderator.accessToken));
    assert.equal(suspend.status, 204);

    const loginWhileSuspended = await client.post("/api/v1/auth/login", { email: target.input.email, password: target.input.password });
    assert.equal(loginWhileSuspended.status, 401);

    const unsuspend = await client.post(`/api/v1/moderation/users/${target.input.username}/unsuspend`, undefined, authHeader(moderator.accessToken));
    assert.equal(unsuspend.status, 204);

    const loginAfterUnsuspend = await client.post("/api/v1/auth/login", { email: target.input.email, password: target.input.password });
    assert.equal(loginAfterUnsuspend.status, 200);
  });
});
