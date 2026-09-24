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

async function publishStory(accessToken: string, overrides: Record<string, unknown> = {}) {
  const mediaId = await uploadPhoto(accessToken);
  const res = await client.post(
    "/api/v1/stories",
    { mediaId, caption: "", audience: "public", allowComments: "everyone", allowSharing: true, ...overrides },
    authHeader(accessToken),
  );
  return res.body.story.id as string;
}

describe("likes", () => {
  it("like is idempotent, unlike removes it, and counts/viewerHasLiked reflect reality", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const like1 = await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));
    assert.equal(like1.status, 204);
    const like2 = await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));
    assert.equal(like2.status, 204, "liking twice must not error");

    const detail = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(detail.body.story.likeCount, 1, "double-liking must not double-count");
    assert.equal(detail.body.story.viewerHasLiked, true);

    const unlike = await client.delete(`/api/v1/stories/${storyId}/like`, authHeader(viewer.accessToken));
    assert.equal(unlike.status, 204);
    const afterUnlike = await client.get(`/api/v1/stories/${storyId}`, authHeader(viewer.accessToken));
    assert.equal(afterUnlike.body.story.likeCount, 0);
    assert.equal(afterUnlike.body.story.viewerHasLiked, false);
  });

  it("liking a Story you can't view is denied the same way viewing it is", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken, { audience: "followers" });
    const res = await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(stranger.accessToken));
    assert.equal(res.status, 403);
  });
});

describe("comments", () => {
  it("creates, lists in order, and reflects in commentCount", async () => {
    const owner = await signupUser();
    const commenter = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const created = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "first!" }, authHeader(commenter.accessToken));
    assert.equal(created.status, 201);
    assert.equal(created.body.comment.body, "first!");
    assert.equal(created.body.comment.username, commenter.input.username);

    await client.post(`/api/v1/stories/${storyId}/comments`, { body: "second" }, authHeader(owner.accessToken));

    const list = await client.get(`/api/v1/stories/${storyId}/comments`, authHeader(owner.accessToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.comments.length, 2);
    assert.equal(list.body.comments[0].body, "first!", "oldest first");

    const detail = await client.get(`/api/v1/stories/${storyId}`, authHeader(owner.accessToken));
    assert.equal(detail.body.story.commentCount, 2);
  });

  it("rejects an empty or all-whitespace comment with 422", async () => {
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    const res = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "   " }, authHeader(owner.accessToken));
    assert.equal(res.status, 422);
  });

  it("'disabled' blocks everyone except the owner", async () => {
    const owner = await signupUser();
    const other = await signupUser();
    const storyId = await publishStory(owner.accessToken, { allowComments: "disabled" });

    const blocked = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "hey" }, authHeader(other.accessToken));
    assert.equal(blocked.status, 403);

    const ownerCan = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "note to self" }, authHeader(owner.accessToken));
    assert.equal(ownerCan.status, 201);
  });

  it("'followers' blocks non-followers, then allows once followed", async () => {
    const owner = await signupUser();
    const other = await signupUser();
    const storyId = await publishStory(owner.accessToken, { allowComments: "followers" });

    const before = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "hey" }, authHeader(other.accessToken));
    assert.equal(before.status, 403);

    await client.post(`/api/v1/users/${owner.input.username}/follow`, undefined, authHeader(other.accessToken));

    const after = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "now I can" }, authHeader(other.accessToken));
    assert.equal(after.status, 201);
  });

  it("deletion: author can delete their own; the Story owner can delete anyone's; a third party cannot", async () => {
    const owner = await signupUser();
    const commenter = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const c1 = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "one" }, authHeader(commenter.accessToken));
    const c2 = await client.post(`/api/v1/stories/${storyId}/comments`, { body: "two" }, authHeader(commenter.accessToken));

    const strangerDelete = await client.delete(`/api/v1/comments/${c1.body.comment.id}`, authHeader(stranger.accessToken));
    assert.equal(strangerDelete.status, 403);

    const selfDelete = await client.delete(`/api/v1/comments/${c1.body.comment.id}`, authHeader(commenter.accessToken));
    assert.equal(selfDelete.status, 204);

    const ownerDelete = await client.delete(`/api/v1/comments/${c2.body.comment.id}`, authHeader(owner.accessToken));
    assert.equal(ownerDelete.status, 204, "the Story owner can moderate comments on their own Story");

    const list = await client.get(`/api/v1/stories/${storyId}/comments`, authHeader(owner.accessToken));
    assert.equal(list.body.comments.length, 0);
  });

  it("reading comments only requires Story view access, not comment-post permission", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken, { allowComments: "disabled" });
    await client.post(`/api/v1/stories/${storyId}/comments`, { body: "note to self" }, authHeader(owner.accessToken));

    const res = await client.get(`/api/v1/stories/${storyId}/comments`, authHeader(viewer.accessToken));
    assert.equal(res.status, 200, "a viewer who can't post can still read existing comments");
    assert.equal(res.body.comments.length, 1);
  });
});

describe("sharing", () => {
  it("succeeds when allowSharing is true and is denied when false", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const shareableStory = await publishStory(owner.accessToken, { allowSharing: true });
    const unshareableStory = await publishStory(owner.accessToken, { allowSharing: false });

    const ok = await client.post(`/api/v1/stories/${shareableStory}/share`, undefined, authHeader(viewer.accessToken));
    assert.equal(ok.status, 204);

    const denied = await client.post(`/api/v1/stories/${unshareableStory}/share`, undefined, authHeader(viewer.accessToken));
    assert.equal(denied.status, 403);
  });

  it("sharing a Story you can't view is denied", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken, { audience: "followers" });
    const res = await client.post(`/api/v1/stories/${storyId}/share`, undefined, authHeader(stranger.accessToken));
    assert.equal(res.status, 403);
  });
});
