-- Phase F, Migration 2: a real ACTIVE/REMOVED_BY_MODERATION state on Stories
-- and comments, layered on top of (not instead of) the existing deleted_at
-- soft-delete both already use. deleted_at stays the single column every
-- existing query already checks to decide visibility — a moderator removal
-- still sets it, exactly as moderatorDeleteStory/moderatorDeleteComment
-- already do — so this migration changes no existing visibility behavior.
-- moderation_status is the new, additive bookkeeping that makes a
-- moderation removal specifically undoable and auditable, distinct from the
-- owner's own "delete my Story" action, which never touches this column.

ALTER TABLE stories ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE stories ADD COLUMN moderated_by UUID NULL REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE stories ADD COLUMN moderated_at TIMESTAMPTZ NULL;
ALTER TABLE stories ADD COLUMN moderation_reason TEXT NULL;
ALTER TABLE stories ADD CONSTRAINT stories_moderation_status_valid
    CHECK (moderation_status IN ('active', 'removed_by_moderation'));

ALTER TABLE story_comments ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE story_comments ADD COLUMN moderated_by UUID NULL REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE story_comments ADD COLUMN moderated_at TIMESTAMPTZ NULL;
ALTER TABLE story_comments ADD COLUMN moderation_reason TEXT NULL;
ALTER TABLE story_comments ADD CONSTRAINT story_comments_moderation_status_valid
    CHECK (moderation_status IN ('active', 'removed_by_moderation'));
