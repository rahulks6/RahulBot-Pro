import { query, queryOne, type Row } from "../../db/psql";
import type { Audience } from "../stories/stories.repository";

export interface HighlightRow {
  id: string;
  ownerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightItemRow {
  storyId: string;
  mediaId: string;
  audience: Audience;
  position: number;
  addedAt: string;
}

export interface HighlightWithItems extends HighlightRow {
  items: HighlightItemRow[];
}

function mapHighlightRow(row: Row): HighlightRow {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    title: row.title as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createHighlight(ownerId: string, title: string): Promise<HighlightRow> {
  const row = await queryOne(
    `INSERT INTO highlights (owner_id, title) VALUES (:'owner_id', :'title')
     RETURNING id, owner_id, title, created_at, updated_at`,
    { owner_id: ownerId, title },
  );
  if (!row) throw new Error("Highlight insert returned no row");
  return mapHighlightRow(row);
}

export async function findHighlightById(id: string): Promise<HighlightRow | null> {
  const row = await queryOne(`SELECT id, owner_id, title, created_at, updated_at FROM highlights WHERE id = :'id'`, { id });
  return row ? mapHighlightRow(row) : null;
}

export async function renameHighlight(id: string, title: string): Promise<void> {
  await query(`UPDATE highlights SET title = :'title', updated_at = now() WHERE id = :'id'`, { id, title });
}

export async function deleteHighlight(id: string): Promise<void> {
  await query(`DELETE FROM highlights WHERE id = :'id'`, { id });
}

/**
 * Replaces a highlight's full ordered item list in one call — delete then
 * re-insert, not a diff/patch. There's no cross-statement transaction in
 * this psql-CLI shim (see db/psql.ts), so this is sequential rather than
 * atomic, the same accepted tradeoff as other multi-step repository
 * functions elsewhere in this codebase (e.g. conversations.repository's
 * createMessage + markRead).
 */
export async function replaceHighlightItems(highlightId: string, storyIds: string[]): Promise<void> {
  await query(`DELETE FROM highlight_items WHERE highlight_id = :'highlight_id'`, { highlight_id: highlightId });
  for (let i = 0; i < storyIds.length; i++) {
    await query(
      `INSERT INTO highlight_items (highlight_id, story_id, position) VALUES (:'highlight_id', :'story_id', :position)`,
      { highlight_id: highlightId, story_id: storyIds[i] as string, position: i },
    );
  }
  await query(`UPDATE highlights SET updated_at = now() WHERE id = :'id'`, { id: highlightId });
}

function groupIntoHighlights(rows: Row[]): HighlightWithItems[] {
  const byId = new Map<string, HighlightWithItems>();
  const order: string[] = [];
  for (const row of rows) {
    const id = row.id as string;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        ownerId: row.owner_id as string,
        title: row.title as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        items: [],
      });
      order.push(id);
    }
    // A highlight with zero surviving items (none inserted yet, or every
    // Story it held has since been removed) yields one row with every
    // item column NULL via the LEFT JOINs — skip rather than push a
    // half-null item.
    if (row.story_id && row.media_id) {
      byId.get(id)!.items.push({
        storyId: row.story_id as string,
        mediaId: row.media_id as string,
        audience: row.audience as Audience,
        position: Number(row.position),
        addedAt: row.added_at as string,
      });
    }
  }
  return order.map((id) => byId.get(id)!);
}

const HIGHLIGHT_WITH_ITEMS_SELECT = `
  h.id, h.owner_id, h.title, h.created_at, h.updated_at,
  hi.story_id, hi.position, hi.added_at, s.media_id, s.audience
`;
const HIGHLIGHT_WITH_ITEMS_JOINS = `
  FROM highlights h
  LEFT JOIN highlight_items hi ON hi.highlight_id = h.id
  LEFT JOIN stories s ON s.id = hi.story_id AND s.deleted_at IS NULL
`;

export async function listForOwner(ownerId: string): Promise<HighlightWithItems[]> {
  const rows = await query(
    `SELECT ${HIGHLIGHT_WITH_ITEMS_SELECT} ${HIGHLIGHT_WITH_ITEMS_JOINS}
     WHERE h.owner_id = :'owner_id'
     ORDER BY h.created_at ASC, hi.position ASC`,
    { owner_id: ownerId },
  );
  return groupIntoHighlights(rows);
}

export async function getWithItems(id: string): Promise<HighlightWithItems | null> {
  const rows = await query(
    `SELECT ${HIGHLIGHT_WITH_ITEMS_SELECT} ${HIGHLIGHT_WITH_ITEMS_JOINS}
     WHERE h.id = :'id'
     ORDER BY hi.position ASC`,
    { id },
  );
  const grouped = groupIntoHighlights(rows);
  return grouped[0] ?? null;
}

export async function isStoryInHighlight(highlightId: string, storyId: string): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM highlight_items WHERE highlight_id = :'highlight_id' AND story_id = :'story_id' LIMIT 1`,
    { highlight_id: highlightId, story_id: storyId },
  );
  return rows.length > 0;
}

/** Used by stories.service.canAccessMediaViaStory to decide whether expiry should be bypassed at all before doing the real (audience/block/private) check. */
export async function storyIsInAnyHighlight(storyId: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM highlight_items WHERE story_id = :'story_id' LIMIT 1`, { story_id: storyId });
  return rows.length > 0;
}

export async function removeStoryFromAllHighlights(storyId: string): Promise<void> {
  await query(`DELETE FROM highlight_items WHERE story_id = :'story_id'`, { story_id: storyId });
}
