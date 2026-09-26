# Phase 1 completion report

**Status: Phase 1 implemented. Waiting for human approval before Phase 2.**

## Architecture

AI Story Studio is a local-first TypeScript application. A framework-free domain core — repositories, services and provider interfaces behind one `Studio` composition root — is used by a server-rendered local web UI. Data is stored in SQLite (`node:sqlite`) with numbered SQL migrations, and files in local storage behind a `StorageProvider` interface. Every AI component and the GPU provider sits behind a replaceable interface, and Phase 1 registers mock implementations only. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Deviations from the preferred stack, and why.** The build environment's network policy blocked the npm registry, so Next.js, React and an ORM could not be installed. I did not ship an untested Next.js app. Instead the UI is server-rendered on Node's `http` module, and the core has no framework dependency, so a Next.js front end can later call the same services. Migrations are plain SQL that an ORM such as Drizzle or Kysely can adopt. The Python/FastAPI worker, Docker and ComfyUI are Phase 2 items, as the spec schedules them.

## Directory structure

```
ai-story-studio/
  migrations/0001_initial_schema.sql
  src/{app,cli,config,db,demo,domain,lib,media,providers,repositories,services,storage,web}
  test/            (10 test files, 80 tests)
  docs/            ARCHITECTURE.md, STORY_PACKAGE.md, PHASE1_REPORT.md, examples/
  tools/           ESLint TypeScript parser (type stripping) + globals
  .env.example, package.json, tsconfig*.json, eslint.config.js
```

## Database schema

The schema has 34 tables plus `schema_migrations`: projects, style_presets, settings, voice_profiles, reference_assets, characters, character_variants, character_references, locations, props, prop_characters, stories, scenes, shots, shot_characters, shot_props, shot_sfx, dialogue_lines, narration_lines, generated_assets, audio_assets, asset_usages, gpu_instances, gpu_events, generation_jobs, generation_attempts, usage_records, timelines, timeline_items, exports, quality_reports, similarity_reports, review_checklist_items and story_package_imports. Foreign keys cascade or set null as appropriate. Locks store snapshots, generation history is append-only, and every cost row carries an `is_mock` flag.

## Implemented features

- Application shell with all 14 navigation sections, the dashboard and a mock-mode banner.
- CRUD for projects, stories, scenes and shots, with scene and shot ordering (move, reorder, compacting on delete).
- Characters, variants, reference sheet slots (views, expressions, poses), mock generation of references, uploads (validated PNG/JPEG/WebP), approval and Character Lock with snapshot and unlock-with-reason.
- Voice profile data model with Voice Lock, emotions that change delivery but not identity, narrator voices and voice preview.
- Location Lock (including references), Prop Lock with associated characters, and style presets (8 built-in, editable).
- Story Package format, validation (schema, cross-references, unique keys, size limit) and atomic import into a new or existing project, with import history.
- Prompt Builder with source-attributed sections, lock-snapshot use, variant overrides and negative merging. It never overwrites locked prompts.
- Asset library with search and filters, usage counts, reusable flag and continuity tags. Reuse suggestions are offered, never forced.
- Generation Queue covering all 15 statuses, batched GPU sessions, cancellation, bounded retries, image-first rules and preserved failed attempts.
- Mock generation for images, clips, upscaling (non-native flag, originals kept), TTS, music, SFX, ambience and lip sync.
- Generation history with side-by-side attempt cards, and approve / reject / regenerate (new seed or mode) / edit prompt.
- Basic timeline editor with six tracks plus titles: automatic placement, per-item timing, volume, fades and transitions, manual edits kept on rebuild, and solo and full-mix previews.
- BUILD FINAL covering every step in spec §51, with export validation (spec §52), landscape and vertical profiles, and a failed validation never marked complete.
- Quality Check UI: story, visual and audio reports, the YouTube Quality Check with disclaimer, the similarity report architecture with explainable warnings, and the human review checklist.
- Cost tracking simulation, budget settings (warn at 80 %, block at 100 %), GPU settings, the GPU & Costs page with pre-flight and analytics, watchdog, kill switches and event log.
- Project export and import (metadata-only or full media), restored with fresh ids inside one transaction.
- Structured JSON logging with secret redaction. `.env.example`.

## Mocked features (not production functionality)

The following are mocks: image, video, upscaling, TTS, music, SFX, ambience and lip-sync outputs; GPU provisioning, prices and timings; the MP4 master, which is a manifest plus a real WAV mix; and all costs, which are simulated and labelled as such. Black-frame detection is reported as unavailable for mock clips.

