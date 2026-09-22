# KATKEE

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Status: Phase 1 + Phase 2 + Phase 3 + Phase 4 (foundation → auth → social graph → camera/media → Stories)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API: auth, profiles, follow system (incl. private-account requests), blocking, muting, search, media upload/storage/retrieval, Story publishing + real 24h lifecycle | Built, migrated, and tested against a live database in this session — 49/49 tests passing, 4 real bugs found and fixed along the way (see `backend/README.md`) |
| `mobile/` | React Native/TypeScript design system, navigation, auth, search/follow, camera + Story editor, Story publishing + viewer | Real hand-written source, wired to the backend's actual API — not built or run here (one bug was still caught via a best-effort `tsc` pass), and Phase 3/4's camera/gesture code carries more unverified risk than 1-2 (see `mobile/README.md`) |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phases 2–12 (search, follows, camera, Story publishing, the Home feed,
recommendations, DMs, Highlights, moderation) follow the build plan laid
out earlier — each is a real, testable slice, not a wide shallow pass
across everything at once.
