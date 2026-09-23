# KATKEE backend — Phase 1 through Phase 12

Real, running foundation: Postgres schema, authentication, profiles, the
follow system (including private-account follow requests), blocking, muting,
people search, media upload/storage/retrieval, Story publishing with a
genuine 24-hour lifecycle, likes/comments/shares, a real (heuristic,
not ML — see below) recommendation system with analytics event collection
and new-creator exploration, real notifications (likes, comments, follows,
follow requests, and @mentions), real 1:1 direct messages (including
sharing a Story into a conversation), a real Archive + Highlights
(named collections of a user's own past Stories that outlive the normal
24h expiry), real Moderation (user-filed Reports, a moderator queue,
content removal, and account suspension that actually blocks login),
real production hardening (rate limiting, structured request logging, a
liveness check that actually pings the database, and startup config
validation), and now real in-app account deletion plus everything needed
to actually deploy this to a live server and submit it to the App Store
and Play Store (see `../DEPLOYMENT.md` and `../STORE_LISTING.md`) — all
backed by a real database and a test suite that
exercises it end to end. No mocked data anywhere in this service.

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

## Phase 6: the recommendation system is a real heuristic, not a model

There is no training data — the platform is brand new — so
`src/modules/recommendations/scoring.ts` is deliberately **not** a trained
model or an ML dependency (none is installed here anyway). It's a
deterministic, documented, unit-tested formula over real counted signals:
Bayesian-smoothed engagement rates, a freshness decay, a new-creator
exploration multiplier, and a weighted affinity sum using the exact
starting percentages spec section 7 proposes (10% qualified watch, 10%
completion, 10% sequence continuation, 10% profile visit, 20% follow, 20%
meaningful reply, 20% repeat-day visit). Every input is a real row —
follows, comments, or a `recommendation_events` row a client genuinely
posted and the server validated — never a placeholder. Spec section 7
calls this out explicitly: "configurable starting weights, NOT hard-coded
permanent truth" — replacing `scoring.ts`'s formula with an actual trained
model later is expected, and doesn't require touching anything that calls
it (`recommendation.service.ts` only depends on `scoring.ts`'s function
signatures).

`GET /api/v1/stories/feed/home` scores every eligible candidate (up to
~250 — see `recommendation.repository.ts`) on every request; there's no
caching or precomputation. That's a real, known cost, not hidden: the test
suite's own `feed/home` calls got measurably slower over the course of
this session as more test data accumulated in the shared test database
(the same `pretest` reset from Phase 5 keeps it bounded per run). Fine at
today's scale; a real product would precompute/cache candidate scores
rather than scoring the whole eligible set synchronously per request.

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

For an actual production deployment (a real server, real HTTPS, a
container instead of `ts-node`), see `Dockerfile`, `docker-compose.prod.yml`,
`Caddyfile`, and `../DEPLOYMENT.md` — the full runbook, in order, through
submitting the mobile app to both stores.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API with ts-node (no build step) |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Applies any `migrations/*.sql` not yet recorded in `schema_migrations` (via `ts-node`, for local dev) |
| `npm run migrate:prod` | Same, but runs the compiled `dist/scripts/migrate.js` — what a deployed container actually runs, since it has no `ts-node` |
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
just scaled down from 24h to 1s rather than mocking `Date.now()`. Building
that phase also surfaced a real integration gap: media was owner-only from
Phase 3 (there was no Story yet to grant broader access), which meant a
Story viewer couldn't actually load anyone else's photo/video — fixed by
having the media route ask `stories.service.canAccessMediaViaStory()`
before falling back to "not found," reusing the exact same
audience/block/privacy rules rather than re-implementing them.

Phase 5 (likes/comments/shares) reuses that same `getStoryForViewer` access
check everywhere — liking, commenting, and sharing a Story you can't view
are all denied the identical way viewing it would be, rather than each
action inventing its own rule. It also caught a real test-hygiene bug: by
this point the test database had accumulated hundreds of `test_*` users
across every `npm test` run all session, and the search test's substring
query eventually stopped finding its own freshly-created user within the
default 20-row page — not a Phase 5 regression, but real flakiness from
never resetting test data. Fixed with a `pretest` npm script
(`scripts/reset-test-db.ts`) that truncates the test database before every
run. 59/59 tests pass (10 new).

Phase 6 was verified two ways: `test/scoring.test.ts` unit-tests the pure
scoring math directly (smoothing pulls toward the prior, freshness decays
monotonically toward a floor, exploration fades to 1.0, a follower
outscores an otherwise-identical stranger, a repeat visitor outscores a
one-time one) — fast, no database needed. `test/recommendations.test.ts`
then exercises the real endpoints end to end: event validation per type,
a story-scoped event rejected for a Story the poster can't see (reusing
Story access rules), Not Interested actually removing a creator from that
one viewer's feed (and confirming it does *not* affect another viewer),
a public creator surfaced without being followed, and a followed creator
outranking an equivalent unfollowed one. Manual `curl` testing also
confirmed this live: following a previously-last-ranked creator
mid-session immediately moved them to first place. 88/88 tests passing
(29 new).

