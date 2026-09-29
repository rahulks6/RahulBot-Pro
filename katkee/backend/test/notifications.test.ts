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

async function listNotifications(accessToken: string) {
  const res = await client.get("/api/v1/notifications", authHeader(accessToken));
  return res.body.notifications as any[];
}

describe("notifications — likes and comments", () => {
  it("a like fires exactly one notification, even when the like endpoint is called repeatedly", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));
    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));
    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));

    const notifications = await listNotifications(owner.accessToken);
    const likeNotifications = notifications.filter((n) => n.type === "like" && n.story?.id === storyId);
    assert.equal(likeNotifications.length, 1, "an idempotent repeat like must not duplicate the notification");
    assert.equal(likeNotifications[0].actor.username, viewer.input.username);
    assert.equal(likeNotifications[0].readAt, null);
  });

  it("liking your own Story does not notify yourself", async () => {
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(owner.accessToken));

    const notifications = await listNotifications(owner.accessToken);
    assert.ok(!notifications.some((n) => n.type === "like"), "self-likes must not notify");
  });

  it("a comment fires a comment notification to the Story owner", async () => {
    const owner = await signupUser();
    const commenter = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const created = await client.post(
      `/api/v1/stories/${storyId}/comments`,
      { body: "nice one" },
      authHeader(commenter.accessToken),
    );

    const notifications = await listNotifications(owner.accessToken);
    const commentNotifications = notifications.filter((n) => n.type === "comment");
    assert.equal(commentNotifications.length, 1);
    assert.equal(commentNotifications[0].actor.username, commenter.input.username);
    assert.equal(commentNotifications[0].comment.id, created.body.comment.id);
  });

  it("commenting on your own Story does not notify yourself", async () => {
    const owner = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    await client.post(`/api/v1/stories/${storyId}/comments`, { body: "note to self" }, authHeader(owner.accessToken));

    const notifications = await listNotifications(owner.accessToken);
    assert.ok(!notifications.some((n) => n.type === "comment"), "self-comments must not notify");
  });

  it("@mentioning a real, distinct user in a comment notifies them; unknown usernames and self-mentions are ignored", async () => {
    const owner = await signupUser();
    const commenter = await signupUser();
    const mentioned = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    await client.post(
      `/api/v1/stories/${storyId}/comments`,
      { body: `hey @${mentioned.input.username} and @nobody_such_user_exists and @${commenter.input.username}` },
      authHeader(commenter.accessToken),
    );

    const mentionedNotifications = await listNotifications(mentioned.accessToken);
    const mentions = mentionedNotifications.filter((n) => n.type === "mention");
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].actor.username, commenter.input.username);

    const commenterNotifications = await listNotifications(commenter.accessToken);
    assert.ok(!commenterNotifications.some((n) => n.type === "mention"), "self-mention must not notify");
  });
});

describe("notifications — follow", () => {
  it("following a public account notifies them; following a private one notifies a follow request instead", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const carol = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));

    await client.post(`/api/v1/users/${bob.input.username}/follow`, undefined, authHeader(alice.accessToken));
    const bobNotifications = await listNotifications(bob.accessToken);
    const followNotifications = bobNotifications.filter((n) => n.type === "follow");
    assert.equal(followNotifications.length, 1);
    assert.equal(followNotifications[0].actor.username, alice.input.username);

    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));
    const carolNotifications = await listNotifications(carol.accessToken);
    const requestNotifications = carolNotifications.filter((n) => n.type === "follow_request");
    assert.equal(requestNotifications.length, 1);
    assert.equal(requestNotifications[0].actor.username, alice.input.username);
    assert.ok(!carolNotifications.some((n) => n.type === "follow"), "a private-account follow must not fire an immediate follow notification");
  });

  it("accepting a follow request notifies the original requester that they're now following", async () => {
    const alice = await signupUser();
    const carol = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));
    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));

    const incoming = await client.get("/api/v1/follow-requests", authHeader(carol.accessToken));
    const requestId = incoming.body.requests[0].requestId;
    await client.post(`/api/v1/follow-requests/${requestId}/accept`, undefined, authHeader(carol.accessToken));

    const aliceNotifications = await listNotifications(alice.accessToken);
    const followNotifications = aliceNotifications.filter((n) => n.type === "follow");
    assert.equal(followNotifications.length, 1);
    assert.equal(followNotifications[0].actor.username, carol.input.username);
  });

  it("re-requesting a follow while already pending does not duplicate the follow_request notification", async () => {
    const alice = await signupUser();
    const carol = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));

    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));
    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));

    const carolNotifications = await listNotifications(carol.accessToken);
    assert.equal(carolNotifications.filter((n) => n.type === "follow_request").length, 1);
  });
});

