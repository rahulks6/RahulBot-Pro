-- Phase F, Migration 5: Sponsored Story ads, deliberately folded down to a
-- non-over-engineered V1 scope per the spec's own instruction — no ad_sets/
-- ad_accounts/ad_targeting/ad_delivery tables; every delivery-event signal
-- (impression/click/hide/report/why-this-ad) folds into one ad_events
-- table, mirroring recommendation_events' (0007) same "one events table, a
-- closed event_type union" convention. advertisers/campaigns are
-- admin-managed only in V1 (no advertiser self-service login), but
-- advertiser_id is a real FK column from day one so that isn't precluded later.

CREATE TABLE advertisers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    contact_email TEXT NULL,
    created_by    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT advertisers_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE ad_campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    advertiser_id       UUID NOT NULL REFERENCES advertisers (id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft',
    daily_budget_cents  INTEGER NULL,
    starts_at           TIMESTAMPTZ NULL,
    ends_at             TIMESTAMPTZ NULL,
    -- V1 targeting: broad, non-sensitive dimensions only. Never a column
    -- for (or inference of) religion/health/sexual orientation/political
    -- affiliation — the spec forbids all four outright. JSONB arrays here
    -- (not TEXT[]) to match the one array-of-strings convention this
    -- codebase already has real, tested plumbing for (stories.overlays/
    -- drawing — see stories.repository.ts's parseJsonArray), rather than
    -- introducing a second, untested Postgres-array-literal encoding path
    -- through the psql-CLI parameter layer.
    target_countries    JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_languages    JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_min_age      INTEGER NULL,
    target_max_age      INTEGER NULL,
    target_interests    JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by          UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    reviewed_by         UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ NULL,
    rejection_reason    TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_campaigns_name_not_blank CHECK (length(btrim(name)) > 0),
    CONSTRAINT ad_campaigns_status_valid CHECK (status IN (
        'draft', 'pending_review', 'approved', 'rejected', 'active', 'paused', 'completed'
    )),
    CONSTRAINT ad_campaigns_age_range_valid CHECK (
        target_min_age IS NULL OR target_max_age IS NULL OR target_min_age <= target_max_age
    )
);

CREATE INDEX ad_campaigns_status_idx ON ad_campaigns (status);
CREATE INDEX ad_campaigns_advertiser_idx ON ad_campaigns (advertiser_id);

-- One creative per campaign is enough for V1 — nothing here assumes exactly
-- one, so rotation/A-B is just more rows later, not a schema change.
CREATE TABLE ad_creatives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID NOT NULL REFERENCES ad_campaigns (id) ON DELETE CASCADE,
    media_id      UUID NOT NULL REFERENCES media (id) ON DELETE RESTRICT,
    headline      TEXT NOT NULL,
    body_text     TEXT NOT NULL DEFAULT '',
    cta_label     TEXT NOT NULL DEFAULT 'Learn More',
    cta_url       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_creatives_headline_not_blank CHECK (length(btrim(headline)) > 0),
    CONSTRAINT ad_creatives_cta_url_not_blank CHECK (length(btrim(cta_url)) > 0)
);

CREATE INDEX ad_creatives_campaign_idx ON ad_creatives (campaign_id);

CREATE TABLE ad_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES ad_campaigns (id) ON DELETE CASCADE,
    creative_id UUID NOT NULL REFERENCES ad_creatives (id) ON DELETE CASCADE,
    viewer_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_events_type_valid CHECK (event_type IN (
        'impression', 'click', 'hide', 'report', 'why_this_ad_open'
    ))
);

CREATE INDEX ad_events_campaign_type_idx ON ad_events (campaign_id, event_type, created_at);
CREATE INDEX ad_events_viewer_campaign_idx ON ad_events (viewer_id, campaign_id, created_at);

-- A viewer who hides a specific campaign's ad never sees that campaign
-- again — state, not just a log entry (mirrors creator_not_interested's
-- (0007) same state-vs-log distinction for the organic "Not Interested" case).
CREATE TABLE ad_hidden (
    viewer_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES ad_campaigns (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (viewer_id, campaign_id)
);

-- Server-configurable frequency capping — never hard-coded. A single-row
-- config table admins can edit through the Admin Console.
CREATE TABLE ad_settings (
    id                       INTEGER PRIMARY KEY DEFAULT 1,
    min_organic_between_ads  INTEGER NOT NULL DEFAULT 5,
    max_ads_per_session      INTEGER NOT NULL DEFAULT 3,
    updated_by               UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_settings_single_row CHECK (id = 1),
    CONSTRAINT ad_settings_min_organic_nonnegative CHECK (min_organic_between_ads >= 0),
    CONSTRAINT ad_settings_max_ads_nonnegative CHECK (max_ads_per_session >= 0)
);

INSERT INTO ad_settings (id) VALUES (1);

-- "Report Ad" reuses the existing reports table/queue rather than a
-- parallel system: 'ad' is a new allowed target_type, every existing row
-- and every other constraint on this table is untouched.
ALTER TABLE reports DROP CONSTRAINT reports_target_type_valid;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_valid CHECK (target_type IN ('story', 'comment', 'user', 'ad'));
