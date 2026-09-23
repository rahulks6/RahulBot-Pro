import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, makeClient, uniqueUser } from "./helpers";
import { buildTestPng } from "./fixtures";
import * as storiesService from "../src/modules/stories/stories.service";

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
  return { input, accessToken: res.body.tokens.accessToken as string };
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

async function publishStory(accessToken: string, mediaId: string, overrides: Record<string, unknown> = {}) {
  return client.post(
    "/api/v1/stories",
    { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true, ...overrides },
    authHeader(accessToken),
  );
}

describe("publishing", () => {
  it("publishes an owned, ready media as a Story", async () => {
    const user = await signupUser();
    const mediaId = await uploadPhoto(user.accessToken);
    const res = await publishStory(user.accessToken, mediaId);
    assert.equal(res.status, 201);
    assert.equal(res.body.story.mediaId, mediaId);
    assert.ok(res.body.story.expiresAt);
  });

  it("rejects publishing the same media twice", async () => {
    const user = await signupUser();
    const mediaId = await uploadPhoto(user.accessToken);
    await publishStory(user.accessToken, mediaId);
    const res = await publishStory(user.accessToken, mediaId);
    assert.equal(res.status, 409);
  });

  it("rejects publishing someone else's media", async () => {
    const owner = await signupUser();
    const other = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const res = await publishStory(other.accessToken, mediaId);
    assert.equal(res.status, 404);
  });

  it("rejects an invalid mediaId", async () => {
    const user = await signupUser();
    const res = await publishStory(user.accessToken, "not-a-real-id");
    assert.equal(res.status, 422);
  });
});

describe("viewing and audience rules", () => {
  it("a public Story is visible to a follower and records exactly one view despite repeats", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId);
    const storyId = story.body.story.id;

    const fetched = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(fetched.status, 200);

    await client.post(`/api/v1/stories/${storyId}/view`, undefined, authHeader(viewer.accessToken));
    await client.post(`/api/v1/stories/${storyId}/view`, undefined, authHeader(viewer.accessToken));

    const views = await client.get(`/api/v1/stories/${storyId}/views`, authHeader(owner.accessToken));
    assert.equal(views.body.views, 1);
  });

  it("the owner's own view never counts", async () => {
    const owner = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId);
    const storyId = story.body.story.id;

    await client.post(`/api/v1/stories/${storyId}/view`, undefined, authHeader(owner.accessToken));
    const views = await client.get(`/api/v1/stories/${storyId}/views`, authHeader(owner.accessToken));
    assert.equal(views.body.views, 0);
  });

  it("the view count is visible to any viewer who can watch the Story, not just its owner — but who they are is owner-only", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const stranger = await signupUser();
    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId);
    const storyId = story.body.story.id;
    await client.post(`/api/v1/stories/${storyId}/view`, undefined, authHeader(viewer.accessToken));

    const asViewer = await client.get(`/api/v1/stories/${storyId}/views`, authHeader(viewer.accessToken));
    assert.equal(asViewer.status, 200);
    assert.equal(asViewer.body.views, 1);

    const viewersAsViewer = await client.get(`/api/v1/stories/${storyId}/viewers`, authHeader(viewer.accessToken));
    assert.equal(viewersAsViewer.status, 404);
    const viewersAsStranger = await client.get(`/api/v1/stories/${storyId}/viewers`, authHeader(stranger.accessToken));
    assert.equal(viewersAsStranger.status, 404);

    const viewersAsOwner = await client.get(`/api/v1/stories/${storyId}/viewers`, authHeader(owner.accessToken));
    assert.equal(viewersAsOwner.status, 200);
    assert.equal(viewersAsOwner.body.viewers.length, 1);
    assert.equal(viewersAsOwner.body.viewers[0].username, viewer.input.username);
  });

  it("a stranger can't see the view count of a Story they aren't allowed to watch", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId, { audience: "followers" });

    const res = await client.get(`/api/v1/stories/${story.body.story.id}/views`, authHeader(stranger.accessToken));
    assert.equal(res.status, 403);
  });

  it("a private account gates every Story regardless of its own audience setting, until followed", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(owner.accessToken));

    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId, { audience: "public" });
    const storyId = story.body.story.id;

    const blocked = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(blocked.status, 403);
    const blockedList = await client.get(`/api/v1/users/${owner.input.username}/stories`, authHeader(viewer.accessToken));
    assert.equal(blockedList.status, 403);

    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));
    const incoming = await client.get("/api/v1/follow-requests", authHeader(owner.accessToken));
    await client.post(`/api/v1/follow-requests/${incoming.body.requests[0].requestId}/accept`, undefined, authHeader(owner.accessToken));

    const nowVisible = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(nowVisible.status, 200);
  });

  it("a 'followers' audience Story on a public account is hidden from non-followers", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId, { audience: "followers" });
    const storyId = story.body.story.id;

    const res = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(res.status, 403);
  });

  it("blocked users get 404, not 403, for each other's Stories", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId);
    await client.post(`/api/v1/users/${viewer.input.username}/block`, undefined, authHeader(owner.accessToken));

    const res = await client.get(`/api/v1/stories/${story.body.story.id}`, authHeader(viewer.accessToken));
    assert.equal(res.status, 404);
  });
});

