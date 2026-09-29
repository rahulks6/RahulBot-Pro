-- 0002 built a GIN trigram index directly on `username`, but pg_trgm's
-- gin_trgm_ops operator class is only registered for `text`, not `citext`
-- (verified: querying pg_opclass shows no citext entry). The index was
-- silently unusable — EXPLAIN with enable_seqscan off still chose a seq
-- scan. Rebuild it as an expression index on username::text instead; the
-- search query is updated to match (see users.repository.ts searchUsers).

DROP INDEX IF EXISTS users_username_trgm_idx;
CREATE INDEX users_username_trgm_idx ON users USING GIN ((username::text) gin_trgm_ops);
