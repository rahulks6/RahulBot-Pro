# KATKEE

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Status: Phase 1 + Phase 2 + Phase 3 (foundation → auth → social graph → camera/media)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API: auth, profiles, follow system (incl. private-account requests), blocking, muting, search, media upload/storage/retrieval | Built, migrated, and tested against a live database in this session — 34/34 tests passing, 3 real bugs found and fixed along the way (see `backend/README.md`) |
| `mobile/` | React Native/TypeScript design system, navigation, auth, search/follow, camera capture + Story editor | Real hand-written source, wired to the backend's actual API — not built or run here, and Phase 3's camera/multitouch code carries more unverified risk than 1-2 (see `mobile/README.md`) |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phases 2–12 (search, follows, camera, Story publishing, the Home feed,
recommendations, DMs, Highlights, moderation) follow the build plan laid
out earlier — each is a real, testable slice, not a wide shallow pass
across everything at once.
