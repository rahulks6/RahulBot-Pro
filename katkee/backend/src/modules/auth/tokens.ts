/**
 * Hand-rolled JWT (HS256) using node:crypto instead of the `jsonwebtoken`
 * package, because this sandbox cannot install npm dependencies. This
 * produces and verifies standards-compliant JWTs (base64url header.payload,
 * HMAC-SHA256 signature, constant-time comparison), so swapping in
 * `jsonwebtoken` later is a drop-in behind sign()/verify().
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config/env";

export interface AccessTokenClaims {
  [key: string]: unknown;
  sub: string; // user id
  type: "access";
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  [key: string]: unknown;
  sub: string;
  jti: string; // refresh_tokens.id — lets us revoke a specific token
  type: "refresh";
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(claims: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function verify<T>(token: string, secret: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const expectedSignature = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url");

  const actual = Buffer.from(signaturePart);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  let claims: T & { exp: number };
  try {
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims;
}

export function issueAccessToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: userId,
    type: "access",
    iat: now,
    exp: now + config.jwt.accessTtlSeconds,
  };
  return sign(claims, config.jwt.accessSecret);
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const claims = verify<AccessTokenClaims>(token, config.jwt.accessSecret);
  if (!claims || claims.type !== "access") return null;
  return claims;
}

export function issueRefreshToken(userId: string, refreshTokenId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: RefreshTokenClaims = {
    sub: userId,
    jti: refreshTokenId,
    type: "refresh",
    iat: now,
    exp: now + config.jwt.refreshTtlSeconds,
  };
  return sign(claims, config.jwt.refreshSecret);
}

export function verifyRefreshToken(token: string): RefreshTokenClaims | null {
  const claims = verify<RefreshTokenClaims>(token, config.jwt.refreshSecret);
  if (!claims || claims.type !== "refresh") return null;
  return claims;
}