describe("owner-username lookup", () => {
  it("resolves a Story's owner username for anyone permitted to view it, using the same access rules as the Story itself", async () => {
    const owner = await signupUser();
    const follower = await signupUser();
    const stranger = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId, { audience: "followers" });
    const storyId = story.body.story.id;

    const asOwner = await client.get(`/api/v1/stories/${storyId}/owner`, authHeader(owner.accessToken));
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.username, owner.input.username);

    const asStranger = await client.get(`/api/v1/stories/${storyId}/owner`, authHeader(stranger.accessToken));
    assert.equal(asStranger.status, 403, "a non-follower is denied the same way viewing the Story itself is");

    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(follower.accessToken));
    const asFollower = await client.get(`/api/v1/stories/${storyId}/owner`, authHeader(follower.accessToken));
    assert.equal(asFollower.status, 200);
    assert.equal(asFollower.body.username, owner.input.username);
  });
});

describe("media access via a published Story", () => {
  it("lets a permitted viewer fetch the underlying media file, byte-for-byte", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const original = buildTestPng(6, 6);

    const uploadRes = await fetch(`${baseUrl}/api/v1/media/photos`, {
      method: "POST",
      headers: { "Content-Type": "image/png", ...authHeader(owner.accessToken) },
      body: original,
    });
    const mediaId = ((await uploadRes.json()) as { media: { id: string } }).media.id;
    await publishStory(owner.accessToken, mediaId, { audience: "followers" });

    const asOwner = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(owner.accessToken) });
    assert.equal(asOwner.status, 200);

    const beforeFollow = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(viewer.accessToken) });
    assert.equal(beforeFollow.status, 404, "a non-follower can't fetch media for a followers-only Story");

    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));
    const asViewer = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(viewer.accessToken) });
    assert.equal(asViewer.status, 200);
    const bytes = Buffer.from(await asViewer.arrayBuffer());
    assert.ok(bytes.equals(original), "media served through a Story must still be byte-identical");
  });

  it("still denies media access when no Story exists for it at all", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken); // never published as a Story
    const res = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(stranger.accessToken) });
    assert.equal(res.status, 404);
  });
});

describe("deletion", () => {
  it("only the owner can delete, and deletion is final even for the owner", async () => {
    const owner = await signupUser();
    const other = await signupUser();
    const mediaId = await uploadPhoto(owner.accessToken);
    const story = await publishStory(owner.accessToken, mediaId);
    const storyId = story.body.story.id;

    const wrongDelete = await client.delete(`/api/v1/stories/${storyId}`, authHeader(other.accessToken));
    assert.equal(wrongDelete.status, 404);

    const ownerDelete = await client.delete(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(ownerDelete.status, 204);

    const afterDelete = await client.get(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(afterDelete.status, 404, "a deleted Story is gone even to its own owner");
  });
});

describe("feeds and listings", () => {
  it("mine/active only lists the caller's own non-expired Stories, oldest first", async () => {
    const owner = await signupUser();
    const media1 = await uploadPhoto(owner.accessToken);
    await publishStory(owner.accessToken, media1);
    const media2 = await uploadPhoto(owner.accessToken);
    await publishStory(owner.accessToken, media2);

    const res = await client.get("/api/v1/stories/mine/active", authHeader(owner.accessToken));
    assert.equal(res.status, 200);
    assert.equal(res.body.stories.length, 2);
    assert.ok(res.body.stories[0].createdAt <= res.body.stories[1].createdAt);
  });

  it("the following feed includes only followed owners (and self), not strangers", async () => {
    const viewer = await signupUser();
    const followed = await signupUser();
    const stranger = await signupUser();
    await client.post(`/api/v1/users/${followed.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    await publishStory(followed.accessToken, await uploadPhoto(followed.accessToken));
    await publishStory(stranger.accessToken, await uploadPhoto(stranger.accessToken));

    const feed = await client.get("/api/v1/stories/feed/following", authHeader(viewer.accessToken));
    const owners = feed.body.feed.map((e: any) => e.owner.username);
    assert.ok(owners.includes(followed.input.username));
    assert.ok(!owners.includes(stranger.input.username));
  });
});

describe("the 24-hour lifecycle", () => {
  it("really expires: a Story published with a 1-second TTL becomes inaccessible to others and drops out of active listings, while the owner can still fetch it directly", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    const mediaId = await uploadPhoto(owner.accessToken);
    const me = await client.get("/api/v1/auth/me", authHeader(owner.accessToken));
    const published = await storiesService.publishStory(
      me.body.user.id,
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true },
      { ttlSecondsOverride: 1 },
    );

    const beforeExpiry = await client.get(`/api/v1/stories/${published.id}`, authHeader(viewer.accessToken));
    assert.equal(beforeExpiry.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const afterExpiry = await client.get(`/api/v1/stories/${published.id}`, authHeader(viewer.accessToken));
    assert.equal(afterExpiry.status, 404, "an expired Story must not be visible to anyone else");

    const activeList = await client.get("/api/v1/stories/mine/active", authHeader(owner.accessToken));
    assert.ok(
      !activeList.body.stories.some((s: any) => s.id === published.id),
      "an expired Story must not appear in the owner's own active list",
    );

    const ownerFetch = await client.get(`/api/v1/stories/${published.id}`, authHeader(owner.accessToken));
    assert.equal(ownerFetch.status, 200, "the owner can still fetch their own expired Story directly (Archive foundation)");
  });
});
