import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, makeClient, uniqueUser } from "./helpers";

let client: ReturnType<typeof makeClient>;
const server = buildApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  client = makeClient(`http://127.0.0.1:${address.port}`);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signupUser() {
  const input = uniqueUser();
  const res = await client.post("/api/v1/auth/signup", input);
  return { input, accessToken: res.body.tokens.accessToken as string };
}

describe("profile", () => {
  it("returns public profile fields for another user", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    const res = await client.get(`/api/v1/users/${bob.input.username}`, authHeader(alice.accessToken));
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.username, bob.input.username);
    assert.equal(res.body.profile.isSelf, false);
    assert.equal(res.body.profile.followerCount, 0);
  });

  it("returns 404 for a nonexistent username", async () => {
    const alice = await signupUser();
    const res = await client.get("/api/v1/users/nobody_at_all_xyz", authHeader(alice.accessToken));
    assert.equal(res.status, 404);
  });

  it("updates the caller's own profile and preserves untouched fields", async () => {
    const alice = await signupUser();
    const first = await client.patch("/api/v1/users/me", { bio: "hello world" }, authHeader(alice.accessToken));
    assert.equal(first.status, 200);
    assert.equal(first.body.user.bio, "hello world");
    assert.equal(first.body.user.displayName, alice.input.displayName);

    const second = await client.patch(
      "/api/v1/users/me",
      { displayName: "New Name" },
      authHeader(alice.accessToken),
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.user.displayName, "New Name");
    assert.equal(second.body.user.bio, "hello world", "bio must survive an update that didn't touch it");
  });
});

describe("follow — public account", () => {
  it("follows immediately and shows up in followers/following lists", async () => {
    const alice = await signupUser();
    const bob = await signupUser();

    const follow = await client.post(`/api/v1/users/${bob.input.username}/follow`, undefined, authHeader(alice.accessToken));
    assert.equal(follow.status, 200);
    assert.equal(follow.body.status, "following");

    const profile = await client.get(`/api/v1/users/${bob.input.username}`, authHeader(alice.accessToken));
    assert.equal(profile.body.profile.followerCount, 1);
    assert.equal(profile.body.profile.viewer.isFollowing, true);

    const followers = await client.get(`/api/v1/users/${bob.input.username}/followers`, authHeader(bob.accessToken));
    assert.equal(followers.status, 200);
    assert.equal(followers.body.followers.length, 1);
    assert.equal(followers.body.followers[0].username, alice.input.username);
  });

  it("unfollow is idempotent and removes the relationship", async () => {
    const alice = await signupUser();
    const bob = await signupUser();
    await client.post(`/api/v1/users/${bob.input.username}/follow`, undefined, authHeader(alice.accessToken));

    const unfollow1 = await client.delete(`/api/v1/users/${bob.input.username}/follow`, authHeader(alice.accessToken));
    assert.equal(unfollow1.status, 204);
    const unfollow2 = await client.delete(`/api/v1/users/${bob.input.username}/follow`, authHeader(alice.accessToken));
    assert.equal(unfollow2.status, 204, "unfollowing twice must not error");

    const profile = await client.get(`/api/v1/users/${bob.input.username}`, authHeader(alice.accessToken));
    assert.equal(profile.body.profile.followerCount, 0);
  });

  it("rejects following yourself with 400", async () => {
    const alice = await signupUser();
    const res = await client.post(`/api/v1/users/${alice.input.username}/follow`, undefined, authHeader(alice.accessToken));
    assert.equal(res.status, 400);
  });
});

describe("follow — private account", () => {
  it("creates a pending request instead of following directly, then accept grants the follow", async () => {
    const alice = await signupUser();
    const carol = await signupUser();

    const makePrivate = await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));
    assert.equal(makePrivate.body.user.isPrivate, true);

    const request = await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));
    assert.equal(request.body.status, "requested");

    const profile = await client.get(`/api/v1/users/${carol.input.username}`, authHeader(alice.accessToken));
    assert.equal(profile.body.profile.viewer.isFollowing, false);
    assert.equal(profile.body.profile.viewer.hasPendingRequestFromViewer, true);

    const blockedFollowers = await client.get(`/api/v1/users/${carol.input.username}/followers`, authHeader(alice.accessToken));
    assert.equal(blockedFollowers.status, 403, "a non-follower can't list a private account's followers");

    const incoming = await client.get("/api/v1/follow-requests", authHeader(carol.accessToken));
    assert.equal(incoming.body.requests.length, 1);
    const requestId = incoming.body.requests[0].requestId;

    const accept = await client.post(`/api/v1/follow-requests/${requestId}/accept`, undefined, authHeader(carol.accessToken));
    assert.equal(accept.status, 204);

    const afterAccept = await client.get(`/api/v1/users/${carol.input.username}`, authHeader(alice.accessToken));
    assert.equal(afterAccept.body.profile.viewer.isFollowing, true);
    assert.equal(afterAccept.body.profile.followerCount, 1);

    const reaccept = await client.post(`/api/v1/follow-requests/${requestId}/accept`, undefined, authHeader(carol.accessToken));
    assert.equal(reaccept.status, 409, "accepting an already-resolved request must fail");
  });

  it("decline resolves the request without creating a follow", async () => {
    const alice = await signupUser();
    const carol = await signupUser();
    await client.patch("/api/v1/users/me", { isPrivate: true }, authHeader(carol.accessToken));
    await client.post(`/api/v1/users/${carol.input.username}/follow`, undefined, authHeader(alice.accessToken));

    const incoming = await client.get("/api/v1/follow-requests", authHeader(carol.accessToken));
    const requestId = incoming.body.requests[0].requestId;

    const decline = await client.post(`/api/v1/follow-requests/${requestId}/decline`, undefined, authHeader(carol.accessToken));
    assert.equal(decline.status, 204);

    const profile = await client.get(`/api/v1/users/${carol.input.username}`, authHeader(alice.accessToken));
    assert.equal(profile.body.profile.viewer.isFollowing, false);
  });
});

