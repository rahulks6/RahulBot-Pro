-- Phase 4: voice cloning from a reference recording, only with recorded consent.
-- The consent record documents WHO agreed, HOW, and for WHAT; the evidence
-- itself (signed form, recorded statement) stays with the owner and is only
-- referenced here. Revoking consent removes the reference recording and
-- detaches every line that was synthesised from it.

CREATE TABLE voice_consents (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  voice_profile_id   TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE CASCADE,
  reference_asset_id TEXT NOT NULL REFERENCES reference_assets(id) ON DELETE CASCADE,
  speaker_name       TEXT NOT NULL,
  relationship       TEXT NOT NULL CHECK (relationship IN ('self', 'consenting_person')),
  method             TEXT NOT NULL CHECK (method IN ('self', 'written', 'recorded_statement', 'contract')),
  scope              TEXT NOT NULL DEFAULT '',
  evidence           TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoke_reason      TEXT
);
CREATE INDEX idx_voice_consents_voice ON voice_consents(voice_profile_id);

-- Which consent (if any) a synthesised line depended on.
ALTER TABLE audio_assets ADD COLUMN voice_consent_id TEXT REFERENCES voice_consents(id) ON DELETE SET NULL;
