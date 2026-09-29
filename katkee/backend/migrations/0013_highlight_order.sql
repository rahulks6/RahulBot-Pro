-- Phase 13 continued: drag-and-drop reordering of Highlights themselves
-- (spec — the last major gap from the 123-section master spec pass; see
-- ../README.md's Phase 13 section). `highlight_items.position` already
-- let a Highlight's own contents be reordered (replaceHighlightItems
-- always rewrites positions from the given order) — this is the same
-- idea one level up, for the Highlights themselves.
ALTER TABLE highlights ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows to their current (creation-order) display order,
-- per owner, so this migration doesn't silently reshuffle anyone's
-- already-published Highlight row the moment it runs.
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY created_at ASC) - 1 AS rn
    FROM highlights
)
UPDATE highlights h SET position = ranked.rn FROM ranked WHERE ranked.id = h.id;

CREATE INDEX highlights_owner_position_idx ON highlights (owner_id, position);
