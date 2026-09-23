# Katkee

*Story that connects.*

Story-first social network: discover people you want to see again.

This directory holds the KATKEE build, kept separate from the trading-bot
code elsewhere in this repository (`rahulks6/rahulbot-pro`) so the two
unrelated projects don't collide — see the feasibility doc from earlier in
this build for why they ended up in the same repo and what to do about it.

## Ready to deploy? Start here

**[`DEPLOYMENT.md`](./DEPLOYMENT.md)** — the actual runbook, in order:
deploy the backend for real (Docker + HTTPS), bootstrap the native mobile
project on your own machine, set up cloud builds (no Mac required), and
test before you submit (simulator → a real device via a direct build →
TestFlight/Play internal testing → full review).

**[`STORE_LISTING.md`](./STORE_LISTING.md)** — everything both stores'
submission forms actually ask for: what this codebase already satisfies
(account deletion, content reporting/blocking, no third-party login) vs.
what you still need to produce yourself (developer accounts, app icon,
screenshots, listing copy, the privacy/data-safety forms).

**[`legal/`](./legal/)** — draft Privacy Policy and Terms of Service,
written to match what this app actually collects and does (not generic
boilerplate) — both need real legal review before you publish them.

**[`BRAND.md`](./BRAND.md)** — the name, tagline, and color tokens, and
where each is already wired into the running app vs. what still needs a
real designer (app icon, splash screen, store graphics).

## Status: Phase 1-13 (foundation → auth → social graph → camera/media → Stories → engagement → recommendations → notifications → DMs → Highlights → Moderation → production hardening → deployment readiness → spec realignment)

| Package | What it is | State |
| --- | --- | --- |
| `backend/` | Node/TypeScript API: auth, profiles, follow system (incl. private-account requests), blocking, muting, search, media upload/storage/retrieval, Story publishing + real 24h lifecycle, likes/comments/shares, a real (heuristic, not ML) recommendation system with analytics events and new-creator exploration, real notifications (likes, comments, follows, follow requests, @mentions), real 1:1 direct messages (incl. sharing a Story into a conversation), a real Archive + Highlights that genuinely outlive a Story's 24h expiry, real Moderation (Reports, a moderator queue, content removal, account suspension that actually blocks login), real production hardening (rate limiting, structured request logging, a DB-backed liveness check, startup config validation), real in-app account deletion plus everything needed to actually deploy this (`Dockerfile`, `docker-compose.prod.yml`, Caddy for HTTPS), a Story's view count now public to any authorized viewer while who's behind it stays a strictly owner-only endpoint, and now real per-message DM delivery states (Sent/Delivered/Read, honestly scoped to what's observable with no push/WebSocket channel) | Built, migrated, and tested against a live database in this session — 148/148 tests passing, 16 real bugs/gaps found and fixed along the way, including two that only surfaced from actually running the compiled production build for the first time (see `backend/README.md`) |
| `mobile/` | React Native/TypeScript design system, navigation, auth, search/follow, camera + Story editor, real analytics-event emission, a real Activity tab (likes now grouped per-Story, "Rahul, Priya and 12 others liked your Story") with a polled unread badge, a real DM inbox + conversation thread (now with real per-message delivery states — Sending/Sent/Delivered/Read/Failed, tap-to-retry on a failed send) with Story sharing (incl. a Message button on another user's profile), real Highlights (create/edit/view, picked from a real Archive) rendered as an exactly-3-per-row rectangular grid, a dedicated private month-grouped multi-select Archive screen, a real Report flow (Story, comment, and account) feeding the backend's moderation queue, real account deletion, a dev/production environment split, a crash boundary, and — following a pass against the full 123-section KATKEE master spec — **Home is now the zero-tap, full-screen, auto-advancing Story feed itself** (spec sections 4-6), not a tray you tap into | Real hand-written source, wired to the backend's actual API — not built or run here (one real bug was still caught via a best-effort `tsc` pass), and the camera/gesture-heavy phases (3-6, plus this session's Home rework) carry more unverified risk than 1-2 (see `mobile/README.md`'s Phase 13 section for what's still open: drag-and-drop reordering and the deeper parts of Story Insights) |

See each package's own README for setup, what's real vs. deferred, and the
sandbox network limitation that shaped some backend implementation choices
(no npm/pip access was available while building this — full detail in
`backend/README.md`).

## What's next

Phase 13 (or whatever the build plan's remaining slices cover from here)
follows the same approach — each a real, testable slice, not a wide
shallow pass across everything at once. Outside the build plan itself,
the concrete next step is the one nothing in a sandbox can do for you:
work through `DEPLOYMENT.md` on your own machine.
