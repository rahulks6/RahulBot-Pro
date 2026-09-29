# Deploying Katkee to the App Store and Play Store

The order below is the order that actually works — mobile can't be
meaningfully tested or submitted until step 1 is done, because every
screen in the app talks to a real backend. Skipping ahead to app-store
work before the backend is live just means testing against `localhost`,
which no TestFlight/Play Console tester and no App Store reviewer can
reach.

None of the steps below that need a Mac, Xcode, Android Studio, real npm
access, or a running Docker daemon have been executed in this sandbox —
that tooling isn't available here (see `backend/README.md`'s and
`mobile/README.md`'s own sandbox-limitation notes). Everything here is
written against real, standard, well-documented tools and this project's
own actually-tested code (141+ backend tests passing, every deployment
artifact reviewed against the real npm scripts it wraps), not guessed at.
Verify each step against the tool's own current docs as you go — versions
and exact UI details drift.

## 0. What you'll need

- A domain name (for the backend's HTTPS URL and, later, your privacy
  policy/terms pages)
- A VPS (DigitalOcean/Hetzner/Linode droplet, ~$6-12/mo — this is
  "smallest real, professional deployment," not a toy) **or** a managed
  platform (Railway/Render/Fly.io) if you'd rather not manage a server
  yourself
- An Apple Developer Program account ($99/yr) — apple.com/programs
- A Google Play Console account ($25 one-time) — play.google.com/console
- An [Expo Application Services](https://expo.dev) (EAS) account (free
  tier works to start) — this is what lets you build the iOS app without
  owning a Mac
- A phone (iOS and/or Android) to actually install and test on

## 1. Deploy the backend

### 1a. Get a server and point DNS at it

Spin up the VPS, then point a subdomain's DNS A record at its IP —
e.g. `api.yourapp.com`. Don't skip this: `Caddyfile` needs a real domain
to request a TLS certificate for, and iOS refuses plain HTTP by default
(App Transport Security), so there's no "launch without HTTPS" shortcut.

### 1b. Ship the code and configure secrets

```bash
# on the VPS, with Docker + the Docker Compose plugin installed
git clone <your fork of this repo>
cd katkee/backend
cp .env.prod.example .env
# edit .env: POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
# (each generated with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
# and DOMAIN (the subdomain you pointed at this server in step 1a)
```

### 1c. Bring it up

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec backend npm run migrate:prod
```

`docker-compose.prod.yml` runs three containers: Postgres, the backend
(built from `Dockerfile`), and Caddy (auto-provisions and renews a real
Let's Encrypt certificate for `DOMAIN`, reverse-proxying to the backend).
Media uploads persist in a named Docker volume, not the container's
ephemeral filesystem — see the compose file's own comments.

### 1d. Verify it's actually live

```bash
curl https://api.yourapp.com/health
# {"status":"ok","service":"katkee-backend","db":"up"}
```

If this doesn't come back clean, don't move on to mobile — everything
downstream depends on this working first. Check `docker compose -f
docker-compose.prod.yml logs backend` and `logs caddy`.

### 1e. Known gaps to weigh before you get real users

- **The `psql`-CLI database layer** (`backend/src/db/psql.ts`) works and
  is fully tested, but it's not what a driver-based backend would use —
  no connection pooling, a new `psql` process per query. Fine at launch
  scale; if you outgrow it, swap in the `pg` driver (the file's own
  comment documents exactly what a drop-in replacement looks like) on a
  machine with real npm access, since this sandbox never had it.
- **No automated database backups are configured.** Add them (the
  simplest real option: a cron job running `pg_dump` into the
  `postgres_data` volume's host mount, shipped somewhere off-server) before
  you have data you can't afford to lose.
- **Media storage is a local Docker volume**, not object storage (S3/GCS)
  — fine for a single-server launch; `backend/src/modules/media/storage.ts`
  is already built behind an interface specifically so swapping in a real
  object-store client later doesn't touch any call site.

## 2. Bootstrap the native mobile project

This has to happen on your own machine (or a cloud dev environment with
real npm access) — this sandbox has never run `npm install` for the
mobile app at all.

```bash
npx @react-native-community/cli@latest init KatkeeMobile --skip-install
# then copy this repo's mobile/src/, App.tsx, index.js, app.json,
# babel.config.js, and mobile/package.json's dependencies into the
# generated KatkeeMobile project
cd KatkeeMobile
npm install
npm run typecheck   # this code has never been typechecked with real types before — do this first
```

Set your real bundle identifier / application ID now (see
`STORE_LISTING.md`'s "App identity" section) — in Xcode for iOS
(`ios/KatkeeMobile.xcodeproj`, Bundle Identifier field) and in
`android/app/build.gradle` (`applicationId`) for Android. Can't be
changed after your first store submission, so get it right before you go
further.

Point the app at your real backend: edit
`src/config/env.ts`'s `production.apiBaseUrl` to `https://api.yourapp.com`
(the domain from step 1a) — it must be `https://`, not `http://`.

