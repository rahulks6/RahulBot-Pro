# KATKEE backend — Phase 1

Real, running foundation: Postgres schema, signup/login/refresh/logout/me, and
a test suite that exercises it end to end against a real database. No mocked
data anywhere in this service.

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
while building this: migrations applied and inspected with `\d`, the server
started and exercised with real `curl` requests (signup → login → refresh
rotation → reuse rejection → logout → refresh-after-logout, each asserted
by status code), and the 12-case test suite passing for real.

## API (v1)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | liveness check |
| POST | `/api/v1/auth/signup` | – | `{username, email, password, displayName}` → `{user, tokens}` |
| POST | `/api/v1/auth/login` | – | `{email, password}` → `{user, tokens}` |
| POST | `/api/v1/auth/refresh` | – | `{refreshToken}` → `{tokens}`; single-use, rotates on every call |
| POST | `/api/v1/auth/logout` | – | `{refreshToken}` → 204; idempotent |
| GET | `/api/v1/auth/me` | Bearer access token | → `{user}` |

Errors are JSON: `{"error": "validation_error", "fields": {...}}` (422),
`{"error": "auth_error", "message": "..."}` (401/409), or
`{"error": "not_found" | "http_error" | "internal_error", "message": "..."}`.

## Schema (migrations/0001_init.sql)

`users`, `refresh_tokens`, `follows`, `follow_requests`, `blocks`, `mutes` —
the identity and social-graph foundation the rest of the spec's phases build
on. Media, Stories, Highlights, conversations, and notifications are
deliberately left to their own phases (see the KATKEE build-plan doc) so
this migration stays reviewable.

## What's NOT in Phase 1

Camera, Story publishing/lifecycle, the Home feed, DMs, Highlights,
recommendations, and moderation are later phases per the build plan — this
is intentionally just foundation + auth, done for real rather than a wide
shallow pass across everything.
