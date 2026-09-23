import { query, queryOne } from "../../db/psql";

export type UserRole = "user" | "moderator" | "admin";

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  isActive: boolean;
  role: UserRole;
  isPrimaryAdmin: boolean;
  createdAt: string;
}

const SELECT_COLUMNS =
  "id, username, email, password_hash, display_name, bio, is_private, is_active, role, is_primary_admin, created_at";

function mapRow(row: Record<string, string | null>): UserRecord {
  return {
    id: row.id as string,
    username: row.username as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    displayName: row.display_name as string,
    bio: row.bio as string,
    isPrivate: row.is_private === "t",
    isActive: row.is_active === "t",
    role: row.role as UserRole,
    isPrimaryAdmin: row.is_primary_admin === "t",
    createdAt: row.created_at as string,
  };
}

export async function createUser(input: {
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
}): Promise<UserRecord> {
  const row = await queryOne(
    `INSERT INTO users (username, email, password_hash, display_name)
     VALUES (:'username', :'email', :'password_hash', :'display_name')
     RETURNING ${SELECT_COLUMNS}`,
    {
      username: input.username,
      email: input.email,
      password_hash: input.passwordHash,
      display_name: input.displayName,
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapRow(row);
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const row = await queryOne(
    `SELECT ${SELECT_COLUMNS}
     FROM users
     WHERE email = :'email' AND deleted_at IS NULL`,
    { email },
  );
  return row ? mapRow(row) : null;
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const row = await queryOne(
    `SELECT ${SELECT_COLUMNS}
     FROM users
     WHERE username = :'username' AND deleted_at IS NULL`,
    { username },
  );
  return row ? mapRow(row) : null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const row = await queryOne(
    `SELECT ${SELECT_COLUMNS}
     FROM users
     WHERE id = :'id' AND deleted_at IS NULL`,
    { id },
  );
  return row ? mapRow(row) : null;
}

export async function usernameOrEmailTaken(username: string, email: string): Promise<boolean> {
  const rows = await query(
    `SELECT id FROM users
     WHERE deleted_at IS NULL AND (username = :'username' OR email = :'email')
     LIMIT 1`,
    { username, email },
  );
  return rows.length > 0;
}

/**
 * Writes concrete, final values for all three columns — the caller (see
 * profiles.service.updateMyProfile) merges any partial update onto the
 * current row first. That sidesteps the empty-string-vs-NULL ambiguity of
 * the `nullable()` NULLIF trick, which would otherwise make "clear my bio"
 * (set bio to "") indistinguishable from "don't touch bio".
 */
export async function setProfile(
  id: string,
  values: { displayName: string; bio: string; isPrivate: boolean },
): Promise<UserRecord> {
  const row = await queryOne(
    `UPDATE users
     SET display_name = :'display_name', bio = :'bio', is_private = :'is_private'
     WHERE id = :'id' AND deleted_at IS NULL
     RETURNING ${SELECT_COLUMNS}`,
    { id, display_name: values.displayName, bio: values.bio, is_private: values.isPrivate },
  );
  if (!row) throw new Error("Update did not return a row");
  return mapRow(row);
}

/** Moderator-only action (see moderation.service.ts) — login and token refresh both already check isActive, so this is the one lever that actually enforces a suspension. */
export async function setActive(id: string, isActive: boolean): Promise<void> {
  await query(`UPDATE users SET is_active = :'is_active' WHERE id = :'id'`, { id, is_active: isActive });
}

/** Admin-only action (see moderation.service.ts's requireAdmin/promoteUser/demoteUser) — grants or revokes moderator/admin access. Never touches is_primary_admin; that's set exactly once, out of band, by scripts/seedPrimaryAdmin.ts. */
export async function setRole(id: string, role: UserRole): Promise<void> {
  await query(`UPDATE users SET role = :'role' WHERE id = :'id'`, { id, role });
}

/** The current moderator/admin roster, for the admin management screen — deliberately excludes plain 'user' rows (that's every account, not staff). */
export async function listStaff(): Promise<UserRecord[]> {
  const rows = await query(
    `SELECT ${SELECT_COLUMNS} FROM users
     WHERE deleted_at IS NULL AND role IN ('moderator', 'admin')
     ORDER BY is_primary_admin DESC, role DESC, username ASC`,
    {},
  );
  return rows.map(mapRow);
}

/**
 * Idempotent, out-of-band primary-admin bootstrap (see
 * scripts/seedPrimaryAdmin.ts) — never exposed through any HTTP route.
 * The unique partial index on is_primary_admin (migration 0020) is the
 * real backstop; this check is the friendly, specific error message.
 */
export async function findPrimaryAdmin(): Promise<UserRecord | null> {
  const row = await queryOne(`SELECT ${SELECT_COLUMNS} FROM users WHERE is_primary_admin = true`, {});
  return row ? mapRow(row) : null;
}

export async function grantPrimaryAdmin(id: string): Promise<void> {
  await query(`UPDATE users SET role = 'admin', is_primary_admin = true WHERE id = :'id'`, { id });
}

/**
 * Self-service account deletion (see profiles.service.deleteMyAccount).
 * Every read in this file already filters `deleted_at IS NULL`, so this
 * alone makes the account unfindable by username/email/id (login,
 * lookups, search) immediately — the same mechanism Phase 4's soft
 * Story-delete and Phase 10's moderator suspension both already rely on.
 * It also frees the username/email for reuse, the same way any other
 * soft-deleted row here already does.
 */
export async function softDeleteUser(id: string): Promise<void> {
  await query(`UPDATE users SET deleted_at = now() WHERE id = :'id'`, { id });
}

export interface UserSearchResult {
  id: string;
  username: string;
  displayName: string;
  bio: string;
}

export async function searchUsers(
  searchTerm: string,
  excludeUserId: string,
  limit: number,
  offset: number,
): Promise<UserSearchResult[]> {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.bio
     FROM users u
     WHERE u.deleted_at IS NULL
       AND u.id <> :'exclude_id'
       AND (u.username::text ILIKE :'pattern' OR u.display_name ILIKE :'pattern')
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = :'exclude_id' AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = :'exclude_id')
       )
     ORDER BY u.username ASC
     LIMIT :'limit' OFFSET :'offset'`,
    { exclude_id: excludeUserId, pattern: `%${searchTerm}%`, limit, offset },
  );
  return rows.map((row) => ({
    id: row.id as string,
    username: row.username as string,
    displayName: row.display_name as string,
    bio: row.bio as string,
  }));
}