Phase 7 (notifications) reuses the same pattern as Phase 4/5's access
checks: every notification-creating call site (`likeStory`, `createComment`,
`follow`, `acceptFollowRequest`) fires through `notifications.service.ts`
rather than each feature writing its own notification row, and
`createNotification()` itself refuses to notify someone about their own
action (`actorId === recipientId`). Building it surfaced a real duplicate-
notification bug before it shipped: `likesRepo.likeStory` originally
returned `void`, so the idempotent like endpoint would have fired a fresh
"like" notification on every repeat call even though the underlying
`story_likes` row never changed — fixed by having it `RETURNING story_id`
and only notifying when a row was actually inserted
(`test/notifications.test.ts`'s first test asserts this directly: liking
the same Story three times produces exactly one notification).
`socialRepo.createFollowRequest` had the same shape of fix applied
proactively (`RETURNING id`, so `follow()` can pass the new request's real
id into `notifyFollowRequest` instead of a second lookup). @mention
detection (`notifyMentions`) is a real regex over comment bodies
(`/@([a-z0-9_.]{3,30})/gi`, capped at 10 distinct mentions per comment),
resolving each to a real user via `usersRepo.findUserByUsername` — unknown
usernames and self-mentions are silently skipped, the same way a typo in a
real app's mention just doesn't link anyone. 100/100 tests passing (12
new), plus manual `curl` verification of follow/like/mark-read/mark-all-read
against a live server.

Phase 8 (1:1 direct messages) uses a canonically-ordered pair schema
(`conversations.user_a_id < user_b_id`, `UNIQUE (user_a_id, user_b_id)`)
rather than a membership table — find-or-create a conversation is a single
indexed lookup, not a join, and group DMs aren't in scope for this pass
(nothing through Phase 8 needs them). Sharing a Story into a conversation
(spec section 15's "Send to a Katkee user") reuses
`engagement.service.shareStory` wholesale — the exact same
view-access/`allowSharing` check and the exact same `story_shares`
analytics row as the Share sheet's other two options, not a parallel
implementation that could drift out of sync or skip the privacy check.
Building this also closed a gap Phase 7 had explicitly documented rather
than faked: a mention notification's Story can belong to anyone (unlike
a like/comment, where the recipient is always the owner), and the mobile
client had no way to resolve who that owner was. The fix is a small,
reusable addition — `getStoryOwnerUsername()` / `GET
/api/v1/stories/:id/owner`, gated by the same `getStoryForViewer` access
rules as the Story itself — used by both the DM shared-Story bubble and
(retroactively) the Activity tab's mention deep-link. 113/113 tests
passing (13 new: 12 for conversations, 1 for the owner-lookup endpoint),
plus manual `curl` verification of opening a conversation, sending a
text message, sharing a Story into one, and resolving its owner, against
a live server.

## Phase 9: Highlights genuinely outlive a Story's 24h expiry

The whole point of a Highlight is that it keeps a Story visible after the
rule that governs every other Story stops applying — so this phase
couldn't just reuse `getStoryForViewer` as-is; it had to make the expiry
check itself an explicit, narrow exception. `stories.service.ts`'s access
logic was refactored into one shared `checkStoryAccess(storyId, viewerId,
{ ignoreExpiry? })` core, with `getStoryForViewer`/`getStoryForHighlightViewer`
as thin wrappers over it — block/private-account/audience rules apply
identically either way; only expiry is conditional, and the Highlight
variant is only ever reached after a caller has independently confirmed
the Story is a real member of a Highlight (`highlights.repository
.storyIsInAnyHighlight` / `isStoryInHighlight`), never as a blanket
bypass. `canAccessMediaViaStory` got the same fallback, one level deeper —
without it, a Highlight's cover image and item media would 404 for
anyone but the owner the moment the underlying Story expired, which would
have made the whole feature pointless for a non-owner viewer.

Building this also finally exercised a forward reference left in
migration 0005 back in Phase 4 ("Archive will need the history" — Stories
are soft-deleted, never hard-deleted, specifically so this day would
come): `GET /api/v1/stories/mine/archive` lists every non-deleted Story
an owner has ever published, expired or not, and it's exactly what a
Highlight's story picker is built from. Deleting a Story now also cleans
it out of every Highlight it was ever added to
(`highlights.repository.removeStoryFromAllHighlights`, called from
`stories.service.deleteStory`) — "gone even to the owner afterward" (the
Phase 4 deletion behavior) has to mean gone from Highlights too, not a
loophole where a "deleted" Story keeps rendering forever inside one.

A Highlight's cover is deliberately not a stored column — it's computed
as its first item's Story media, so this pass doesn't need a separate
cover-image upload/crop flow (this sandbox still has no image processing;
see the media limitations above). 123/123 tests passing (10 new: create/
rename/replace-items/delete, ownership and audience gating on both the
Highlight list and detail, the expiry-bypass behavior end to end via a
real 1-second-TTL Story, membership enforcement on the item-detail
endpoint, and Story-deletion cleanup), plus manual `curl` verification of
the full create → list → detail → item-detail → archive flow against a
live server.

## Phase 10: Moderation, and finally wiring up `is_active`

`users.is_active` has existed since migration 0001 and been checked at
login since Phase 1 — but nothing could ever set it to `false` until this
phase gave it a real caller. Building the suspend action surfaced a real
security gap worth fixing rather than working around: `auth.service.ts`'s
`refresh()` rotated a still-valid refresh token into a fresh access token
without ever re-checking whether the user behind it was still active — so
a suspended account with an unexpired refresh token could just keep
refreshing forever, completely bypassing the suspension `login()` was
supposed to enforce. Fixed by having `refresh()` re-fetch the user and
reject if `!isActive`, and having `moderation.service.ts`'s `suspendUser`
also revoke every refresh token the account currently holds
(`refreshTokensRepo.revokeAllRefreshTokensForUser` — already existed,
just never had a caller either). One gap remains and is deliberately not
"fixed" by adding a DB round-trip to every authenticated request: a
short-lived access token (`JWT_ACCESS_TTL_SECONDS`, default 900s) issued
just *before* a suspension stays cryptographically valid for the rest of
its own TTL, since `requireAuth` is a stateless JWT check by design (see
the sandbox limitations above for why — no `pg` driver, no session
store). A ≤15-minute window is a real, bounded, documented tradeoff, not
an oversight.

