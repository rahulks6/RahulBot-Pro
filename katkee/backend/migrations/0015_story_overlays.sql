-- Camera + Editor module: the editor already lets a user add text overlays
-- and pick a filter, but StoryEditorScreen.onShare never sent either to the
-- backend — every edit vanished on publish. This closes that gap and adds
-- storage for the module's other object types (emoji/mention/location/
-- datetime/sticker) and freehand drawing.
--
-- Overlays are stored as structured JSON, not baked into pixels — this is
-- what lets a mention stay a real, tappable reference to a live user (and
-- respect blocks/deletion/username changes at *view* time, resolved in
-- stories.service.ts) rather than a permanently-rendered "@username" that
-- can go stale or point at someone who blocked the poster after the fact.
--
-- Each overlay: {id, type, x, y, scale, rotation, zIndex, properties}
-- x/y/scale are normalized to the media's own box (0..1-ish), not device
-- pixels, so a Story renders consistently across different screen sizes —
-- see mobile/src/models/storyDraft.ts.
ALTER TABLE stories ADD COLUMN overlays JSONB NOT NULL DEFAULT '[]';
ALTER TABLE stories ADD COLUMN drawing JSONB NOT NULL DEFAULT '[]';
ALTER TABLE stories ADD COLUMN filter TEXT NOT NULL DEFAULT 'original';
