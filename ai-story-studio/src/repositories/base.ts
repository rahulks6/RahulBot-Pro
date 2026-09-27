import type { Database, SqlParam } from '../db/database.ts';
import { AppError, notFound } from '../lib/errors.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function flag(value: boolean | number | undefined): 0 | 1 {
  return value ? 1 : 0;
}

export function requireRow<T>(db: Database, table: string, id: string, label = table): T {
  const row = db.get<T>(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row) throw notFound(label, id);
  return row;
}

/** Throw LOCKED if any of `fields` would change on a locked entity. */
export function assertLockedFieldsUnchanged(
  entity: string,
  current: Record<string, unknown>,
  next: Record<string, SqlParam>,
  fields: readonly string[],
): void {
  if (!current['locked']) return;
  const changed = fields.filter((f) => f in next && String(next[f] ?? '') !== String(current[f] ?? ''));
  if (changed.length > 0) {
    throw new AppError(
      'LOCKED',
      `${entity} is locked; canonical fields cannot change (${changed.join(', ')}). Create a variant or unlock explicitly.`,
      changed.map((f) => ({ path: f, message: 'locked' })),
    );
  }
}

/** Compact 0..n-1 positions of rows in an ordered child collection. */
export function compactPositions(db: Database, table: string, parentColumn: string, parentId: string): void {
  const rows = db.all<{ id: string }>(
    `SELECT id FROM ${table} WHERE ${parentColumn} = ? ORDER BY position, created_at`,
    parentId,
  );
  rows.forEach((r, i) => db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, i, r.id));
}

export function nextPosition(db: Database, table: string, parentColumn: string, parentId: string): number {
  return (
    db.scalar<number>(
      `SELECT COALESCE(MAX(position) + 1, 0) FROM ${table} WHERE ${parentColumn} = ?`,
      parentId,
    ) ?? 0
  );
}

/** Move one row up or down within its parent by swapping positions. */
export function moveRow(
  db: Database,
  table: string,
  parentColumn: string,
  id: string,
  direction: 'up' | 'down',
): void {
  db.transaction(() => {
    const row = db.get<{ position: number; parent: string }>(
      `SELECT position, ${parentColumn} AS parent FROM ${table} WHERE id = ?`,
      id,
    );
    if (!row) throw notFound(table, id);
    compactPositions(db, table, parentColumn, row.parent);
    const current = db.get<{ position: number }>(`SELECT position FROM ${table} WHERE id = ?`, id)!;
    const target = direction === 'up' ? current.position - 1 : current.position + 1;
    const other = db.get<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${parentColumn} = ? AND position = ?`,
      row.parent,
      target,
    );
    if (!other) return;
    db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, current.position, other.id);
    db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, target, id);
  });
}

/** Apply an explicit order; `ids` must be exactly the parent's children. */
export function reorderRows(
  db: Database,
  table: string,
  parentColumn: string,
  parentId: string,
  ids: string[],
): void {
  db.transaction(() => {
    const existing = db
      .all<{ id: string }>(`SELECT id FROM ${table} WHERE ${parentColumn} = ?`, parentId)
      .map((r) => r.id)
      .sort();
    const given = [...ids].sort();
    if (existing.length !== given.length || existing.some((id, i) => id !== given[i])) {
      throw new AppError('VALIDATION_FAILED', 'Reorder list must contain exactly the existing items');
    }
    ids.forEach((id, i) => db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, i, id));
  });
}
