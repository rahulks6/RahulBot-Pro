-- Phase F, Migration 4: server-configurable feature flags. The new spec
-- requires ADMIN_CONSOLE_ENABLED / ADS_ENABLED / SPONSORED_STORIES_ENABLED /
-- AD_REPORTING_ENABLED to gate every new surface, and requires ads-related
-- behavior to be identical to today whenever they're off. ADMIN_CONSOLE_ENABLED
-- defaults on since the console is a wholly separate surface with zero effect
-- on the consumer app; every ads-related flag defaults off so this migration
-- alone changes nothing a consumer-app user can see.
CREATE TABLE feature_flags (
    key         TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    updated_by  UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, enabled) VALUES
    ('ADMIN_CONSOLE_ENABLED', true),
    ('ADS_ENABLED', false),
    ('SPONSORED_STORIES_ENABLED', false),
    ('AD_REPORTING_ENABLED', false);
