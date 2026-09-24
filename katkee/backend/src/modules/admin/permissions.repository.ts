import { query, type Row } from "../../db/psql";
import type { Permission } from "./permissions";

export interface GrantedPermission {
  permission: Permission;
  grantedBy: string;
  grantedAt: string;
}

function mapRow(row: Row): GrantedPermission {
  return {
    permission: row.permission as Permission,
    grantedBy: row.granted_by as string,
    grantedAt: row.granted_at as string,
  };
}

export async function listForUser(userId: string): Promise<GrantedPermission[]> {
  const rows = await query(
    `SELECT permission, granted_by, granted_at FROM admin_permissions WHERE user_id = :'user_id' ORDER BY permission ASC`,
    { user_id: userId },
  );
  return rows.map(mapRow);
}

export async function hasPermission(userId: string, permission: Permission): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM admin_permissions WHERE user_id = :'user_id' AND permission = :'permission'`, {
    user_id: userId,
    permission,
  });
  return rows.length > 0;
}

export async function grant(userId: string, permission: Permission, grantedBy: string): Promise<void> {
  await query(
    `INSERT INTO admin_permissions (user_id, permission, granted_by)
     VALUES (:'user_id', :'permission', :'granted_by')
     ON CONFLICT (user_id, permission) DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()`,
    { user_id: userId, permission, granted_by: grantedBy },
  );
}

export async function revoke(userId: string, permission: Permission): Promise<void> {
  await query(`DELETE FROM admin_permissions WHERE user_id = :'user_id' AND permission = :'permission'`, {
    user_id: userId,
    permission,
  });
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await query(`DELETE FROM admin_permissions WHERE user_id = :'user_id'`, { user_id: userId });
}
