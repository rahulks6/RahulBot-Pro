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
  return { input, accessToken: res.body.tokens.accessToken as string, id: res.body.user.id as string };
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

describe("creating and editing a Highlight", () => {
  it("creates a Highlight from your own Stories and reports a real cover/item count", async () => {
    const owner = await signupUser();
    const storyA = await publishStory(owner.accessToken);
    const storyB = await publishStory(owner.accessToken);

    const res = await client.post("/api/v1/highlights", { title: "Trip", storyIds: [storyA, storyB] }, authHeader(owner.accessToken));
    assert.equal(res.status, 201);
    assert.equal(res.body.highlight.title, "Trip");
    assert.equal(res.body.highlight.itemCount, 2);
    assert.equal(res.body.highlight.items[0].storyId, storyA, "item order follows the given storyIds order");
    assert.equal(res.body.highlight.items[1].storyId, storyB);
    assert.ok(res.body.highlight.coverMediaId, "cover is the first item's media");
  });

  it("rejects creating a Highlight from someone else's Story", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(stranger.accessToken);

    const res = await client.post("/api/v1/highlights", { title: "Not mine", storyIds: [storyId] }, authHeader(owner.accessToken));
    assert.equal(res.status, 404);
  });

  it("rejects an empty storyIds array with 422", async () => {
    const owner = await signupUser();
    const res = await client.post("/api/v1/highlights", { title: "Empty", storyIds: [] }, authHeader(owner.accessToken));
    assert.equal(res.status, 422);
  });

  it("renames and replaces the item set via PATCH, but refuses to empty it", async () => {
    const owner = await signupUser();
    const storyA = await publishStory(owner.accessToken);
    const storyB = await publishStory(owner.accessToken);
    const created = await client.post("/api/v1/highlights", { title: "First", storyIds: [storyA] }, authHeader(owner.accessToken));
    const highlightId = created.body.highlight.id;

    const renamed = await client.patch(`/api/v1/highlights/${highlightId}`, { title: "Renamed" }, authHeader(owner.accessToken));
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.highlight.title, "Renamed");
    assert.equal(renamed.body.highlight.itemCount, 1, "an item-less rename must not touch the item set");

    const replaced = await client.patch(`/api/v1/highlights/${highlightId}`, { storyIds: [storyB] }, authHeader(owner.accessToken));
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.highlight.itemCount, 1);
    assert.equal(replaced.body.highlight.items[0].storyId, storyB);

    const emptied = await client.patch(`/api/v1/highlights/${highlightId}`, { storyIds: [] }, authHeader(owner.accessToken));
    assert.equal(emptied.status, 422, "a Highlight can't be emptied via PATCH — delete it instead");
  });

  it("only the owner can update or delete their Highlight", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const created = await client.post("/api/v1/highlights", { title: "Mine", storyIds: [storyId] }, authHeader(owner.accessToken));
    const highlightId = created.body.highlight.id;

    const strangerPatch = await client.patch(`/api/v1/highlights/${highlightId}`, { title: "Hijacked" }, authHeader(stranger.accessToken));
    assert.equal(strangerPatch.status, 404);

    const strangerDelete = await client.delete(`/api/v1/highlights/${highlightId}`, authHeader(stranger.accessToken));
    assert.equal(strangerDelete.status, 404);

    const ownerDelete = await client.delete(`/api/v1/highlights/${highlightId}`, authHeader(owner.accessToken));
    assert.equal(ownerDelete.status, 204);

    const afterDelete = await client.get(`/api/v1/highlights/${highlightId}`, authHeader(owner.accessToken));
    assert.equal(afterDelete.status, 404);
  });
});

