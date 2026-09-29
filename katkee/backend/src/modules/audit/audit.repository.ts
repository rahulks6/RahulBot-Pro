import { nullable, query, type Row } from "../../db/psql";

/**
 * The append-only audit trail (migration 0021). Every function in this file
 * is INSERT or SELECT — there is deliberately no update/delete exported
 * here, and no route anywhere in this codebase should ever call one: an
 * admin who could edit or erase this table could hide their own actions,
 * which is exactly what the spec's "admins can never delete audit logs"
 * rule exists to prevent.
 */
export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function mapRow(row: Row): AuditLogEntry {
  return {
    id: row.id as string,
    actorId: (row.actor_id as string | null) ?? null,
    action: row.action as string,
    targetType: (row.target_type as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    metadata: row.metadata ? (JSON.parse(row.metadata as string) as Record<string, unknown>) : {},
    createdAt: row.created_at as string,
  };
}

export async function record(entry: {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
     VALUES (${nullable("actor_id", "uuid")}, :'action', ${nullable("target_type")}, ${nullable("target_id", "uuid")}, :'metadata'::jsonb)`,
    {
      actor_id: entry.actorId ?? "",
      action: entry.action,
      target_type: entry.targetType ?? "",
      target_id: entry.targetId ?? "",
      metadata: JSON.stringify(entry.metadata ?? {}),
    },
  );
}

export async function list(limit: number, offset: number): Promise<AuditLogEntry[]> {
  const rows = await query(
    `SELECT id, actor_id, action, target_type, target_id, metadata, created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { limit, offset },
  );
  return rows.map(mapRow);
}
