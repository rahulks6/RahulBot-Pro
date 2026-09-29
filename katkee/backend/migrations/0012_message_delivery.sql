-- Phase 13: real per-message delivery states (spec: Sending/Sent/
-- Delivered/Read/Failed). Sending and Failed are purely client-local (a
-- message that exists here is definitionally at least "sent") — Sent,
-- Delivered, and Read are the three server-observable states, and
-- conversation_reads already tracks one of them (last_read_at). This adds
-- the other real, honestly-scoped signal this backend can actually
-- observe: last_delivered_at, bumped whenever a participant's client
-- fetches messages (GET .../messages) — there's no push/WebSocket channel
-- in this build, so "delivered" means "reached the recipient's client on
-- a real fetch," not "pushed to a device while backgrounded."
ALTER TABLE conversation_reads ADD COLUMN last_delivered_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch';

-- Reading something obviously means it was also delivered — keep the
-- invariant true for rows that predate this column (all default to
-- 'epoch' above) by backfilling delivered up to each row's own read time.
UPDATE conversation_reads SET last_delivered_at = last_read_at WHERE last_read_at > last_delivered_at;