describe("viewing another user's Highlights", () => {
  it("gates the list and detail the same way a private account gates everything else", async () => {
    const owner = await signupUser();
    const follower = await signupUser();
    const stranger = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(owner.accessToken));
    const followRes = await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(follower.accessToken));
    assert.equal(followRes.body.status, "requested", "a private account creates a pending request, not an immediate follow");
    const incoming = await client.get("/api/v1/follow-requests", authHeader(owner.accessToken));
    await client.post(`/api/v1/follow-requests/${incoming.body.requests[0].requestId}/accept`, undefined, authHeader(owner.accessToken));

    const storyId = await publishStory(owner.accessToken);
    const created = await client.post("/api/v1/highlights", { title: "Private", storyIds: [storyId] }, authHeader(owner.accessToken));
    const highlightId = created.body.highlight.id;

    const strangerList = await client.get(`/api/v1/users/${owner.input.username}/highlights`, authHeader(stranger.accessToken));
    assert.equal(strangerList.status, 403);
    const strangerDetail = await client.get(`/api/v1/highlights/${highlightId}`, authHeader(stranger.accessToken));
    assert.equal(strangerDetail.status, 403);

    const followerList = await client.get(`/api/v1/users/${owner.input.username}/highlights`, authHeader(follower.accessToken));
    assert.equal(followerList.status, 200);
    assert.equal(followerList.body.highlights.length, 1);
  });

  it("hides a followers-only item from a non-follower while still counting it for the owner", async () => {
    const owner = await signupUser();
    const nonFollower = await signupUser();
    const publicStoryId = await publishStory(owner.accessToken, { audience: "public" });
    const followersStoryId = await publishStory(owner.accessToken, { audience: "followers" });
    const created = await client.post(
      "/api/v1/highlights",
      { title: "Mixed", storyIds: [publicStoryId, followersStoryId] },
      authHeader(owner.accessToken),
    );
    const highlightId = created.body.highlight.id;

    const asOwner = await client.get(`/api/v1/highlights/${highlightId}`, authHeader(owner.accessToken));
    assert.equal(asOwner.body.highlight.itemCount, 2);

    const asNonFollower = await client.get(`/api/v1/highlights/${highlightId}`, authHeader(nonFollower.accessToken));
    assert.equal(asNonFollower.status, 200, "the Highlight itself is still visible on a public account");
    assert.equal(asNonFollower.body.highlight.itemCount, 1, "only the public item is visible to a non-follower");
    assert.equal(asNonFollower.body.highlight.items[0].storyId, publicStoryId);
  });
});

describe("Highlights survive a Story's normal 24h expiry", () => {
  it("keeps an expired Story reachable through its Highlight for a permitted viewer, while the plain Story endpoint still 404s them", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(viewer.accessToken));

    const mediaId = await uploadPhoto(owner.accessToken);
    const me = await client.get("/api/v1/auth/me", authHeader(owner.accessToken));
    const published = await storiesService.publishStory(
      me.body.user.id,
      { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true, overlays: [], drawing: [], filter: "original", audioMuted: false },
      { ttlSecondsOverride: 1 },
    );

    const created = await client.post("/api/v1/highlights", { title: "Keepsake", storyIds: [published.id] }, authHeader(owner.accessToken));
    const highlightId = created.body.highlight.id;

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const plainFetch = await client.get(`/api/v1/stories/${published.id}`, authHeader(viewer.accessToken));
    assert.equal(plainFetch.status, 404, "the ordinary single-Story endpoint still enforces expiry");

    const viaHighlight = await client.get(`/api/v1/highlights/${highlightId}/items/${published.id}`, authHeader(viewer.accessToken));
    assert.equal(viaHighlight.status, 200, "the Highlight-scoped endpoint bypasses expiry for a real member Story");
    assert.equal(viaHighlight.body.story.id, published.id);

    const mediaFile = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(viewer.accessToken) });
    assert.equal(mediaFile.status, 200, "media access via a Highlight also bypasses expiry, the same rule extended one level deeper");
  });

  it("refuses the Highlight-item endpoint for a real Story that isn't actually a member of that Highlight", async () => {
    const owner = await signupUser();
    const storyInHighlight = await publishStory(owner.accessToken);
    const storyNotInHighlight = await publishStory(owner.accessToken);
    const created = await client.post(
      "/api/v1/highlights",
      { title: "One only", storyIds: [storyInHighlight] },
      authHeader(owner.accessToken),
    );

    const res = await client.get(
      `/api/v1/highlights/${created.body.highlight.id}/items/${storyNotInHighlight}`,
      authHeader(owner.accessToken),
    );
    assert.equal(res.status, 404);
  });
});

