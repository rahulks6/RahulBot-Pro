ALTER TABLE highlights
  ADD COLUMN cover_story_id UUID REFERENCES stories(id) ON DELETE SET NULL;
