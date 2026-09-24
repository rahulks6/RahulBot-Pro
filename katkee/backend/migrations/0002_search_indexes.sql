-- Phase 2: trigram indexes so user search (ILIKE '%term%') can use an index
-- instead of a sequential scan once the users table grows.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX users_username_trgm_idx ON users USING GIN (username gin_trgm_ops);
CREATE INDEX users_display_name_trgm_idx ON users USING GIN (display_name gin_trgm_ops);