describe("deleting a Story removes it from every Highlight", () => {
  it("drops a deleted Story out of its Highlight's item list and item count", async () => {
    const owner = await signupUser();
    const storyA = await publishStory(owner.accessToken);
    const storyB = await publishStory(owner.accessToken);
    const created = await client.post(
      "/api/v1/highlights",
      { title: "Fading", storyIds: [storyA, storyB] },
      authHeader(owner.accessToken),
    );
    const highlightId = created.body.highlight.id;

    const deleteRes = await client.delete(`/api/v1/stories/${storyA}`, authHeader(owner.accessToken));
    assert.equal(deleteRes.status, 204);

    const afterDelete = await client.get(`/api/v1/highlights/${highlightId}`, authHeader(owner.accessToken));
    assert.equal(afterDelete.body.highlight.itemCount, 1);
    assert.equal(afterDelete.body.highlight.items[0].storyId, storyB);
  });
});

async function createHighlight(accessToken: string, title: string): Promise<string> {
  const storyId = await publishStory(accessToken);
  const res = await client.post("/api/v1/highlights", { title, storyIds: [storyId] }, authHeader(accessToken));
  return res.body.highlight.id as string;
}

describe("reordering Highlights", () => {
  it("reorders to exactly the given order and a fresh Highlight still joins the end", async () => {
    const owner = await signupUser();
    const a = await createHighlight(owner.accessToken, "A");
    const b = await createHighlight(owner.accessToken, "B");
    const c = await createHighlight(owner.accessToken, "C");

    const listedBefore = await client.get(`/api/v1/users/${owner.input.username}/highlights`, authHeader(owner.accessToken));
    assert.deepEqual(
      listedBefore.body.highlights.map((h: { id: string }) => h.id),
      [a, b, c],
      "creation order to start",
    );

    const reordered = await client.post("/api/v1/highlights/reorder", { highlightIds: [c, a, b] }, authHeader(owner.accessToken));
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.highlights.map((h: { id: string }) => h.id), [c, a, b]);

    const listedAfter = await client.get(`/api/v1/users/${owner.input.username}/highlights`, authHeader(owner.accessToken));
    assert.deepEqual(listedAfter.body.highlights.map((h: { id: string }) => h.id), [c, a, b], "reorder persists");

    const d = await createHighlight(owner.accessToken, "D");
    const listedWithD = await client.get(`/api/v1/users/${owner.input.username}/highlights`, authHeader(owner.accessToken));
    assert.deepEqual(
      listedWithD.body.highlights.map((h: { id: string }) => h.id),
      [c, a, b, d],
      "a newly-created Highlight joins the end of the existing order, not the start",
    );
  });

  it("rejects a partial or stale set with 422 rather than silently dropping a Highlight", async () => {
    const owner = await signupUser();
    const a = await createHighlight(owner.accessToken, "A");
    const b = await createHighlight(owner.accessToken, "B");

    const missingOne = await client.post("/api/v1/highlights/reorder", { highlightIds: [a] }, authHeader(owner.accessToken));
    assert.equal(missingOne.status, 422);

    const unrelated = await createHighlight((await signupUser()).accessToken, "Stranger's");
    const foreignId = await client.post(
      "/api/v1/highlights/reorder",
      { highlightIds: [a, b, unrelated] },
      authHeader(owner.accessToken),
    );
    assert.equal(foreignId.status, 422, "someone else's Highlight id can't be smuggled into your own order");
  });
});
