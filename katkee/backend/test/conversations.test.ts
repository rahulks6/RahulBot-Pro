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

async function openConversation(username: string, accessToken: string) {
  const res = await client.post(`/api/v1/users/${username}/conversation`, undefined, authHeader(accessToken));
  return res;
}

describe("opening a conversation", () => {
  it("creates a conversation on first contact and returns the same one on a second call", async () => {
    const alice = await signupUser();
    const bob = await signupUser();

    const first = await openConversation(bob.input.username, alice.accessToken);
    assert.equal(first.status, 200);
    assert.equal(first.body.conversation.otherUser.username, bob.input.username);

    const second = await openConversation(bob.input.username, alice.accessToken);
    assert.equal(second.body.conversation.id, first.body.conversation.id, "must find, not duplicate");

    // Opening it from the other side must resolve to the same conversation too.
    const fromBob = await openConversation(alice.input.username, bob.accessToken);
    assert.equal(fromBob.body.conversation.id, first.body.conversation.id);
  });

  it("rejects messaging yourself with 400", async () => {
    const alice = await signupUser();
    const res = await openConversation(alice.input.username, alice.accessToken);
    assert.equal(res.status, 400);
  });

  it("a blocked relationship prevents opening a conversation, in either direction", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    await client.post(`/api/v1/users/${bob.input.username}/block`, undefined, authHeader(alice.accessToken));

    const aliceOpens = await openConversation(bob.input.username, alice.accessToken);
    assert.equal(aliceOpens.status, 404);
    const bobOpens = await openConversation(alice.input.username, bob.accessToken);
    assert.equal(bobOpens.status, 404);
  });
});

describe("sending and listing messages", () => {
  it("sends text messages and lists them, newest first", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const conversationId = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;

    const m1 = await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "hey" }, authHeader(alice.accessToken));
    assert.equal(m1.status, 201);
    assert.equal(m1.body.message.body, "hey");
    assert.equal(m1.body.message.senderId, alice.id);

    const m2 = await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "hi there" }, authHeader(bob.accessToken));
    assert.equal(m2.status, 201);

    const list = await client.get(`/api/v1/conversations/${conversationId}/messages`, authHeader(alice.accessToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.messages.length, 2);
    assert.equal(list.body.messages[0].body, "hi there", "newest first");
    assert.equal(list.body.messages[1].body, "hey");
  });

  it("rejects an empty message with no body and no storyId with 422", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const conversationId = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;
    const res = await client.post(`/api/v1/conversations/${conversationId}/messages`, {}, authHeader(alice.accessToken));
    assert.equal(res.status, 422);
  });

  it("a non-participant can't read or send messages in someone else's conversation", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const stranger = await signupUser();
    const conversationId = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;
    await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "hi" }, authHeader(alice.accessToken));

    const strangerReads = await client.get(`/api/v1/conversations/${conversationId}/messages`, authHeader(stranger.accessToken));
    assert.equal(strangerReads.status, 404);

    const strangerSends = await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "nope" }, authHeader(stranger.accessToken));
    assert.equal(strangerSends.status, 404);
  });

  it("sending a message to a since-blocked participant is denied", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const conversationId = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;
    await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "hi" }, authHeader(alice.accessToken));

    await client.post(`/api/v1/users/${alice.input.username}/block`, undefined, authHeader(bob.accessToken));

    const res = await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "still there?" }, authHeader(alice.accessToken));
    assert.equal(res.status, 404, "blocking severs messaging the same way it severs everything else");
  });
});

describe("sharing a Story via DM", () => {
  it("attaches a shared Story to the message when sharing is allowed", async () => {
    const owner = await signupUser();
    const recipient = await signupUser();
    const storyId = await publishStory(owner.accessToken, { allowSharing: true });
    const conversationId = (await openConversation(recipient.input.username, owner.accessToken)).body.conversation.id;

    const res = await client.post(
      `/api/v1/conversations/${conversationId}/messages`,
      { storyId },
      authHeader(owner.accessToken),
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.message.sharedStoryId, storyId);
    assert.equal(res.body.message.body, null);
  });

  it("enforces allowSharing the same way the Share sheet's other options do", async () => {
    const owner = await signupUser();
    const recipient = await signupUser();
    const storyId = await publishStory(owner.accessToken, { allowSharing: false });
    const conversationId = (await openConversation(recipient.input.username, owner.accessToken)).body.conversation.id;

    const res = await client.post(
      `/api/v1/conversations/${conversationId}/messages`,
      { storyId },
      authHeader(owner.accessToken),
    );
    assert.equal(res.status, 403);
  });

  it("can't share a Story the sender can't themselves view", async () => {
    const owner = await signupUser();
    const stranger = await signupUser();
    const someoneElse = await signupUser();
    const storyId = await publishStory(owner.accessToken, { audience: "followers" });
    const conversationId = (await openConversation(someoneElse.input.username, stranger.accessToken)).body.conversation.id;

    const res = await client.post(
      `/api/v1/conversations/${conversationId}/messages`,
      { storyId },
      authHeader(stranger.accessToken),
    );
    assert.equal(res.status, 403);
  });
});

describe("unread count and mark-read", () => {
  it("receiving a message marks the conversation unread for the recipient only, and mark-read clears it", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const conversationId = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;

    const beforeAlice = await client.get("/api/v1/conversations/unread-count", authHeader(alice.accessToken));
    assert.equal(beforeAlice.body.count, 0, "opening a conversation with no messages isn't unread");

    await client.post(`/api/v1/conversations/${conversationId}/messages`, { body: "hey bob" }, authHeader(alice.accessToken));

    const afterSendAlice = await client.get("/api/v1/conversations/unread-count", authHeader(alice.accessToken));
    assert.equal(afterSendAlice.body.count, 0, "sending a message counts as having seen your own conversation");

    const afterSendBob = await client.get("/api/v1/conversations/unread-count", authHeader(bob.accessToken));
    assert.equal(afterSendBob.body.count, 1);

    const markRead = await client.post(`/api/v1/conversations/${conversationId}/read`, undefined, authHeader(bob.accessToken));
    assert.equal(markRead.status, 204);

    const afterReadBob = await client.get("/api/v1/conversations/unread-count", authHeader(bob.accessToken));
    assert.equal(afterReadBob.body.count, 0);
  });
});

describe("conversation list", () => {
  it("lists conversations most-recently-active first with the other participant and last message", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const carol = await signupUser();

    const withBob = (await openConversation(bob.input.username, alice.accessToken)).body.conversation.id;
    const withCarol = (await openConversation(carol.input.username, alice.accessToken)).body.conversation.id;

    await client.post(`/api/v1/conversations/${withBob}/messages`, { body: "first" }, authHeader(alice.accessToken));
    await client.post(`/api/v1/conversations/${withCarol}/messages`, { body: "second, more recent" }, authHeader(alice.accessToken));

    const list = await client.get("/api/v1/conversations", authHeader(alice.accessToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.conversations.length, 2);
    assert.equal(list.body.conversations[0].id, withCarol, "most recently active first");
    assert.equal(list.body.conversations[0].otherUser.username, carol.input.username);
    assert.equal(list.body.conversations[0].lastMessage.body, "second, more recent");
    assert.equal(list.body.conversations[1].id, withBob);
  });
});
