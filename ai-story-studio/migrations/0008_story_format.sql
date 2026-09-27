-- v1.2: a story can be made for 9:16 (Shorts re-drawn natively in vertical format).
-- Additive only. Rollback: restore the automatic backup in data/backups.
ALTER TABLE stories ADD COLUMN format TEXT NOT NULL DEFAULT 'landscape' CHECK (format IN ('landscape', 'vertical'));

-- Each Short is made from its own vertical story.
ALTER TABLE video_shorts ADD COLUMN story_id TEXT REFERENCES stories(id) ON DELETE SET NULL;
ALTER TABLE video_shorts ADD COLUMN thumbnails_json TEXT NOT NULL DEFAULT '[]';