describe("notifications — pagination, unread count, and mark-read", () => {
  it("unread count reflects reality, mark-one-read only affects that notification, mark-all-read clears everything", async () => {
    const owner = await signupUser();
    const viewer1 = await signupUser();
    const viewer2 = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer1.accessToken));
    await client.post(`/api/v1/stories/${storyId}/comments`, { body: "hi" }, authHeader(viewer2.accessToken));

    const countRes = await client.get("/api/v1/notifications/unread-count", authHeader(owner.accessToken));
    assert.equal(countRes.body.count, 2);

    const notifications = await listNotifications(owner.accessToken);
    assert.equal(notifications.length, 2);
    assert.ok(new Date(notifications[0].createdAt) >= new Date(notifications[1].createdAt), "newest first");

    const oneId = notifications[0].id;
    const markOne = await client.post(`/api/v1/notifications/${oneId}/read`, undefined, authHeader(owner.accessToken));
    assert.equal(markOne.status, 204);

    const afterOne = await client.get("/api/v1/notifications/unread-count", authHeader(owner.accessToken));
    assert.equal(afterOne.body.count, 1, "marking one read must not affect the other");

    const markAll = await client.post("/api/v1/notifications/read-all", undefined, authHeader(owner.accessToken));
    assert.equal(markAll.status, 204);

    const afterAll = await client.get("/api/v1/notifications/unread-count", authHeader(owner.accessToken));
    assert.equal(afterAll.body.count, 0);

    const finalList = await listNotifications(owner.accessToken);
    assert.ok(finalList.every((n) => n.readAt !== null));
  });

  it("marking read is ownership-scoped — a notification can only be marked read by its recipient", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const stranger = await signupUser();
    const storyId = await publishStory(owner.accessToken);
    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));

    const notifications = await listNotifications(owner.accessToken);
    const id = notifications[0].id;

    await client.post(`/api/v1/notifications/${id}/read`, undefined, authHeader(stranger.accessToken));

    const ownerNotifications = await listNotifications(owner.accessToken);
    assert.equal(ownerNotifications[0].readAt, null, "a non-recipient's mark-read call must be a silent no-op, not mutate someone else's notification");
  });

  it("rejects a malformed notification id with 404 rather than erroring", async () => {
    const owner = await signupUser();
    const res = await client.post("/api/v1/notifications/not-a-uuid/read", undefined, authHeader(owner.accessToken));
    assert.equal(res.status, 404);
  });

  it("paginates with limit/offset", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyA = await publishStory(owner.accessToken);
    const storyB = await publishStory(owner.accessToken);
    await client.post(`/api/v1/stories/${storyA}/like`, undefined, authHeader(viewer.accessToken));
    await client.post(`/api/v1/stories/${storyB}/like`, undefined, authHeader(viewer.accessToken));

    const page1 = await client.get("/api/v1/notifications?limit=1&offset=0", authHeader(owner.accessToken));
    assert.equal(page1.body.notifications.length, 1);
    const page2 = await client.get("/api/v1/notifications?limit=1&offset=1", authHeader(owner.accessToken));
    assert.equal(page2.body.notifications.length, 1);
    assert.notEqual(page1.body.notifications[0].id, page2.body.notifications[0].id);
  });
});

describe("notifications — preferences", () => {
  it("default preferences are all-enabled when the user has never touched them", async () => {
    const owner = await signupUser();
    const res = await client.get("/api/v1/notifications/preferences", authHeader(owner.accessToken));
    assert.deepEqual(res.body.preferences, {
      likesEnabled: true,
      commentsEnabled: true,
      followsEnabled: true,
      mentionsEnabled: true,
    });
  });

  it("turning off likes suppresses only like notifications, leaving comments unaffected", async () => {
    const owner = await signupUser();
    const viewer = await signupUser();
    const storyId = await publishStory(owner.accessToken);

    const patchRes = await client.patch(
      "/api/v1/notifications/preferences",
      { likesEnabled: false },
      authHeader(owner.accessToken),
    );
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.preferences.likesEnabled, false);
    assert.equal(patchRes.body.preferences.commentsEnabled, true, "unspecified fields are left untouched, not reset");

    await client.post(`/api/v1/stories/${storyId}/like`, undefined, authHeader(viewer.accessToken));
    await client.post(`/api/v1/stories/${storyId}/comments`, { body: "still notified" }, authHeader(viewer.accessToken));

    const notifications = await listNotifications(owner.accessToken);
    assert.ok(!notifications.some((n) => n.type === "like"), "a suppressed type must not create a notification row at all");
    assert.ok(notifications.some((n) => n.type === "comment"), "an unrelated, still-enabled type must still notify");
  });

  it("follow_request notifications are never suppressible, even with follows disabled", async () => {
    const alice = await signupUser();
    const carol = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));
    await client.patch("/api/v1/notifications/preferences", { followsEnabled: false }, authHeader(carol.accessToken));

    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));

    const carolNotifications = await listNotifications(carol.accessToken);
    assert.equal(
      carolNotifications.filter((n) => n.type === "follow_request").length,
      1,
      "a pending follow request is actionable, not a muteable broadcast, so it must always fire",
    );
  });

  it("disabling mentions suppresses @mention notifications from comments", async () => {
    const owner = await signupUser();
    const commenter = await signupUser();
    const mentioned = await signupUser();
    await client.patch("/api/v1/notifications/preferences", { mentionsEnabled: false }, authHeader(mentioned.accessToken));
    const storyId = await publishStory(owner.accessToken);

    await client.post(
      `/api/v1/stories/${storyId}/comments`,
      { body: `hey @${mentioned.input.username}` },
      authHeader(commenter.accessToken),
    );

    const mentionedNotifications = await listNotifications(mentioned.accessToken);
    assert.ok(!mentionedNotifications.some((n) => n.type === "mention"));
  });

  it("rejects a non-boolean preference value", async () => {
    const owner = await signupUser();
    const res = await client.patch("/api/v1/notifications/preferences", { likesEnabled: "nope" }, authHeader(owner.accessToken));
    assert.equal(res.status, 422);
  });
});