## Tests run

`npm test` runs 10 test files with 80 tests, all passing:

- projects and stories CRUD and ordering
- locks and Prompt Builder
- Story Package validation and atomic import
- generation queue, history and review
- budget and GPU safety (price, VRAM, idle, max lifetime, failure and cancellation cleanup, provision failure, watchdog retry and orphans, foreign resources untouched, kill switch confirmation, non-mock provider refusal)
- mock providers, audio cache, timeline and mixer
- similarity, export validation, quality service and BUILD FINAL (including partial rebuild and vertical export)
- backup round-trip and tamper rejection
- security validation and the web app (CSRF, origin, escaping, traversal, body limits)
- full demo workflow

## Test and build results

`npm run check` passes all four stages:

- lint: ESLint (recommended rules plus project rules, over the TypeScript sources) and Prettier, both clean
- typecheck: `tsc` strict, clean
- tests: 80/80
- build: `tsc` emit to `dist/`

The compiled server was started (`npm start`) and serves pages, and a crawl of all 52 linked pages of the seeded demo returned HTTP 200. Demo seed result: export `complete`, with a simulated spend of about ₹10 and ₹0 real.

## Security decisions

- The server binds to localhost only.
- State-changing requests need a CSRF token plus a same-origin check.
- Strict CSP with no inline scripts, and auto-escaped HTML.
- SQL is parameterised, identifiers are allow-listed, and backup columns are checked against the live schema.
- Storage keys are validated against traversal, and uploads are checked for type, magic bytes and size. Request bodies have per-route limits.
- Secrets live only in `.env`, the logger redacts them, and credentials are never sent to the browser.

## Cost-safety mechanisms

- `MOCK_GENERATION=true` by default. Phase 1 refuses to generate when it is false.
- `ENABLE_CLOUD_GPU` is a second, independent gate, and no real provider or paid API client exists.
- The price cap, the VRAM check, and the worst-case cost versus the remaining budget are all checked before provisioning.
- Budget blocking at 100 %, and no automatic budget increases.
- GPUs are terminated on completion, failure or cancellation, and by the idle timeout (10 min), the max lifetime (60 min), the watchdog (orphans, retried terminations), the tag-scoped kill switches, and shutdown cleanup. Every cleanup is recorded in `gpu_events`.

## Quality-check implementation

These are rule-based and explainable, with configurable thresholds.

- Story: context, goal (info only), ending, order, placeholders, unfinished prompts, duplicates, duration.
- Visual: missing, rejected or unapproved clips, aspect and resolution, short clips, duplicate consecutive shots, missing references.
- Audio: missing speech or required SFX, silence, duplicates, audio/video mismatch, clipping, level balance, music over speech.
- Similarity: n-gram containment and sequence similarity against earlier episodes, ignoring recurring names and continuity assets.
- The YouTube check aggregates the above with a fixed disclaimer and makes no monetisation claims. The human review gate is the checklist.

## Known limitations

- There is no real AI generation or MP4 encoding yet (Phases 2–4).
- The UI is server-rendered rather than Next.js, and there is no ORM (see the deviations above).
- Mock clips are manifests, so the preview shows the source still with a CSS camera move.
- The editor is intentionally basic: timing, volume, fades, transitions, titles and rebuild. A removed automatic item comes back on the next automatic rebuild.
- Transitions and title cards are stored on the timeline but not yet rendered, because there is no encoder until Phase 4.
- Full-media backups are single JSON files with base64 media, which suits the current scale (up to 1 GB).
- The generation queue runs inside the web request. There is no background worker process until the Phase 2 worker.
- Similarity is lexical and structural. It does not detect paraphrased plots.

## Phase 2 recommendations

1. Once npm access is available: add Next.js (App Router) on top of the existing `Studio` services, and optionally adopt Drizzle over the existing migrations.
2. Build the Python + FastAPI GPU worker: `/health`, `/models`, `/system`, `/generate/*`, `/process/lipsync`, `/jobs/{id}`, cancel. Add token auth, path and size validation, no shell execution, and no cloud credentials on the worker. Package it with Docker.
3. Add a `WorkerClient` implementing the provider interfaces over HTTP, and a local-GPU `GPUProvider`.
4. Add an FFmpeg assembler behind a new `VideoAssembler` interface (concat, transitions, titles, loudnorm, sidechain ducking, alimiter, H.264/AAC), reusing the timeline data and `FfprobeMediaProbe` validation.
5. Move queue execution to a background worker loop with progress streaming.

Do not start any paid cloud work until it is explicitly approved (spec §85).
