# KATKEE

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Status: Phase 1-6 (foundation → auth → social graph → camera/media → Stories → engagement → recommendations)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API: auth, profiles, follow system (incl. private-account requests), blocking, muting, search, media upload/storage/retrieval, Story publishing + real 24h lifecycle, likes/comments/shares, and a real (heuristic, not ML) recommendation system with analytics events and new-creator exploration | Built, migrated, and tested against a live database in this session — 88/88 tests passing, 6 real bugs found and fixed along the way (see `backend/README.md`) |
| `mobile/` | React Native/TypeScript design system, navigation, auth, search/follow, camera + Story editor, Story publishing + full-gesture viewer with likes/comments/sharing, real analytics-event emission | Real hand-written source, wired to the backend's actual API — not built or run here (one real bug was still caught via a best-effort `tsc` pass), and the camera/gesture-heavy phases (3-6) carry more unverified risk than 1-2 (see `mobile/README.md`) |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phase 7 (Activity/notifications) through Phase 12 (DMs, Highlights,
moderation, production hardening) follow the build plan laid out earlier —
each is a real, testable slice, not a wide shallow pass across everything
at once.