describe("blocking", () => {
  it("severs any existing follow relationship in both directions and hides both profiles", async () => {
    const dave = await signupUser();
    const erin = await signupUser();

    await client.post(`/api/v1/users/${erin.input.username}/follow`, undefined, authHeader(dave.accessToken));

    const block = await client.post(`/api/v1/users/${dave.input.username}/block`, undefined, authHeader(erin.accessToken));
    assert.equal(block.status, 204);

    const daveViewsErin = await client.get(`/api/v1/users/${erin.input.username}`, authHeader(dave.accessToken));
    assert.equal(daveViewsErin.status, 404);
    const erinViewsDave = await client.get(`/api/v1/users/${dave.input.username}`, authHeader(erin.accessToken));
    assert.equal(erinViewsDave.status, 404);

    const reFollow = await client.post(`/api/v1/users/${erin.input.username}/follow`, undefined, authHeader(dave.accessToken));
    assert.equal(reFollow.status, 404, "blocked users can't be followed");

    const blockedList = await client.get("/api/v1/blocks", authHeader(erin.accessToken));
    assert.equal(blockedList.body.blocked.length, 1);
    assert.equal(blockedList.body.blocked[0].username, dave.input.username);

    const unblock = await client.delete(`/api/v1/users/${dave.input.username}/block`, authHeader(erin.accessToken));
    assert.equal(unblock.status, 204);

    const visibleAgain = await client.get(`/api/v1/users/${erin.input.username}`, authHeader(dave.accessToken));
    assert.equal(visibleAgain.status, 200);
    assert.equal(visibleAgain.body.profile.viewer.isFollowing, false, "unblocking does not restore the old follow");
  });
});

describe("mute", () => {
  it("persists and lists muted users without affecting the follow graph", async () => {
    const alice = await signupUser();
    const bob = await signupUser();

    const mute = await client.post(`/api/v1/users/${bob.input.username}/mute`, undefined, authHeader(alice.accessToken));
    assert.equal(mute.status, 204);

    const muted = await client.get("/api/v1/mutes", authHeader(alice.accessToken));
    assert.equal(muted.body.muted.length, 1);
    assert.equal(muted.body.muted[0].username, bob.input.username);

    const unmute = await client.delete(`/api/v1/users/${bob.input.username}/mute`, authHeader(alice.accessToken));
    assert.equal(unmute.status, 204);

    const mutedAfter = await client.get("/api/v1/mutes", authHeader(alice.accessToken));
    assert.equal(mutedAfter.body.muted.length, 0);
  });
});

describe("search", () => {
  it("finds users by username substring, excluding blocked relationships and the searcher", async () => {
    const alice = await signupUser();
    const target = await signupUser();

    const found = await client.get(`/api/v1/search/users?q=${target.input.username.slice(0, 6)}`, authHeader(alice.accessToken));
    assert.equal(found.status, 200);
    assert.ok(found.body.results.some((u: any) => u.username === target.input.username));
    assert.ok(!found.body.results.some((u: any) => u.username === alice.input.username), "search must not return yourself");

    await client.post(`/api/v1/users/${target.input.username}/block`, undefined, authHeader(alice.accessToken));
    const afterBlock = await client.get(`/api/v1/search/users?q=${target.input.username.slice(0, 6)}`, authHeader(alice.accessToken));
    assert.ok(!afterBlock.body.results.some((u: any) => u.username === target.input.username), "blocked users are excluded from search");
  });

  it("rejects an empty query with 422", async () => {
    const alice = await signupUser();
    const res = await client.get("/api/v1/search/users?q=", authHeader(alice.accessToken));
    assert.equal(res.status, 422);
  });
});
