# KATKEE backend — Phase 1 + Phase 2 + Phase 3 + Phase 4

Real, running foundation: Postgres schema, authentication, profiles, the
follow system (including private-account follow requests), blocking, muting,
people search, media upload/storage/retrieval, and now real Story
publishing with a genuine 24-hour lifecycle — all backed by a real database
and a test suite that exercises it end to end. No mocked data anywhere in
this service.

## Known sandbox limitation (read this first)

The environment this was built in blocks `registry.npmjs.org` and
`pypi.org` at the network level (confirmed: both return `403 Host not in
allowlist`), so **no npm package could be installed**. Every runtime module
under `src/` therefore uses only Node.js built-ins:

- `src/db/psql.ts` talks to Postgres by shelling out to the `psql` CLI
  (parameters are passed via `-v name=value`, never string-concatenated —
  see the file's docstring) instead of using the `pg` driver.
- `src/modules/auth/password.ts` hashes passwords with `node:crypto`'s
  built-in scrypt instead of `bcrypt`.
- `src/modules/auth/tokens.ts` hand-rolls standards-compliant HS256 JWTs
  with `node:crypto` instead of the `jsonwebtoken` package.
- Validation (`dto.ts`) and the HTTP router/server are hand-written instead
  of using `zod`/`express`/`NestJS`.
- `src/modules/media/validation.ts` sniffs real magic bytes and parses real
  PNG/JPEG chunk structure by hand (no `file-type`/`sharp`) — even
  `apt-get install ffmpeg` was refused by this session's network policy
  (403 on every package, not just npm/pip), so there's no way to transcode
  video, generate thumbnails, or read a video's real duration/dimensions
  yet; `media.service.ts` documents exactly where that plugs in later.
- `src/modules/media/storage.ts` stores uploaded files on local disk
  behind a `MediaStorage` interface instead of an S3 SDK — no cloud
  credentials are available here either.

Every one of these is swappable behind its existing function signatures —
once npm access is available, replace `psql.ts` with the `pg` driver first
(connection pooling, real multi-statement transactions), then optionally
the others. Nothing here is a mock: it runs, it's tested, and it talks to a
real Postgres database.

## Setup

Requires Node 20+, PostgreSQL 16, and the `psql` client on PATH.

```bash
cp .env.example .env               # then fill in real secrets — see below
createdb katkee_dev                # and: createdb katkee_test
npm run migrate                    # applies migrations/*.sql in order
npm run dev                        # starts the API on :4000
```

Generate real JWT secrets rather than using the placeholders:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API with ts-node (no build step) |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Applies any `migrations/*.sql` not yet recorded in `schema_migrations` |
| `npm test` | Compiles, then runs `test/*.test.ts` against `PGDATABASE=katkee_test` with Node's built-in test runner — no test framework dependency needed |

All of the above were actually run against a live local Postgres instance
while building this: migrations applied and inspected with `\d`/`EXPLAIN`,
the server started and exercised with real `curl` requests across auth,
profiles, follow/block/mute, and search (each asserted by status code), and
the 24-case test suite passing for real — which caught two real bugs before
they shipped:

- Refresh-token rotation was writing a shared literal placeholder
  (`"pending"`) into a `UNIQUE` column before finalizing it, which
  collided under concurrent signups (`refresh_tokens_token_hash_unique`
  violation) — fixed by making the placeholder unique per call.
- The `users_username_trgm_idx` from the first search migration was
  silently unusable: `pg_trgm`'s `gin_trgm_ops` is only registered for
  `text`, not `citext` (confirmed via `pg_opclass`), so `EXPLAIN` kept
  choosing a sequential scan even with `enable_seqscan=off`. Fixed with a
  corrective migration (`0003`) rebuilding it as an expression index on
  `username::text`.

Phase 3 media upload/retrieval was verified the same way: hand-built (but
spec-valid) PNG/JPEG/MP4 fixtures uploaded via real `curl` requests,
including a genuine 30 MiB oversized upload to confirm the 413 path and
that its temp file actually gets cleaned up — plus a byte-for-byte
round-trip of a downloaded file against the original, and confirming a
second account gets 404 on someone else's media. 10 more automated tests
cover the same ground.

Media uploads accept a **raw binary body**, not `multipart/form-data` — no
multipart parser (`busboy`/`formidable`) is available either, and the
upload streams straight to a temp file on disk (hashing and enforcing the
size limit as it goes) rather than buffering the whole thing in memory, so
even large video uploads don't blow up process RAM.

Phase 4's 24-hour lifecycle was verified by actually letting a Story
expire, not by inspecting the code and trusting it: `STORY_TTL_SECONDS` is
overridable (`.env.example`), so one test publishes a Story with a 1-second
TTL, waits ~1.2 real seconds, and then asserts it's genuinely gone from
`GET /api/v1/stories/:id` (for anyone else) and `mine/active`, while the
owner can still reach it directly — the same real-time-passing technique,
just scaled down from 24h to 1s rather than mocking `Date.now()`. 49/49
tests pass, including 15 new Phase 4 tests. Building this also surfaced a
real integration gap: media was owner-only from Phase 3 (there was no
Story yet to grant broader access), which meant a Story viewer couldn't
actually load anyone else's photo/video — fixed by having the media route
ask `stories.service.canAccessMediaViaStory()` before falling back to
"not found," reusing the exact same audience/block/privacy rules rather
than re-implementing them.

## API (v1)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | liveness check |
| POST | `/api/v1/auth/signup` | – | `{username, email, password, displayName}` → `{user, tokens}` |
| POST | `/api/v1/auth/login` | – | `{email, password}` → `{user, tokens}` |
| POST | `/api/v1/auth/refresh` | – | `{refreshToken}` → `{tokens}`; single-use, rotates on every call |
| POST | `/api/v1/auth/logout` | – | `{refreshToken}` → 204; idempotent |
| GET | `/api/v1/auth/me` | Bearer access token | → `{user}` |
| GET | `/api/v1/users/:username` | Bearer | Public profile + viewer relationship flags; 404 if either side blocked the other |
| PATCH | `/api/v1/users/me` | Bearer | `{displayName?, bio?, isPrivate?}` → `{user}`; untouched fields are preserved |
| GET | `/api/v1/users/:username/followers` | Bearer | Paginated (`?limit&offset`); 403 if the account is private and you don't follow it |
| GET | `/api/v1/users/:username/following` | Bearer | Same gating as followers |
| POST | `/api/v1/users/:username/follow` | Bearer | → `{status: "following"}` immediately, or `{status: "requested"}` for a private account |
| DELETE | `/api/v1/users/:username/follow` | Bearer | Unfollows, or cancels your own pending request; idempotent |
| GET | `/api/v1/follow-requests` | Bearer | Paginated incoming pending requests |
| POST | `/api/v1/follow-requests/:id/accept` | Bearer | Must own the request; 409 if already resolved |
| POST | `/api/v1/follow-requests/:id/decline` | Bearer | Same ownership/409 rule |
| POST | `/api/v1/users/:username/block` | Bearer | Also severs any existing follow/pending-request both directions |
| DELETE | `/api/v1/users/:username/block` | Bearer | Unblocks; does **not** restore a severed follow |
| GET | `/api/v1/blocks` | Bearer | Your blocked-users list, paginated |
| POST\/DELETE | `/api/v1/users/:username/mute` | Bearer | Persisted, independent of the follow graph |
| GET | `/api/v1/mutes` | Bearer | Your muted-users list, paginated |
| GET | `/api/v1/search/users?q=` | Bearer | Substring match on username/display name; excludes yourself and any blocked relationship |
| POST | `/api/v1/media/photos` | Bearer | Raw binary body (`Content-Type: image/png` or `image/jpeg`) → `{media}`; validates real magic bytes + dimensions, 25 MiB max |
| POST | `/api/v1/media/videos` | Bearer | Raw binary body (`Content-Type: video/mp4` or `video/quicktime`) → `{media}`; validates the ISO-BMFF container, 200 MiB max |
| GET | `/api/v1/media/:id` | Bearer | Owner, or anyone permitted to view a Story built from this media (see below) |
| GET | `/api/v1/media/:id/file` | Bearer | Same access rule; streams the original bytes back, byte-for-byte |
| POST | `/api/v1/stories` | Bearer | `{mediaId, caption, audience, allowComments, allowSharing}` → `{story}`; media must be your own, `ready`, and not already published |
| GET | `/api/v1/stories/:id` | Bearer | Owner always; others need it active + visible per audience/privacy/block rules |
| DELETE | `/api/v1/stories/:id` | Bearer, owner-only | Soft-deletes; gone even to the owner afterward (unlike natural expiry) |
| POST | `/api/v1/stories/:id/view` | Bearer | Records a view once per viewer; the owner's own view never counts |
| GET | `/api/v1/stories/:id/views` | Bearer, owner-only | View count |
| GET | `/api/v1/stories/mine/active` | Bearer | Your own non-expired Stories, oldest first |
| GET | `/api/v1/stories/feed/following` | Bearer | Owners you follow (+ yourself) with an active Story, most-recent-first — raw data for Phase 5's Home, not a ranked feed |
| GET | `/api/v1/users/:username/stories` | Bearer | That user's active Stories visible to you |

Errors are JSON: `{"error": "validation_error", "fields": {...}}` (422),
`{"error": "auth_error", "message": "..."}` (401/409), or
`{"error": "not_found" | "http_error" | "internal_error", "message": "..."}`.

Pagination is `?limit` (default 20, max 50) + `?offset` — plain OFFSET-based,
which is simple and correct at Phase 2's data volumes; worth revisiting as
keyset pagination once real usage numbers make OFFSET's cost on deep pages
actually matter.

## Schema (migrations/)

`0001_init.sql`: `users`, `refresh_tokens`, `follows`, `follow_requests`,
`blocks`, `mutes` — the identity and social-graph foundation. `0002` +
`0003`: trigram search indexes (see the bugfix note above for why `0003`
exists). `0004`: `media` — metadata for uploaded photos/videos; the binary
itself lives on disk, never in a row (spec section 44/52). `0005`:
`stories` + `story_views` — a Story wraps one media row with
audience/comment/sharing settings and a server-computed `expires_at`; rows
are never hard-deleted on expiry (soft `deleted_at` only), since Archive
(Phase 9) will need the history. Highlights, conversations, and
notifications are deliberately left to their own phases so these
migrations stay reviewable.

## What's NOT in Phase 1/2/3/4

The ranked, swipeable Home feed and its gesture system (Phase 5),
recommendations/discovery beyond your own following graph (Phase 6), DMs,
Highlights, video transcoding/thumbnails, and moderation are later phases
per the build plan — this is intentionally just foundation + auth + social
graph + media + Story publishing/lifecycle, done for real rather than a
wide shallow pass across everything.
