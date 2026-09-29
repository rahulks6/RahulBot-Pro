-- Phase 3: media storage. Stories/highlights (later phases) will reference
-- rows here by id rather than duplicating file metadata. Per spec section
-- 44/52, the binary itself never lives in a database row — only metadata
-- and a storage_key pointing at wherever MediaStorage actually put the
-- bytes (local disk today; see backend/src/modules/media/storage.ts for
-- why, and what swapping to S3 later would touch).

CREATE TABLE media (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind                TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    byte_size           BIGINT NOT NULL,
    width               INTEGER NULL,
    height              INTEGER NULL,
    duration_ms         INTEGER NULL,
    checksum_sha256     TEXT NOT NULL,
    storage_key         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'ready',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT media_kind_valid CHECK (kind IN ('photo', 'video')),
    CONSTRAINT media_status_valid CHECK (status IN ('processing', 'ready', 'failed')),
    CONSTRAINT media_byte_size_positive CHECK (byte_size > 0)
);

CREATE UNIQUE INDEX media_storage_key_unique ON media (storage_key);
CREATE INDEX media_owner_id_idx ON media (owner_id);
