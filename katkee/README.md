# KATKEE

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Status: Phase 1 (foundation, database, authentication)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API, real Postgres schema, real signup/login/refresh/logout/me | Built, migrated, and tested against a live database in this session — 12/12 tests passing |
| `mobile/` | React Native/TypeScript design system, navigation shell, auth screens | Real hand-written source, wired to the backend's actual API — not built or run here (see `mobile/README.md`) |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phases 2–12 (search, follows, camera, Story publishing, the Home feed,
recommendations, DMs, Highlights, moderation) follow the build plan laid
out earlier — each is a real, testable slice, not a wide shallow pass
across everything at once.