## 3. Set up EAS (cloud builds — no Mac required)

```bash
npm install -g eas-cli
eas login
eas build:configure
```

This detects a bare (non-Expo-managed) React Native project and writes an
`eas.json` with build profiles. You keep your own `ios/`/`android/`
folders and native code exactly as generated in step 2 — EAS Build
supports bare-workflow projects natively; you are not converting this
into an Expo-managed app.

Define three profiles in `eas.json` (EAS scaffolds a reasonable default —
adjust to match this):
- **development**: a debug build with dev-client tools, for your own
  device during active development
- **preview**: a release-configuration build, distributed directly (an
  installable link/QR code — no App Store or TestFlight review, no Apple
  account needed for this tier beyond having one to sign with) — this is
  your fastest path to a real device with a real release build
- **production**: what you actually submit to the stores

## 4. Test before deploying — in order of speed

1. **Local simulator/emulator** (fastest iteration, but not real-device
   behavior — camera, push permissions, and performance all differ):
   `npm run ios` / `npm run android` from the bootstrapped project.
2. **`eas build --profile preview`** → install directly on a real
   physical device via the link/QR EAS gives you. No store review, no
   waiting — this is where you actually exercise the camera, gestures,
   and real network conditions for the first time. Do this before
   spending any review-queue time on TestFlight/Play.
3. **TestFlight** (iOS): `eas build --profile production` then `eas
   submit -p ios`, or upload manually via Transporter. Requires the Apple
   Developer account (step 0). Internal testers (your own App Store
   Connect team, up to 100) get a build immediately, no review. External
   testers (up to 10,000) need a light "beta app review" — much faster
   than a full App Store review, typically under 24-48h.
4. **Play Console Internal Testing track** (Android): `eas submit -p
   android`, or upload the `.aab` manually. Internal testing (up to 100
   testers via a share link) has no review at all. Move to Closed, then
   Open testing as you widen the audience — each successive track adds a
   little more (light) review.
5. Only after real people have used a preview/TestFlight/Internal-testing
   build without it falling over: submit for full review (step 5).

## 5. Submit for real review

- Work through `STORE_LISTING.md` completely first — both stores reject
  incomplete submissions outright, which costs you a full review cycle
  for something that was never going to be evaluated on the app's merits.
- iOS: submit the production build in App Store Connect, fill in the App
  Privacy form, attach your demo reviewer account, submit for review.
  Typical turnaround: 24-48h, sometimes longer for a first submission or
  a UGC/messaging app that draws extra scrutiny (see `STORE_LISTING.md`'s
  content-moderation note).
- Android: submit the production `.aab` in Play Console, complete Data
  Safety and the content rating questionnaire, submit for review.
  Typical turnaround: a few hours to a few days for a first submission.
- Expect at least one rejection round on a first submission — it's
  normal, not a sign anything here is broken. Read the specific rejection
  reason, fix that specific thing, resubmit; don't guess broadly.

## 6. After launch

- Bump `CFBundleVersion`/`versionCode` on every single upload (see
  `STORE_LISTING.md`'s versioning note) — both stores reject a reused
  build number outright.
- Watch `backend/README.md`'s Phase 11 structured request logs and the
  real `/health` check (wire it into an uptime monitor — even a free one
  like UptimeRobot hitting `https://api.yourapp.com/health` on a 5-minute
  interval is a real, meaningful safety net for approximately zero cost).
- Revisit the Phase 11 rate limits (`backend/.env.prod.example`) once you
  have real traffic patterns to tune against, rather than guessing twice.
