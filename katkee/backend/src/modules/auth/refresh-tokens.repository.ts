import { createHash } from "node:crypto";
import { nullable, query, queryOne } from "../../db/psql";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export async function insertRefreshToken(input: {
  userId: string;
  expiresAt: Date;
  userAgent: string | null;
}): Promise<string> {
  // Two-step insert (get an id, then a placeholder hash) so the caller can
  // mint the JWT's `jti` from the row id before the real token exists. The
  // hash is written in the same call once the token bytes are known.
  const row = await queryOne(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES (:'user_id', :'placeholder', :'expires_at', ${nullable("user_agent")})
     RETURNING id`,
    {
      user_id: input.userId,
      placeholder: "pending",
      expires_at: input.expiresAt.toISOString(),
      user_agent: input.userAgent,
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return row.id as string;
}

export async function finalizeRefreshToken(id: string, token: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET token_hash = :'hash' WHERE id = :'id'`, {
    id,
    hash: hashToken(token),
  });
}

export async function findActiveRefreshToken(id: string, token: string): Promise<RefreshTokenRecord | null> {
  const row = await queryOne(
    `SELECT id, user_id, expires_at, revoked_at
     FROM refresh_tokens
     WHERE id = :'id' AND token_hash = :'hash'`,
    { id, hash: hashToken(token) },
  );
  if (!row) return null;
  const record: RefreshTokenRecord = {
    id: row.id as string,
    userId: row.user_id as string,
    expiresAt: row.expires_at as string,
    revokedAt: row.revoked_at ?? null,
  };
  if (record.revokedAt !== null) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  return record;
}

export async function revokeRefreshToken(id: string, replacedById: string | null): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = ${nullable("replaced_by", "uuid")}
     WHERE id = :'id'`,
    { id, replaced_by: replacedById },
  );
}

export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :'user_id' AND revoked_at IS NULL`, {
    user_id: userId,
  });
}
