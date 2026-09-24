import { config } from "../../config/env";
import * as usersRepo from "../users/users.repository";
import * as refreshTokensRepo from "./refresh-tokens.repository";
import { hashPassword, verifyPassword } from "./password";
import { issueAccessToken, issueRefreshToken, verifyRefreshToken } from "./tokens";
import type { LoginInput, SignupInput } from "./dto";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  role: usersRepo.UserRole;
  isPrimaryAdmin: boolean;
}

function toPublicUser(user: usersRepo.UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    bio: user.bio,
    isPrivate: user.isPrivate,
    role: user.role,
    isPrimaryAdmin: user.isPrimaryAdmin,
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function issueTokenPair(userId: string, userAgent: string | null): Promise<TokenPair> {
  const refreshTokenId = await refreshTokensRepo.insertRefreshToken({
    userId,
    expiresAt: new Date(Date.now() + config.jwt.refreshTtlSeconds * 1000),
    userAgent,
  });
  const refreshToken = issueRefreshToken(userId, refreshTokenId);
  await refreshTokensRepo.finalizeRefreshToken(refreshTokenId, refreshToken);
  const accessToken = issueAccessToken(userId);
  return { accessToken, refreshToken };
}

export async function signup(
  input: SignupInput,
  userAgent: string | null,
): Promise<{ user: PublicUser; tokens: TokenPair }> {
  const taken = await usersRepo.usernameOrEmailTaken(input.username, input.email);
  if (taken) {
    throw new AuthError("Username or email is already registered.", 409);
  }
  const passwordHash = await hashPassword(input.password);
  const user = await usersRepo.createUser({
    username: input.username,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
  });
  const tokens = await issueTokenPair(user.id, userAgent);
  return { user: toPublicUser(user), tokens };
}

export async function login(
  input: LoginInput,
  userAgent: string | null,
): Promise<{ user: PublicUser; tokens: TokenPair }> {
  const user = await usersRepo.findUserByEmail(input.email);
  if (!user || !user.isActive) {
    throw new AuthError("Invalid email or password.", 401);
  }
  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw new AuthError("Invalid email or password.", 401);
  }
  const tokens = await issueTokenPair(user.id, userAgent);
  return { user: toPublicUser(user), tokens };
}

export async function refresh(refreshToken: string, userAgent: string | null): Promise<TokenPair> {
  const claims = verifyRefreshToken(refreshToken);
  if (!claims) throw new AuthError("Invalid or expired refresh token.", 401);

  const record = await refreshTokensRepo.findActiveRefreshToken(claims.jti, refreshToken);
  if (!record) throw new AuthError("Invalid or expired refresh token.", 401);

  // Re-checked here, not just at login: a still-unexpired refresh token
  // from before a moderator suspension must not be usable to mint a fresh
  // access token — see moderation.service.ts's suspendUser, which revokes
  // every refresh token a suspended user already holds for exactly this
  // reason. (A still-live *access* token issued before the suspension
  // stays valid for its own short TTL regardless — see backend/README.md's
  // Phase 10 section for that bounded, documented gap.)
  const user = await usersRepo.findUserById(record.userId);
  if (!user || !user.isActive) {
    throw new AuthError("Invalid or expired refresh token.", 401);
  }

  // Rotate: the presented refresh token is single-use.
  const tokens = await issueTokenPair(record.userId, userAgent);
  await refreshTokensRepo.revokeRefreshToken(record.id, null);
  return tokens;
}

export async function logout(refreshToken: string): Promise<void> {
  const claims = verifyRefreshToken(refreshToken);
  if (!claims) return; // already invalid/expired — logout is idempotent
  const record = await refreshTokensRepo.findActiveRefreshToken(claims.jti, refreshToken);
  if (!record) return;
  await refreshTokensRepo.revokeRefreshToken(record.id, null);
}

export async function getPublicUserById(userId: string): Promise<PublicUser | null> {
  const user = await usersRepo.findUserById(userId);
  return user ? toPublicUser(user) : null;
}
