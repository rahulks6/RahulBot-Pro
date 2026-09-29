import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app";
import { authHeader, uniqueUser } from "./helpers";
import { buildTestJpeg, buildTestMp4, buildTestPng } from "./fixtures";

let baseUrl: string;
const server = buildApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signupAndGetToken(): Promise<string> {
  const input = uniqueUser();
  const res = await fetch(`${baseUrl}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { tokens: { accessToken: string } };
  return body.tokens.accessToken;
}

async function upload(path: string, contentType: string, data: Buffer, accessToken: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, ...authHeader(accessToken) },
    body: data,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("media upload — photos", () => {
  it("accepts a real PNG and extracts its true dimensions", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/photos", "image/png", buildTestPng(16, 9), token);
    assert.equal(res.status, 201);
    assert.equal(res.body.media.mimeType, "image/png");
    assert.equal(res.body.media.width, 16);
    assert.equal(res.body.media.height, 9);
    assert.equal(res.body.media.status, "ready");
  });

  it("accepts a real JPEG and extracts its true dimensions", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/photos", "image/jpeg", buildTestJpeg(32, 24), token);
    assert.equal(res.status, 201);
    assert.equal(res.body.media.width, 32);
    assert.equal(res.body.media.height, 24);
  });

  it("rejects a Content-Type that doesn't match the actual file bytes", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/photos", "image/jpeg", buildTestPng(4, 4), token);
    assert.equal(res.status, 415);
  });

  it("rejects bytes that aren't a real image at all", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/photos", "image/png", Buffer.from("not an image"), token);
    assert.equal(res.status, 415);
  });

  it("rejects an empty body", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/photos", "image/png", Buffer.alloc(0), token);
    assert.equal(res.status, 400);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/v1/media/photos`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: buildTestPng(4, 4),
    });
    assert.equal(res.status, 401);
  });
});

describe("media upload — videos", () => {
  it("accepts a real MP4 container", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/videos", "video/mp4", buildTestMp4(), token);
    assert.equal(res.status, 201);
    assert.equal(res.body.media.kind, "video");
    assert.equal(res.body.media.mimeType, "video/mp4");
  });

  it("rejects a photo posted to the video endpoint", async () => {
    const token = await signupAndGetToken();
    const res = await upload("/api/v1/media/videos", "image/png", buildTestPng(4, 4), token);
    assert.equal(res.status, 415);
  });
});

describe("media retrieval and ownership", () => {
  it("round-trips the exact original bytes and enforces owner-only access", async () => {
    const ownerToken = await signupAndGetToken();
    const original = buildTestPng(5, 5);
    const uploaded = await upload("/api/v1/media/photos", "image/png", original, ownerToken);
    const mediaId = uploaded.body.media.id;

    const metaRes = await fetch(`${baseUrl}/api/v1/media/${mediaId}`, { headers: authHeader(ownerToken) });
    assert.equal(metaRes.status, 200);

    const fileRes = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(ownerToken) });
    assert.equal(fileRes.status, 200);
    const roundTripped = Buffer.from(await fileRes.arrayBuffer());
    assert.ok(roundTripped.equals(original), "downloaded bytes must exactly match the uploaded file");

    const otherToken = await signupAndGetToken();
    const metaAsOther = await fetch(`${baseUrl}/api/v1/media/${mediaId}`, { headers: authHeader(otherToken) });
    assert.equal(metaAsOther.status, 404);
    const fileAsOther = await fetch(`${baseUrl}/api/v1/media/${mediaId}/file`, { headers: authHeader(otherToken) });
    assert.equal(fileAsOther.status, 404);
  });

  it("returns 404 for a nonexistent media id", async () => {
    const token = await signupAndGetToken();
    const res = await fetch(`${baseUrl}/api/v1/media/00000000-0000-0000-0000-000000000000`, {
      headers: authHeader(token),
    });
    assert.equal(res.status, 404);
  });
});
