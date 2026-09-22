# KATKEE

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Status: Phase 1-11 (foundation → auth → social graph → camera/media → Stories → engagement → recommendations → notifications → DMs → Highlights → Moderation → production hardening)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API: auth, profiles, follow system (incl. private-account requests), blocking, muting, search, media upload/storage/retrieval, Story publishing + real 24h lifecycle, likes/comments/shares, a real (heuristic, not ML) recommendation system with analytics events and new-creator exploration, real notifications (likes, comments, follows, follow requests, @mentions), real 1:1 direct messages (incl. sharing a Story into a conversation), a real Archive + Highlights that genuinely outlive a Story's 24h expiry, real Moderation (Reports, a moderator queue, content removal, account suspension that actually blocks login), and now real production hardening — rate limiting, structured request logging, a DB-backed liveness check, and startup config validation | Built, migrated, and tested against a live database in this session — 141/141 tests passing, 11 real bugs/gaps found and fixed along the way (see `backend/README.md`) |
| `mobile/` | React Native/TypeScript design system, navigation, auth, search/follow, camera + Story editor, Story publishing + full-gesture viewer with likes/comments/sharing, real analytics-event emission, a real Activity tab with a polled unread badge, a real DM inbox + conversation thread with Story sharing (incl. a Message button on another user's profile), real Highlights (create/edit/view, picked from a real Archive), and a real Report flow (Story, comment, and account) feeding the backend's moderation queue | Real hand-written source, wired to the backend's actual API — not built or run here (one real bug was still caught via a best-effort `tsc` pass), and the camera/gesture-heavy phases (3-6) carry more unverified risk than 1-2 (see `mobile/README.md`); no mobile changes were needed for Phase 11 — its error-message plumbing already surfaces a rate-limit response correctly |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phase 12 (or whatever the build plan's remaining slices cover from here)
follows the same approach — each a real, testable slice, not a wide
shallow pass across everything at once.
