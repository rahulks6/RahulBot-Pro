import { nullable, query, type Row } from "../../db/psql";

export type ModerationActionType =
  | "remove_content"
  | "restore_content"
  | "restrict_user"
  | "unrestrict_user"
  | "suspend_user"
  | "unsuspend_user"
  | "dismiss_report";

export interface ModerationActionRow {
  id: string;
  actorId: string;
  actionType: ModerationActionType;
  targetType: "story" | "comment" | "user";
  targetId: string;
  reportId: string | null;
  reason: string | null;
  createdAt: string;
}

function mapRow(row: Row): ModerationActionRow {
  return {
    id: row.id as string,
    actorId: row.actor_id as string,
    actionType: row.action_type as ModerationActionType,
    targetType: row.target_type as "story" | "comment" | "user",
    targetId: row.target_id as string,
    reportId: (row.report_id as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** The action-centric audit trail (migration 0021) the Admin Console's "moderation history" screen reads. Insert-only — nothing here ever updates or deletes a row. */
export async function record(entry: {
  actorId: string;
  actionType: ModerationActionType;
  targetType: "story" | "comment" | "user";
  targetId: string;
  reportId?: string | null;
  reason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO moderation_actions (actor_id, action_type, target_type, target_id, report_id, reason)
     VALUES (:'actor_id', :'action_type', :'target_type', :'target_id', ${nullable("report_id", "uuid")}, ${nullable("reason")})`,
    {
      actor_id: entry.actorId,
      action_type: entry.actionType,
      target_type: entry.targetType,
      target_id: entry.targetId,
      report_id: entry.reportId ?? "",
      reason: entry.reason ?? "",
    },
  );
}

export async function listForTarget(targetType: string, targetId: string, limit: number, offset: number): Promise<ModerationActionRow[]> {
  const rows = await query(
    `SELECT id, actor_id, action_type, target_type, target_id, report_id, reason, created_at
     FROM moderation_actions
     WHERE target_type = :'target_type' AND target_id = :'target_id'
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { target_type: targetType, target_id: targetId, limit, offset },
  );
  return rows.map(mapRow);
}

export async function listAll(limit: number, offset: number): Promise<ModerationActionRow[]> {
  const rows = await query(
    `SELECT id, actor_id, action_type, target_type, target_id, report_id, reason, created_at
     FROM moderation_actions
     ORDER BY created_at DESC
     LIMIT :'limit' OFFSET :'offset'`,
    { limit, offset },
  );
  return rows.map(mapRow);
}
