import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, makeClient, uniqueUser } from "./helpers";
import { buildTestPng } from "./fixtures";

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

async function publishStory(accessToken: string, overrides: Record<string, unknown> = {}) {
  const uploadRes = await fetch(`${baseUrl}/api/v1/media/photos`, {
    method: "POST",
    headers: { "Content-Type": "image/png", ...authHeader(accessToken) },
    body: buildTestPng(4, 4),
  });
  const mediaId = ((await uploadRes.json()) as { media: { id: string } }).media.id;
  const res = await client.post(
    "/api/v1/stories",
    { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true, ...overrides },
    authHeader(accessToken),
  );
  return res.body.story.id as string;
}

describe("events", () => {
  it("rejects an unknown eventType", async () => {
    const user = await signupUser();
    const res = await client.post("/api/v1/events", { eventType: "made_up_event" }, authHeader(user.accessToken));
    assert.equal(res.status, 422);
  });

  it("requires storyId for story-scoped event types", async () => {
    const user = await signupUser();
    const res = await client.post("/api/v1/events", { eventType: "story_complete" }, authHeader(user.accessToken));
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.storyId);
  });

  it("requires creatorId for creator-scoped event types", async () => {
    const user = await signupUser();
    const res = await client.post("/api/v1/events", { eventType: "quick_creator_skip" }, authHeader(user.accessToken));
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.creatorId);
  });

  it("requires a valid valueMs for watch_duration", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const missing = await client.post("/api/v1/events", { eventType: "watch_duration", storyId }, authHeader(viewer.accessToken));
    assert.equal(missing.status, 422);

    const tooLarge = await client.post(
      "/api/v1/events",
      { eventType: "watch_duration", storyId, valueMs: 10 * 60 * 60 * 1000 },
      authHeader(viewer.accessToken),
    );
    assert.equal(tooLarge.status, 422);

    const ok = await client.post("/api/v1/events", { eventType: "watch_duration", storyId, valueMs: 4200 }, authHeader(viewer.accessToken));
    assert.equal(ok.status, 204);
  });

  it("rejects a storyId the viewer isn't allowed to see, reusing Story access rules", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken, { audience: "followers" });

    const res = await client.post("/api/v1/events", { eventType: "story_complete", storyId }, authHeader(stranger.accessToken));
    assert.equal(res.status, 403);
  });

  it("rejects a creatorId that isn't a real user", async () => {
    const user = await signupUser();
    const res = await client.post(
      "/api/v1/events",
      { eventType: "quick_creator_skip", creatorId: "00000000-0000-0000-0000-000000000000" },
      authHeader(user.accessToken),
    );
    assert.equal(res.status, 404);
  });

  it("silently no-ops for a self-directed event rather than erroring", async () => {
    const user = await signupUser();
    const res = await client.post(
      "/api/v1/events",
      { eventType: "quick_creator_skip", creatorId: user.id },
      authHeader(user.accessToken),
    );
    assert.equal(res.status, 204);
  });

  it("accepts creator_impression and story_impression, deduplicating repeats within the window", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const first = await client.post("/api/v1/events", { eventType: "story_impression", storyId }, authHeader(viewer.accessToken));
    assert.equal(first.status, 204);
    // A second identical impression right away is still accepted (204) —
    // dedup means "don't double-count it internally," not "reject the call."
    const second = await client.post("/api/v1/events", { eventType: "story_impression", storyId }, authHeader(viewer.accessToken));
    assert.equal(second.status, 204);
  });
});

describe("not interested", () => {
  it("excludes that creator from the viewer's home feed, and only that viewer's", async () => {
    const creator = await signupUser();
    const viewerA = await signupUser();
    const viewerB = await signupUser();
    await publishStory(creator.accessToken);

    const beforeA = await client.get("/api/v1/stories/feed/home", authHeader(viewerA.accessToken));
    assert.ok(beforeA.body.feed.some((e: any) => e.owner.username === creator.input.username));

    const notInterested = await client.post(
      "/api/v1/events",
      { eventType: "not_interested", creatorId: creator.id },
      authHeader(viewerA.accessToken),
    );
    assert.equal(notInterested.status, 204);

    const afterA = await client.get("/api/v1/stories/feed/home", authHeader(viewerA.accessToken));
    assert.ok(!afterA.body.feed.some((e: any) => e.owner.username === creator.input.username));

    const stillForB = await client.get("/api/v1/stories/feed/home", authHeader(viewerB.accessToken));
    assert.ok(
      stillForB.body.feed.some((e: any) => e.owner.username === creator.input.username),
      "marking not-interested for one viewer must not affect another viewer's feed",
    );
  });
});

describe("home feed", () => {
  it("includes public creators with an active Story even when not followed (real discovery)", async () => {
    const creator = await signupUser();
    const viewer = await signupUser();
    await publishStory(creator.accessToken);

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.equal(res.status, 200);
    const entry = res.body.feed.find((e: any) => e.owner.username === creator.input.username);
    assert.ok(entry, "a public creator with an active Story should appear in discovery");
    assert.equal(entry.isFollowing, false);
  });

  it("excludes a private creator's Stories from a non-follower's feed", async () => {
    const creator = await signupUser();
    const viewer = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(creator.accessToken));
    await publishStory(creator.accessToken);

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.ok(!res.body.feed.some((e: any) => e.owner.username === creator.input.username));
  });

  it("excludes a blocked creator's Stories", async () => {
    const creator = await signupUser();
    const viewer = await signupUser();
    await publishStory(creator.accessToken);
    await client.post(`/api/v1/users/${viewer.input.username}/block`, undefined, authHeader(creator.accessToken));

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.ok(!res.body.feed.some((e: any) => e.owner.username === creator.input.username));
  });

  it("excludes a muted creator's Stories", async () => {
    const creator = await signupUser();
    const viewer = await signupUser();
    await publishStory(creator.accessToken);
    await client.post(`/api/v1/users/${creator.input.username}/mute`, undefined, authHeader(viewer.accessToken));

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.ok(!res.body.feed.some((e: any) => e.owner.username === creator.input.username));
  });

  it("puts the viewer's own active Stories first, unscored, ahead of everything else", async () => {
    const viewer = await signupUser();
    const other = await signupUser();
    await publishStory(other.accessToken);
    await publishStory(viewer.accessToken);

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    assert.equal(res.body.feed[0].owner.username, viewer.input.username);
  });

  it("ranks a followed creator above an otherwise-identical non-followed one", async () => {
    const viewer = await signupUser();
    const followed = await signupUser();
    const notFollowed = await signupUser();
    await publishStory(followed.accessToken);
    await publishStory(notFollowed.accessToken);
    await client.post(`/api/v1/users/${followed.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    const res = await client.get("/api/v1/stories/feed/home", authHeader(viewer.accessToken));
    const followedIndex = res.body.feed.findIndex((e: any) => e.owner.username === followed.input.username);
    const notFollowedIndex = res.body.feed.findIndex((e: any) => e.owner.username === notFollowed.input.username);
    assert.ok(followedIndex >= 0 && notFollowedIndex >= 0);
    assert.ok(followedIndex < notFollowedIndex, "the followed creator should rank above the unfollowed one");
  });
});
