import { query, queryOne } from "../../db/psql";

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  bio: string;
  isPrivate: boolean;
  isActive: boolean;
  createdAt: string;
}

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
     RETURNING id, username, email, password_hash, display_name, bio, is_private, is_active, created_at`,
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
    `SELECT id, username, email, password_hash, display_name, bio, is_private, is_active, created_at
     FROM users
     WHERE email = :'email' AND deleted_at IS NULL`,
    { email },
  );
  return row ? mapRow(row) : null;
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const row = await queryOne(
    `SELECT id, username, email, password_hash, display_name, bio, is_private, is_active, created_at
     FROM users
     WHERE username = :'username' AND deleted_at IS NULL`,
    { username },
  );
  return row ? mapRow(row) : null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const row = await queryOne(
    `SELECT id, username, email, password_hash, display_name, bio, is_private, is_active, created_at
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