Reports are deliberately polymorphic at the application layer, not the
database's: `reports.target_id` has no FK, because a report can point
into `stories`, `story_comments`, or `users`, and nothing here validates
"does this id exist in the right table" except `moderation.service.ts`'s
own `assertReportableAndNotSelf` — the same tradeoff
`recommendation_events` already made for its own optional
story/creator references, just without even a typed FK this time since
the target table varies per row. There's also deliberately no self-serve
"become a moderator" endpoint — `users.is_moderator` is granted directly
in the database (`UPDATE users SET is_moderator = true WHERE username =
'...'`), the same way `test/moderation.test.ts` bootstraps it for tests.
That's a real security decision, not a missing feature: a public
escalation path would defeat the entire point of gating the queue.

Removing reported content reuses the exact deletion paths Phase 4/5
already built rather than duplicating them — `stories.service
.moderatorDeleteStory` and `engagement.service.moderatorDeleteComment`
are privileged siblings of `deleteStory`/`deleteComment` (no ownership
check, everything else identical, including Highlight cleanup for a
removed Story) so a moderator-removed Story or comment behaves exactly
like a self-deleted one everywhere else in the app. 135/135 tests
passing (12 new: filing reports across all three target types, self-report
and nonexistent/already-deleted-target rejection, moderator-only gating
on the queue and every moderation action, FIFO queue ordering with
denormalized reporter/target info, dismiss vs. remove_content vs.
suspend_user — including a real end-to-end check that suspension blocks
both a fresh login *and* an outstanding refresh token — action/target-type
mismatch rejection, and double-resolution rejection), plus manual `curl`
verification of the full report → queue → suspend → login-denied flow
against a live server.

## Phase 11: production hardening

Four real, independently testable pieces, not a vague "harden everything"
pass:

- **Rate limiting** (`src/http/rateLimiter.ts` + `rateLimiters.ts`): an
  in-memory, fixed-window limiter — the honest tradeoff for a
  single-process sandbox with no Redis/shared store (see the file's own
  comment; it resets on restart and doesn't coordinate across instances,
  and that's documented as the first thing to swap if this ever runs
  behind a load balancer). A generous global limiter (600 req/min/IP by
  default) sits in front of every request in `server.ts`; a much stricter
  one (10 requests per 15 minutes per IP by default) is applied
  specifically to `/api/v1/auth/signup`, `/login`, and `/refresh` in
  `auth.routes.ts` — sharing one budget across all three, since an
  attacker guessing passwords and an attacker mass-creating accounts are
  the same shape of abuse against that endpoint family. The client IP
  comes straight from the raw socket, not an `X-Forwarded-For` header —
  trusting that header without also configuring which upstream proxies to
  trust would let a client spoof it and evade the limiter entirely; a
  deployment that adds a reverse proxy needs to update `clientIp()` after
  establishing that trust.
