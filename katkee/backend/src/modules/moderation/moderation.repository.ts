import { nullable, query, queryOne, type Row } from "../../db/psql";

export type TargetType = "story" | "comment" | "user";
export type ReportReason = "spam" | "harassment" | "nudity" | "violence" | "hate_speech" | "self_harm" | "other";
export type ReportStatus = "pending" | "dismissed" | "actioned";

export interface ReportRow {
  id: string;
  reporterId: string;
  targetType: TargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolutionNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const SELECT_COLUMNS =
  "id, reporter_id, target_type, target_id, reason, details, status, resolution_note, reviewed_by, reviewed_at, created_at";

function mapRow(row: Row): ReportRow {
  return {
    id: row.id as string,
    reporterId: row.reporter_id as string,
    targetType: row.target_type as TargetType,
    targetId: row.target_id as string,
    reason: row.reason as ReportReason,
    details: (row.details as string | null) ?? null,
    status: row.status as ReportStatus,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function createReport(input: {
  reporterId: string;
  targetType: TargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
}): Promise<ReportRow> {
  const row = await queryOne(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
     VALUES (:'reporter_id', :'target_type', :'target_id', :'reason', ${nullable("details")})
     RETURNING ${SELECT_COLUMNS}`,
    {
      reporter_id: input.reporterId,
      target_type: input.targetType,
      target_id: input.targetId,
      reason: input.reason,
      details: input.details ?? "",
    },
  );
  if (!row) throw new Error("Report insert returned no row");
  return mapRow(row);
}

export async function findReportById(id: string): Promise<ReportRow | null> {
  const row = await queryOne(`SELECT ${SELECT_COLUMNS} FROM reports WHERE id = :'id'`, { id });
  return row ? mapRow(row) : null;
}

/** Oldest-pending-first — a fair, FIFO moderation queue. */
export async function listReports(status: ReportStatus, limit: number, offset: number): Promise<ReportRow[]> {
  const rows = await query(
    `SELECT ${SELECT_COLUMNS} FROM reports
     WHERE status = :'status'
     ORDER BY created_at ASC
     LIMIT :'limit' OFFSET :'offset'`,
    { status, limit, offset },
  );
  return rows.map(mapRow);
}

export async function resolveReport(
  id: string,
  moderatorId: string,
  status: "dismissed" | "actioned",
  note: string | null,
): Promise<void> {
  await query(
    `UPDATE reports
     SET status = :'status', resolution_note = ${nullable("note")}, reviewed_by = :'reviewed_by', reviewed_at = now()
     WHERE id = :'id'`,
    { id, status, note: note ?? "", reviewed_by: moderatorId },
  );
}