- **Structured request logging** (`server.ts`'s `logRequest`): one JSON
  line per request (`ts`, `method`, `path`, `status`, `durationMs`, `ip`)
  to stdout — real production observability without an external logging
  package (this sandbox can't install one anyway). Query strings are
  stripped from the logged path on principle, even though nothing here
  puts secrets in one today.
- **A real liveness check**: `GET /health` now runs an actual `SELECT 1`
  and reports `{status: "degraded", db: "down"}` at 503 if it fails,
  instead of a static 200 that would look identical whether the database
  — or the `psql` process spawn itself — was healthy or not.
- **Startup config validation** (`config/env.ts`): `JWT_ACCESS_SECRET`
  and `JWT_REFRESH_SECRET` must now each be at least 32 characters and
  must differ from each other, or the process refuses to start. The
  access/refresh token `type` claim already prevented cross-use even if
  the secrets matched (`tokens.ts`), but a weak or duplicated secret
  shouldn't be allowed to reach production in the first place, and
  failing fast at startup is cheaper than failing quietly at 3am.

`server.headersTimeout` is also set to 10s — headers should always arrive
quickly regardless of a request's body size, so this specifically blunts
a slow/trickling-headers (slowloris-style) connection without punishing a
legitimate large video upload on a slow network, which still gets
`requestTimeout`'s generous default (Node's own 5 minutes, left
untouched on purpose).

141/141 tests passing (6 new: the `RateLimiter` class's own budget/
per-key-isolation/window-reset/`reset()` behavior as pure unit tests, plus
one HTTP-level test that exhausts a real per-IP auth budget against a live
server instance and confirms the 429 — using a tight, file-scoped
`RATE_LIMIT_AUTH_MAX` override that doesn't affect any other test file,
since every other test's much more generous default lives in
`test/env.ts`). Manually smoke-tested against a live server: `GET
/health` reporting real DB status, the structured log lines appearing on
stdout for both successful and rate-limited requests, and 10 real signups
succeeding followed by the 11th and 12th genuinely receiving 429 with a
`Retry-After`-style message.

## Phase 12: real deployment — account deletion, Docker, and two real bugs

Preparing to actually deploy this (see `../DEPLOYMENT.md` and
`../STORE_LISTING.md`) surfaced two real, previously-undiscovered
production-path bugs — every prior phase's testing went through
`npm run dev` (ts-node, source directly) or `npm test` (which runs
`dist/test/*.js` directly), and neither ever exercised the actual
"compile once, run the compiled output" path a real deployment uses:

- **`npm start` was broken.** `package.json` pointed it at
  `dist/index.js`; the real compiled entry point (given
  `tsconfig.json`'s `rootDir: "."`) is `dist/src/index.js`. Running
  `npm run build && npm start` crashed on a module-not-found error every
  single time — confirmed by actually running it, not inferred. Fixed.
- **The compiled migration runner was broken the same way.**
  `scripts/migrate.ts` resolved `MIGRATIONS_DIR` from `__dirname`, which
  points into `dist/scripts/` once compiled — and `migrations/*.sql` is
  never copied there (`tsc` only compiles `.ts` files). `npm run
  migrate:prod` (the new script this phase added specifically for a
  container that has no `ts-node`) failed with `ENOENT` until fixed to
  resolve from `process.cwd()` instead — the same reasoning
  `config/env.ts` and `media/storage.ts` already documented for exactly
  this class of bug, just never applied here. Both fixes were verified
  by actually running the compiled build against a live database, not
  just read for plausibility.

**Real, in-app account deletion** (`DELETE /api/v1/users/me`,
password-confirmed) exists now because App Store review guideline
5.1.1(v) requires it for any app that supports account creation — this
isn't optional polish, a submission is rejected outright without it.
`profiles.service.deleteMyAccount` soft-deletes the account's own active
Stories first (reusing Phase 10's `moderatorDeleteStory`, Highlight
cleanup included), then the account itself, then revokes every refresh
token it holds — reusing the exact same `deleted_at`-filtering and
`revokeAllRefreshTokensForUser` machinery Phase 4's Story deletion and
Phase 10's suspension already built, rather than inventing a third way to
make something disappear. What's deliberately *not* scrubbed — comments
left on other people's Stories, DM history — is a documented scope
decision (see the function's own comment and `../legal/PRIVACY_POLICY.md`),
not an oversight.

Building this surfaced one more real gap: `server.ts` only read a request
body for POST/PUT/PATCH — DELETE was never included, even though HTTP
(RFC 7231) doesn't forbid a body on DELETE and this endpoint's password
confirmation needs one. Fixed by adding DELETE to the body-reading list;
every existing DELETE route sends no body at all, so this is additive,
not a behavior change for any of them (verified: all pre-existing DELETE
tests still pass unmodified).

**Real deployment artifacts**: `Dockerfile` (two-stage — the backend has
zero runtime npm dependencies, so the final image only needs Node, the
compiled `dist/`, and the `psql` CLI db/psql.ts shells out to),
`docker-compose.prod.yml` (Postgres + backend + Caddy for automatic,
auto-renewing HTTPS — required, not optional, since iOS blocks plain
HTTP by default), and a `Caddyfile`. None of these have been built or run
inside an actual container in this sandbox — no Docker daemon is
available to me here (confirmed by trying) — so they're written against
standard, well-documented Compose/Dockerfile patterns and this backend's
own real npm scripts rather than tested end-to-end; run `docker compose
-f docker-compose.prod.yml config` yourself first, the same "verify
before trusting further" standard every untestable piece of this project
has been held to.

145/145 tests passing (4 new: wrong-password rejection, a full real
deletion verified end-to-end — profile gone, login blocked, the
outstanding refresh token invalidated, the username/email freed for
reuse by a fresh signup — and active-Story cleanup). Manually
smoke-tested against a live server: wrong password → 401 with nothing
touched, correct password → 204, then profile/login/refresh all
confirmed genuinely blocked afterward.

## Phase 13: a Story's view count is public; who's behind it isn't

A pass of the mobile app against the full 123-section KATKEE master spec
(driven from the mobile side — see `../mobile/README.md`'s Phase 13
section for the fuller list of what that pass changed) turned up one real
backend gap: `GET /api/v1/stories/:id/views` rejected anyone but the
Story's own owner outright, but the spec (and the product owner, directly)
wants the count itself visible to *any* viewer while they're watching —
same as how many people can watch it in the first place — while the
identities behind that number stay private to the owner alone.

`stories.service.ts`'s `getViewCount` now reuses `getStoryForViewer`'s
full access-check rule set (audience, blocks, private-account gating)
instead of an ownership check — anyone who could watch the Story can see
its count. The identities are a genuinely separate door: a new
`getStoryViewers(ownerId, storyId, limit, offset)` + `stories.repository.ts`'s
new `listViewers` (joins `story_views` to `users`, ordered most-recent
first), reachable only via the new owner-only `GET
/api/v1/stories/:id/viewers` route — anyone else gets a 404, same as
fetching a Story they have no business seeing at all.

147/147 tests passing (2 new: a follower can now see a public view count
they wouldn't previously have been allowed to, while both a non-owner
follower and a stranger are still rejected from the identity-list
endpoint; a stranger with no access to the Story at all still can't see
even the count).

## Phase 13 continued: real per-message DM delivery states

The same spec pass called for Sending/Sent/Delivered/Read/Failed
per-message status (spec sections 32-33). Sending and Failed never reach
the backend at all — they're purely client-local (an outgoing message
that exists in this database is definitionally at least "sent"; see
`../mobile/README.md`'s Phase 13 section for the client-side optimistic-
send/retry mechanics). Sent, Delivered, and Read are the three states this
backend can genuinely observe, and — same honesty standard as everything
else this sandbox couldn't fully build (no npm registry, no Docker
daemon, no image library) — "Delivered" here means what it can actually
mean with no push/WebSocket channel available: the recipient's client
performed a real fetch and received the message, not "pushed to their
device while backgrounded."

`conversation_reads` already tracked `last_read_at` per participant
(Phase 8); migration `0012_message_delivery.sql` adds a second watermark,
`last_delivered_at`, bumped by the new `markDelivered` (repository) every
time a participant calls `GET .../messages` — any page, not just the
first, since even loading older history proves the client is online and
synced through now. `markRead` now bumps both watermarks together (reading
obviously implies delivery too). `conversations.service.ts`'s `listMessages`
computes a `status` field for the viewer's own messages only (comparing
each message's `createdAt` against the *other* participant's watermarks —
never the viewer's own) — a message from the other participant carries no
`status` at all, since there's nothing to show a viewer about the delivery
of a message they received themselves.

148/148 tests passing (1 new: a message's status progresses sent →
delivered → read as the recipient first fetches, then explicitly marks
read, while a message from someone else never carries a status field for
the viewer at all).

## Phase 13 continued: Highlights can be reordered

The same spec pass called for drag-and-drop reordering, both of a
Highlight's own contents and of Highlights themselves (spec). Content
order already had a real answer — `highlight_items.position`, rewritten
in full by `replaceHighlightItems` on every edit — so only Highlights'
*own* display order needed new schema: migration `0013_highlight_order.sql`
adds a `position` column to `highlights` itself, backfilled to each
owner's existing creation order so the migration doesn't reshuffle anyone
already-published on the day it runs. `createHighlight` now assigns a new
Highlight `MAX(position) + 1` (joins the end, same idea as a fresh item
joining the end of a Highlight's own contents), and `listForOwner` orders
by `position` first.

`reorderHighlights` (service) takes the client's *entire* new order and
requires it to be exactly the caller's current Highlight set — same
"full replace, not a diff/patch" shape as `replaceHighlightItems` one
level down. A stale client, a missing id, or someone else's Highlight id
smuggled into the array are all real bugs to catch immediately (422), not
silently drop, duplicate, or reassign to the wrong owner.

150/150 tests passing (2 new: a full reorder persists and a freshly-
created Highlight still joins the end, not the start; a partial or
foreign-id set is rejected outright).

## Phase 13 continued: deeper Story Insights

The mobile pass's own gap list called out "Views vs. Viewers, completion
%, discovery/following/profile-visit breakdown, per-Story and per-
sequence Insights" as still open after the view-count and viewer-list
work earlier in Phase 13. This closes it with real numbers computed from
events this backend already records — nothing invented, and every
approximation this makes is disclosed rather than hidden (see
`../mobile/README.md`'s Phase 13 caveats for the reader-facing version of
the same tradeoffs).

`stories.repository.ts`'s new `getStoryInsights`/`getSequenceInsights`
are each a single SQL query (`story_views` joined against `follows`, and
against two `recommendation_events` subqueries) rather than N round-trips
per viewer:
- **View count**: `story_views`, same table the existing viewer list
  already uses (this *is* "Views" and "Viewers" together — the schema's
  `(story_id, viewer_id)` primary key means a distinct viewer only ever
  counts once, so there's no separate "raw views vs. unique viewers"
  distinction to make here).
- **Completion rate**: the fraction of a Story's viewers who also have a
  `story_complete` event for it — the same recommendation-scoring signal
  Phase 6 already records for every Story (spec section 13), reused
  rather than inventing a second "did they finish" event type.
- **Following vs. discovery**: each viewer's *current* row in `follows` —
  disclosed, not hidden, as an approximation: this schema keeps no
  historical snapshot of what the relationship was at view time.
- **Profile-visit rate**: the fraction of a Story's viewers who have ever
  fired a `profile_visit` event for the owner (creator-scoped, not
  Story-scoped in the schema — same disclosed-approximation reasoning).

`getSequenceInsights` is the same shape one level up — every currently-
active Story the owner has, at once (spec: "per-sequence Insights", the
run a viewer swipes through for one creator). Its "completed" reuses
`creator_sequence_completed` (reached the end of the *whole* sequence)
rather than `story_complete`, which would wrongly count someone who
finished only the first Story of five as a completion.

Both are owner-only, same door as the existing viewer list
(`GET /api/v1/stories/:id/viewers`) — a non-owner gets 404, not partial
data.

153/153 tests passing (3 new: a full view/completion/following/discovery/
profile-visit scenario computed correctly and rejected for a non-owner; a
Story nobody has viewed yet returns all zeros rather than dividing by
zero; a sequence aggregate across two Stories counts a viewer who watched
both exactly once, not twice).

## Phase 13 continued: following-vs-discovery is a real snapshot, not a live lookup

The Insights work above shipped with one disclosed approximation:
"following vs. discovery" came from a *live* `follows` join, so it
reflected each viewer's relationship to the owner as of whenever someone
happened to check Insights — not what it actually was the moment that
viewer watched the Story. This closes that gap for real.

Migration `0014_story_view_follow_snapshot.sql` adds `story_views.was_following`.
`recordView` now sets it once, at INSERT time, from a real `EXISTS` check
against `follows` — and because `ON CONFLICT (story_id, viewer_id) DO
NOTHING` already made this table idempotent per viewer, a repeat view
never overwrites it, so what's stored is genuinely "were they already
following the very first time they saw this," not whatever their
relationship happens to be by the time anyone looks. `getStoryInsights`
now reads `sv.was_following` directly — the `follows` join is gone
entirely, not just replaced. `getSequenceInsights` uses a `DISTINCT ON`
over each viewer's *most recent* view within the sequence, since the same
viewer can appear across more than one of an owner's active Stories and
their relationship could plausibly have changed between those views —
their latest view's snapshot is the one that answers "were they
following by the time they were watching this run."

Existing rows (recorded before this migration existed) are backfilled
using each viewer's *current* relationship at migration time — the same
approximation the live join made, but frozen at that one moment rather
than drifting forever; every view recorded from here on gets the real
thing.

"Profile visits" stays exactly as it was — a disclosed approximation,
not a bug: `profile_visit` is already creator-scoped, not story-scoped,
in the event schema itself (spec section 11's own event taxonomy), so
there's no per-Story causal link to snapshot in the first place.

153/153 tests passing (1 new: a viewer who watches as a stranger and
follows five minutes later still shows as discovery, not following, both
immediately after the view and again after the follow — proving this is
actually a snapshot and not a join that would silently flip once they
followed).

## API (v1)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | Real liveness check — pings the database; 200 `{db: "up"}` or 503 `{db: "down"}` |
| POST | `/api/v1/auth/signup` | – | `{username, email, password, displayName}` → `{user, tokens}` |
| POST | `/api/v1/auth/login` | – | `{email, password}` → `{user, tokens}` |
| POST | `/api/v1/auth/refresh` | – | `{refreshToken}` → `{tokens}`; single-use, rotates on every call |
| POST | `/api/v1/auth/logout` | – | `{refreshToken}` → 204; idempotent |
| GET | `/api/v1/auth/me` | Bearer access token | → `{user}` |
| GET | `/api/v1/users/:username` | Bearer | Public profile + viewer relationship flags; 404 if either side blocked the other |
| PATCH | `/api/v1/users/me` | Bearer | `{displayName?, bio?, isPrivate?}` → `{user}`; untouched fields are preserved |
| DELETE | `/api/v1/users/me` | Bearer | `{password}` → 204; permanently deletes the account (password-confirmed, irreversible) — see "Phase 12" above |
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
| GET | `/api/v1/stories/:id` | Bearer | Owner always; others need it active + visible per audience/privacy/block rules; includes `likeCount`/`commentCount`/`viewerHasLiked` |
| DELETE | `/api/v1/stories/:id` | Bearer, owner-only | Soft-deletes; gone even to the owner afterward (unlike natural expiry) |
| POST | `/api/v1/stories/:id/view` | Bearer | Records a view once per viewer; the owner's own view never counts |
| GET | `/api/v1/stories/:id/views` | Bearer, any authorized viewer | View count — public to anyone who can watch the Story (Phase 13), not owner-only |
| GET | `/api/v1/stories/:id/viewers` | Bearer, owner-only | The identities behind that count — strictly the Story's own owner (Phase 13) |
| GET | `/api/v1/stories/:id/insights` | Bearer, owner-only | Completion %, following-vs-discovery split, profile-visit rate for this one Story (Phase 13) |
| GET | `/api/v1/stories/mine/sequence-insights` | Bearer | The same, aggregated across every currently-active Story the caller owns — "per-sequence Insights" (Phase 13) |
| GET | `/api/v1/stories/mine/active` | Bearer | Your own non-expired Stories, oldest first |
| GET | `/api/v1/stories/feed/following` | Bearer | Owners you follow (+ yourself) with an active Story, most-recent-first — real, but plain follow-graph order, not ranked |
| GET | `/api/v1/users/:username/stories` | Bearer | That user's active Stories visible to you |
| POST\/DELETE | `/api/v1/stories/:id/like` | Bearer | Idempotent; needs the same view access as the Story itself |
| POST | `/api/v1/stories/:id/comments` | Bearer | `{body}` (1-500 chars) → `{comment}`; respects the Story's `allowComments` (`everyone`\/`followers`\/`disabled`) — the owner can always comment on their own |
| GET | `/api/v1/stories/:id/comments` | Bearer | Paginated, oldest first; only needs Story view access, not comment-post permission |
| DELETE | `/api/v1/comments/:id` | Bearer | The comment's author, or the Story's owner (moderation), can delete it |
| POST | `/api/v1/stories/:id/share` | Bearer | Records a share event; 403 if the Story's `allowSharing` is false |
| GET | `/api/v1/stories/feed/home` | Bearer | Phase 6: followed + discovered public creators with an active Story, ranked by `scoring.ts`'s heuristic; your own Stories always lead, unscored |
| POST | `/api/v1/events` | Bearer | `{eventType, creatorId?, storyId?, valueMs?}` → 204; validates required fields per type and that any `storyId`/`creatorId` is real and visible to you — see `events.dto.ts` for the full type list |
| GET | `/api/v1/notifications` | Bearer | Paginated (`?limit&offset`), newest first; each row denormalizes its actor/Story/comment/follow-request |
| GET | `/api/v1/notifications/unread-count` | Bearer | → `{count}` |
| POST | `/api/v1/notifications/read-all` | Bearer | Marks every unread notification for the caller read → 204 |
| POST | `/api/v1/notifications/:id/read` | Bearer | Ownership-scoped (a non-recipient's call is a silent no-op) → 204; 404 for a malformed id |
| GET | `/api/v1/stories/:id/owner` | Bearer | → `{username}`; same access rules as the Story itself |
| POST | `/api/v1/users/:username/conversation` | Bearer | Find-or-create the 1:1 conversation with that user → `{conversation}`; 400 for yourself, 404 if either side blocked the other |
| GET | `/api/v1/conversations` | Bearer | Paginated, most-recently-active first; each row has the other participant, last message preview, and unread flag |
| GET | `/api/v1/conversations/unread-count` | Bearer | → `{count}` of conversations with unread activity |
| GET | `/api/v1/conversations/:id/messages` | Bearer | Paginated, **newest first** (unlike comments) — see the schema notes below for why; participant-only. Also marks the caller as having delivered-received messages (Phase 13); each of the caller's own messages carries a `status: "sent" \| "delivered" \| "read"` |
| POST | `/api/v1/conversations/:id/messages` | Bearer | `{body?, storyId?}` (at least one required) → `{message}`; a `storyId` reuses `shareStory`'s access/`allowSharing` check; re-checks blocking at send time, not just at conversation creation |
| POST | `/api/v1/conversations/:id/read` | Bearer | Marks the conversation read for the caller → 204; sending a message auto-marks the sender read too |
| GET | `/api/v1/stories/mine/archive` | Bearer | Paginated; every non-deleted Story you've ever published, expired or not |
| POST | `/api/v1/highlights` | Bearer | `{title, storyIds}` (storyIds must be your own, non-deleted Stories) → `{highlight}` |
| GET | `/api/v1/users/:username/highlights` | Bearer | List that user's Highlights; gated the same way their profile is (block/private-account) |
| GET | `/api/v1/highlights/:id` | Bearer | Detail with items; a followers-only item is hidden from a non-follower even on an otherwise-public account |
| PATCH | `/api/v1/highlights/:id` | Bearer, owner-only | `{title?, storyIds?}`; `storyIds`, if given, replaces the full ordered item set and can't be emptied (delete the Highlight instead) |
| DELETE | `/api/v1/highlights/:id` | Bearer, owner-only | Deletes the Highlight; the Stories inside it remain in the owner's Archive |
| POST | `/api/v1/highlights/reorder` | Bearer, owner-only | `{highlightIds}` — must be exactly the caller's current Highlight set, in the new order; rejects a partial/stale/foreign set with 422 (Phase 13) |
| GET | `/api/v1/highlights/:id/items/:storyId` | Bearer | Full Story detail (engagement counts included) for one member Story — the one endpoint that bypasses the normal 24h expiry, and only for a Story confirmed to actually be in this Highlight |
| POST | `/api/v1/reports` | Bearer | `{targetType: "story"\|"comment"\|"user", targetId, reason, details?}` → `{report}`; 400 on a self-report, 404 if the target doesn't exist (or is already deleted) |
| GET | `/api/v1/moderation/reports` | Bearer, moderator-only | `?status=pending\|dismissed\|actioned` (default `pending`), paginated, oldest first; each row denormalizes the reporter and the target (owner username for a Story, author + body for a comment, username + isActive for a user) |
| POST | `/api/v1/moderation/reports/:id/resolve` | Bearer, moderator-only | `{action: "dismiss"\|"remove_content"\|"suspend_user", note?}` → `{report}`; `remove_content` only for story/comment reports, `suspend_user` only for user reports (400 on a mismatch), 409 if already resolved |
| POST | `/api/v1/moderation/users/:username/suspend` | Bearer, moderator-only | Standalone suspension, independent of any report on file → 204 |
| POST | `/api/v1/moderation/users/:username/unsuspend` | Bearer, moderator-only | Reverses a suspension → 204 |

`not_interested` is one of `POST /api/v1/events`'s `eventType` values — it
both logs the event and immediately excludes that creator from your
`feed/home` results (there's no separate endpoint for it).

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
(Phase 9) will need the history. `0006`: `story_likes` (idempotent
per-viewer state, like `story_views`), `story_comments` (soft-deletable),
`story_shares` (append-only analytics log — repeated sharing is a real,
meaningful action, unlike a view or a like, so it's never deduplicated).
`0007`: `recommendation_events` (the analytics events spec section 12
lists that don't already have a dedicated table — likes/comments/shares
are read directly from their own tables, not duplicated here) and
`creator_not_interested` (the one real per-viewer hard-exclusion rule).
Highlights is deliberately left to its own phase so these migrations stay
reviewable. `0008`: `notifications` — one row per
like/comment/follow/follow_request/mention, with nullable FKs to whichever
of `stories`/`story_comments`/`follow_requests` is relevant to that type
(`CHECK (type IN (...))` keeps the type column closed), `read_at` for the
unread state, and a partial index (`WHERE read_at IS NULL`) so the unread
count/badge query stays cheap regardless of how large a user's full
notification history grows. `0009`: `conversations` (canonically-ordered
1:1 pairs, `user_a_id < user_b_id` enforced by a `CHECK`, so find-or-create
is one indexed lookup rather than a membership-table join),
`messages` (`body` and/or `shared_story_id` — `CHECK (body IS NOT NULL OR
shared_story_id IS NOT NULL)` — with `shared_story_id` `ON DELETE SET
NULL` so a "shared a Story" message outlives the Story's own deletion,
the same way a real conversation survives an old message elsewhere being
deleted), and `conversation_reads` (per-participant `last_read_at`, since
a conversation has no single "unread" flag, only what each side has and
hasn't seen). `0010`: `highlights` (`title`, `CHECK` 1-30 chars) and
`highlight_items` (`UNIQUE (highlight_id, story_id)`, an integer
`position` for ordering) — `story_id` does carry `ON DELETE CASCADE` at
the FK level, but in practice the application layer always gets there
first (`stories.service.deleteStory` explicitly removes the item before
a Story row would ever actually be hard-deleted, which this schema never
does anyway — see the note in the migration itself). `0011`: adds
`users.is_moderator` (`DEFAULT false`, no public way to set it `true` —
see "Phase 10" above) and `reports` (`target_type`/`reason`/`status`
each closed by a `CHECK`, `target_id` deliberately un-FK'd since it's
polymorphic across three tables — see "Phase 10" above for that
tradeoff, and two indexes: one for the moderator queue's status+FIFO
ordering, one for looking up every report against a given target).

## What's NOT in Phase 1-12

`follow_after_story` attribution is still best-effort client-reported
rather than cross-referenced against a conversation (see mobile/README.md
— DMs existing now doesn't automatically make that attribution real, it
would need its own correlation logic). Group DMs and video
transcoding/thumbnails are later phases per the build plan. A Highlight's
cover is computed (its first item's media), not a separately
uploadable/croppable image — see "Phase 9" above for why. Moderation
itself covers Reports, a moderator queue, content removal, and account
suspension, but not a full trust-and-safety surface: filing a report only
gets the generic global rate limit (600 req/min/IP, same as everything
else), not a dedicated stricter budget of its own; no report-aggregation
("this Story has 12 reports" is 12 rows, not one with a count); no
appeals flow; and no mobile UI for the moderator queue itself (it's a
real, tested API with no admin screen built against it yet — a
deliberately small, internal-only audience didn't justify a dedicated
admin app in this pass). Account deletion (Phase 12) deliberately doesn't
scrub comments left on other people's Stories or DM history — see that
section above and `../legal/PRIVACY_POLICY.md` for why. Rate limiting is
in-memory and per-process (Phase 11 — it won't coordinate across multiple
server instances behind a load balancer, and resets on every restart);
`docker-compose.prod.yml` (Phase 12) does configure real TLS termination
via Caddy, but it's untested in this sandbox (no Docker daemon available
here) and there's still no automated database backup/restore strategy and
no APM/metrics/alerting beyond the structured request-log lines — see
`../DEPLOYMENT.md` for what a real deployment still needs to layer on top
of what's here. The recommendation
system itself is real
but explicitly a starting heuristic, not a trained model — see "Phase 6:
the recommendation system is a real heuristic, not a model" above for why,
and spec section 7 for why that's the intended starting point, not a
shortcut. Both notifications and DMs are delivered by polling (`GET
/api/v1/notifications/unread-count`, `GET
/api/v1/conversations/unread-count`) — there's no push/websocket channel
in this sandbox, so a real client has to poll or a later phase has to add
one; see mobile/README.md for the polling intervals this build settled on
(20s for both unread badges, 4s for an actively open conversation thread).

## Camera + Editor module: overlay/filter/drawing storage (migration 0015)

A Story now carries three new columns — `overlays JSONB`, `drawing JSONB`,
`filter TEXT` — added by `migrations/0015_story_overlays.sql`. This closes
a real, previously-shipped bug: `POST /api/v1/stories` accepted a
`caption`/`audience`/etc. body but had nowhere to put the text overlays or
filter choice the mobile editor already let a user build, so every edit
silently vanished on publish. `dto.ts`'s `parsePublishStoryInput` now
validates `overlays` (one of `text`/`emoji`/`mention`/`location`/
`datetime`/`sticker`, each with clamped geometry and type-specific
properties — see `overlays.ts`) and `drawing` (bounded stroke/point
counts) the same way it validates everything else in that body: a
malformed individual overlay is silently dropped, not a 422 for the whole
publish.

The one overlay type that isn't fully self-contained is `mention`: it's
stored as `{userId}` only (spec: never bake `@username` permanently into
what's stored), and `stories.service.ts`'s `resolveOverlaysForViewer`
re-resolves it against that user's *current* identity on every single
read — dropping the overlay outright if the account has since been
deleted, or if either side has blocked the other since the Story was
published, and refreshing `username`/`displayName` otherwise. A username
change or a block made an hour after publish takes effect on the very next
fetch, with no edit to the Story itself. Five tests in
`test/stories.test.ts`'s "Camera + Editor" describe block cover this:
round-trip fidelity, malformed-overlay dropping, live mention resolution,
block-hides-mention, and deletion-hides-mention.

## Video mute/unmute (migration 0016) — the same class of bug, closed the same way

The editor's video mute/unmute control (spec section 44: "original
recorded audio kept by default with a simple mute/unmute control that
affects the published Story") had the identical problem overlays did
before migration 0015: it only ever changed the editor's own preview
playback, never the published Story. `stories.audio_muted BOOLEAN NOT
NULL DEFAULT false` (migration 0016) closes it — `parsePublishStoryInput`
accepts an optional `audioMuted` boolean (default `false`, so "keep the
original audio" is what happens if a caller sends nothing), and every
viewer-facing read now returns it. Two tests cover it: a published Story
returns exactly the `audioMuted` it was published with, and it defaults to
`false` when omitted.

## Crop metadata (migration 0017)

The spec's own `StoryDraft` shape lists `crop` alongside `filter`/
`overlays`/`drawing` — the one field of that shape this project hadn't
built until now. `stories.crop JSONB NOT NULL DEFAULT '{"zoom":1,
"offsetX":0,"offsetY":0}'` stores it the same way as overlays/drawing:
structured metadata, not a pixel-level crop (no image-processing library
in this sandbox to re-encode cropped pixels), applied as a live transform
on the mobile side in both the editor and every viewer. `dto.ts`'s
`parseCrop` clamps `zoom` to `[1, MAX_CROP_ZOOM]` and `offsetX`/`offsetY`
to `[-1, 1]` rather than rejecting an out-of-range value — consistent
with how every other overlay field in this body is validated. Three tests
cover it: the default, an exact round-trip through publish and a
subsequent fetch, and clamping of an out-of-range value.
