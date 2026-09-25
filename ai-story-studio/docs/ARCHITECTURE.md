# AI Story Studio: architecture

AI Story Studio is a private, local-first production tool for our own original story videos. It is not SaaS: there are no accounts, billing or multi-tenancy. The target workflow is:

`IDEA → STORY PACKAGE → REVIEW → CREATE VIDEO → REVIEW SHOTS → BUILD FINAL → QUALITY CHECK → EXPORT`

Phase 1 built the local foundation. Phase 2, the current phase, adds the local Python AI worker (§16). Generation is still **mock only** and spends ₹0. This document describes the whole architecture and marks what is mocked.

## 1. System overview

```
Browser (localhost only)
   │  server-rendered pages, CSRF-protected forms
   ▼
Web layer (src/web)  ─────────────►  Studio composition root (src/app/studio.ts)
                                        │
        ┌───────────────────────────────┼─────────────────────────────────────┐
        ▼                               ▼                                     ▼
  Repositories (src/repositories)   Services (src/services)             Providers (src/providers)
  SQLite via node:sqlite            prompt builder, generation queue,   replaceable interfaces:
  + numbered SQL migrations         audio pipeline, timeline, mixer,    ImageModel, VideoModel, Upscaler,
                                    export/BUILD FINAL, quality,        TextToSpeechProvider, MusicProvider,
                                    similarity, budget, GPU supervisor, SoundEffectProvider, LipSyncProvider,
                                    backup, story package, analytics    GPUProvider, MediaProbe
        │                                                                     │
        ▼                                                                     ▼
  LocalStorageProvider (data/storage)                       Phase 1: mock implementations only
  (StorageProvider interface → S3-compatible later)         Phase 2: Python worker (mock models) · Phase 3+: real adapters
```

The planned cloud path is: local job queue → GPU provider → temporary GPU → AI worker → open-source models → generated assets downloaded locally and verified → GPU terminated. By default the **GPU provider is `MockGPUProvider`**. It simulates provisioning, start-up, model loading, timings, prices and failures, and nothing is rented. With `WORKER_URL` set, the app uses the local worker through `LocalWorkerGpuProvider` instead (₹0/h, never paid; see §16).

### Technology decisions

| Spec preference                          | Phase 1 choice                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js / React / TypeScript             | **TypeScript** on Node 22 with a small server-rendered UI (`node:http`)                                                                     | The build environment had **no npm registry access** (network policy), so Next.js/React could not be installed. The domain core (`src/app`, `src/services`, `src/repositories`, `src/providers`) has **no framework dependency**, so a Next.js UI can later call the same `Studio` object from route handlers or server actions. Nothing in the core needs rewriting. |
| SQLite + TypeScript ORM                  | **SQLite** via Node's built-in `node:sqlite`, a typed repository layer and **numbered SQL migrations**                                      | No ORM was installable offline. The migrations are plain SQL (`migrations/0001_initial_schema.sql`) and can be adopted by Drizzle or Kysely later.                                                                                                                                                                                                                    |
| Python + FastAPI worker, Docker, ComfyUI | **Built in Phase 2** (`worker/`): stdlib core + stdlib HTTP server, FastAPI adapter, Dockerfile. ComfyUI is deferred to Phase 3 model work. | PyPI and Docker Hub were blocked in the build environment, so the worker core has no third-party dependencies. The FastAPI adapter and Docker image are written but could not be installed or built here.                                                                                                                                                             |
| FFmpeg / FFprobe                         | `FfprobeMediaProbe` is implemented; the mock master is probed by `MockMediaProbe`                                                           | Real encoding is Phase 4. The export validation rules are already the real ones.                                                                                                                                                                                                                                                                                      |

Runtime dependencies: **none**. Dev dependencies are TypeScript, ESLint, Prettier and `@types/node`.

## 2. Directory structure

```
ai-story-studio/
├── migrations/                 numbered SQL migrations (schema_migrations table)
├── docs/                       ARCHITECTURE, STORY_PACKAGE, PHASE1_REPORT, examples/
├── src/
│   ├── app/studio.ts           composition root (DB, storage, providers, repositories, services)
│   ├── cli/                    migrate, seed-demo
│   ├── config/env.ts           .env loading; MOCK_GENERATION defaults to TRUE
│   ├── db/                     node:sqlite wrapper (parameterised SQL, savepoint transactions), migration runner
│   ├── demo/                   original demo series (Story Packages) + end-to-end mock seed
│   ├── domain/                 enums, row types, validated input schemas
│   ├── lib/                    schema validator, errors, structured logger with redaction, ids, hashing, clock
│   ├── media/                  PNG + WAV encoders/decoders used by mock providers and the mixer
│   ├── providers/              interfaces (types.ts), registry + cost-safety gate, mocks, ffprobe
│   ├── repositories/           data access per aggregate (projects, characters, stories, assets, jobs, gpu, timeline, reports)
│   ├── services/               business logic (see §6–§12)
│   ├── storage/                StorageProvider + LocalStorageProvider (path-traversal safe)
│   └── web/                    router, CSRF, HTML templating (auto-escaped), pages, static assets
├── test/                       node:test suites (84 tests, incl. worker integration)
├── worker/                     Python AI worker (Phase 2): ais_worker/, tests/, Dockerfile
└── tools/                      ESLint TypeScript-stripping parser + globals
```

## 3. Database design

The schema is in `migrations/0001_initial_schema.sql`, with 34 tables plus `schema_migrations`. Relationships use real tables and foreign keys. JSON columns are used only for flexible model-specific configuration, logs and report findings.

| Area             | Tables                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects & style | `projects`, `style_presets` (global or project-scoped), `settings`                                                                                                                     |
| Cast & world     | `characters` (+ lock snapshot), `character_variants`, `character_references`, `reference_assets`, `voice_profiles` (+ lock), `locations` (+ lock), `props` (+ lock), `prop_characters` |
| Story            | `stories`, `scenes`, `shots`, `shot_characters`, `shot_props`, `shot_sfx`, `dialogue_lines`, `narration_lines`                                                                         |
| Generation       | `generation_jobs`, `generation_attempts` (immutable history), `generated_assets` (append-only, lineage via `source_asset_id`), `audio_assets` (content-hash cache key), `asset_usages` |
| GPU & cost       | `gpu_instances`, `gpu_events` (cleanup and audit log), `usage_records` (per-second cost, `is_mock` flag)                                                                               |
| Editing & output | `timelines`, `timeline_items` (a `manual` flag survives rebuilds), `exports`                                                                                                           |
| Quality          | `quality_reports`, `similarity_reports`, `review_checklist_items`, `story_package_imports`                                                                                             |

The spec's entity names map as follows: `GenerationJob` → `generation_jobs`, `GenerationAttempt` → `generation_attempts`, `GPUInstance` → `gpu_instances`, `UsageRecord` → `usage_records`, `AudioAsset` → `audio_assets`, `Timeline`/`TimelineItem`, `Export` → `exports`, `QualityReport`, `SimilarityReport`, `StoryPackageImport`, `Settings`.

## 4. Provider interfaces (`src/providers/types.ts`)

Every AI component sits behind an interface. The rest of the app never imports a concrete model.

| Interface              | Phase 1 implementation                | Future adapters (evaluated in Phase 3/4, not chosen yet)         |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `ImageModel`           | `MockImageModel` (PNG)                | FLUX-family, SDXL-family, others                                 |
| `VideoModel` (I2V)     | `MockVideoModel` (manifest)           | LTX-family, Wan-family, others                                   |
| `Upscaler`             | `MockUpscaler`                        | open-source image/video upscalers                                |
| `TextToSpeechProvider` | `MockTextToSpeechProvider`            | open-source local TTS                                            |
| `MusicProvider`        | `MockMusicProvider`                   | open-source music generation + reusable local music library      |
| `SoundEffectProvider`  | `MockSoundEffectProvider`             | reusable SFX library + open-source SFX generation                |
| `LipSyncProvider`      | `MockLipSyncProvider`                 | open-source lip sync                                             |
| `GPUProvider`          | `MockGPUProvider`                     | Local GPU, RunPod, TensorDock, Vast.ai (one provider in Phase 5) |
| `MediaProbe`           | `MockMediaProbe`, `FfprobeMediaProbe` | ffprobe                                                          |
| `StorageProvider`      | `LocalStorageProvider`                | S3-compatible                                                    |

Each provider declares `ProviderInfo`: `isMock`, `openSource`, `computeLocation` (`local_cpu` / `local_gpu` / `cloud_gpu`), `requiresPaidResources`, `minVramGb` and `modelVersion`. The queue uses `computeLocation` to run cheap work locally and batch expensive work on one GPU session.

## 5. Cost-safety gates

1. `MOCK_GENERATION=true` is the default; an unset or empty value never disables it. `assertGenerationAllowed` refuses to run if any non-mock provider is configured while it is true.
2. If `MOCK_GENERATION=false`, Phase 1 refuses to generate at all. It does not silently fall back to mocks.
3. A real (non-mock) GPU provider additionally needs `ENABLE_CLOUD_GPU=true` (`GpuSupervisor.assertProviderAllowed`).
4. No real GPU provider or paid API client exists in the codebase.

## 6. Generation architecture (`services/generation.ts`)

- **Image-first**: shot → image → review → approve → animate the approved image. Video jobs require an approved still. A failed clip never triggers image regeneration.
- **Queue statuses**: waiting, provisioning_gpu, starting_worker, loading_model, generating_image, generating_video, generating_audio, upscaling, lip_sync, audio_processing, encoding, downloading, complete, failed, cancelled. Each job keeps a timestamped status log.
- **Batching**: `processQueue()` runs local CPU jobs directly. It runs all GPU jobs in **one** GPU session, loading each model once and recording `startup` and `model_load` usage once. The session is terminated in `finally`.
- **History**: every attempt, whether succeeded, failed or cancelled, is a new `generation_attempts` row. It records prompt, negative, model and version, seed, references, resolution, fps, duration, settings, provider, GPU, timings, GPU seconds, cost and approval. Only the approval flag of an attempt can change.
- **Retries** are bounded by `maxAttempts` (default 2). They apply only to retryable error codes, and are skipped if the budget becomes blocked or the session died.
- **Review**: approve, reject, regenerate (new seed, mode or model), and edit prompts. Approved work is never regenerated unless the user explicitly asks; queueing an approved shot returns `CONFLICT`.
- **Generation modes**: FAST PREVIEW, OPTIMIZED and HIGH QUALITY. OPTIMIZED generates at a lower resolution and then upscales. Upscaled assets are **always** `is_native_resolution = 0`, and the original is kept (`source_asset_id`).
- **Reuse suggestions** (`services/reuse.ts`) offer approved reusable assets with the same location or cast and a similar action. They are never applied automatically.

## 7. Audio architecture (`services/audio-pipeline.ts`, `mixer.ts`, `timeline.ts`)

- There are five separate layers: dialogue, narration, music, SFX and ambience. Each is stored as its own `audio_assets` row and is never baked into video.
- **Voice Lock**: a locked voice freezes model, identity, language, pitch, speed and style. Emotion (happy, sad, whispering…) is a per-line delivery parameter and never changes identity. The narrator is a project-level voice profile.
- **Asset reuse**: each request has a content-hash `cache_key` built from the provider, model version, text, language, emotion, speed and voice lock (or mood, genre, energy and duration for music). Identical requests reuse existing audio.
- **Partial rebuild**: editing a line's text, emotion, speed or language clears only that line's audio. BUILD FINAL regenerates only missing audio. Lip sync is recomputed only for shots whose dialogue changed. Clips are never regenerated for audio changes.
- **Timeline plan**: speech lines are placed one after another inside their shot. If a shot's speech is longer than its clip, the shot is extended by holding the last frame, and a warning is recorded. SFX are placed at their cue offsets. Music and ambience span each scene; ambience loops. Items the user edits are marked `manual` and survive automatic rebuilds.
- **Mixer**: per-clip level balancing to target RMS per layer, volume, fades and loops. Music is ducked under speech with configurable attack and release; ambience is ducked by half as much. Layer gains and peak protection to a ceiling (-1 dBFS by default) are applied last. It reports per-layer levels, music-over-speech dB, clipping and missing items. Solo previews render any single layer.
- **Lip sync** runs only when `mouth_visible && lipsync_enabled` and the shot has dialogue audio. The lip-synced clip is a new asset whose source is the original clip.
- **Multilingual**: text lines carry a `language` and are separate from video assets, so a later language track reuses the same clips.

## 8. BUILD FINAL (`services/export.ts`)

The steps are: validate story and approved shots → generate missing speech → generate missing music, ambience and SFX (sized to the planned scene durations) → lip sync where required → arrange the timeline → mix → encode → probe and validate → complete **or** failed. Landscape output is 1920×1080; vertical output (Shorts) is 1080×1920 and reuses the episode footage (centre-crop reframe). In Phase 1 the "encode" step writes a **mock master manifest** plus a **real WAV mix**. The export validation still checks every rule from spec §52: file exists, video stream, audio stream, resolution, frame rate, duration, no missing scene, required dialogue and narration present, no clipping, decodes. A failed validation is never marked complete.

## 9. Quality-check architecture (`services/quality/`)

- **Story**: context or beginning, goal/problem (info only), ending/resolution, scene and shot order, placeholders (fail), unfinished prompts, duplicate lines, missing shots, and duration versus target. It warns rather than enforcing one formula on every story.
- **Visual**: missing, rejected or unapproved clips, aspect ratio and resolution, very short clips, duplicate consecutive shots, missing references, unlocked characters (info). Black-frame detection is explicitly listed as unavailable for mock clips.
- **Audio**: missing dialogue or narration, missing required SFX, near-silent speech, duplicate placements, audio/video length mismatch, clipping, dialogue versus narration level difference, music overpowering speech.
- **YouTube Quality Check**: aggregates all of the above plus similarity and the human-review status. It carries a fixed disclaimer: it is an internal aid, does not guarantee monetisation or policy compliance, and its thresholds are configurable settings rather than permanent rules.
- **Human review gate**: a ten-item checklist per story, from "Story reviewed" to "Final video watched".

## 10. Similarity architecture (`services/quality/similarity.ts`)

For each episode the check builds a fingerprint from the story text, dialogue, narration, prompts, shot plan (framing, angle, movement, location), scene structure, clip checksums and audio checksums. It compares that against earlier episodes in the same project. Scores are word-3-gram **containment** for text and LCS ratio for sequences, which keeps them explainable. For example: _"Episode 2 shares 46% of its narration with Episode 1."_ Recurring character and location names are ignored. Continuity-tagged assets (intro, outro, theme, catchphrase…) are excluded from reuse counts, and short repeated lines are reported as possible catchphrases (info). The check produces warnings only and never predicts platform decisions.

## 11. Storage architecture

`LocalStorageProvider` writes under `DATA_DIR/storage`. Keys look like `projects/<project>/<kind-folder>/<asset>.<ext>`. Keys are validated: they must be relative, contain no `..` or hidden segments, use an allow-listed extension, and resolve inside the root. Assets are append-only, so regenerating never overwrites a file. GPU worker disks are treated as disposable. Everything is downloaded and stored locally before a GPU is terminated.

## 12. GPU safety architecture (`services/gpu-supervisor.ts`)

These safeguards are independent of each other, and all are tested with `MockGPUProvider`:

1. **Pre-provision checks**: VRAM, availability, hourly price ≤ configured maximum, and the **worst-case cost** (max lifetime × rate) against the remaining daily and monthly budget. Nothing is ever provisioned silently.
2. **Job-completion shutdown**: `withSession` terminates the GPU in `finally`.
3. **Failure and cancellation cleanup**: the same `finally` block, with the reason recorded.
4. **Idle timeout** (10 min by default) and **maximum lifetime** (60 min by default) timers.
5. **Watchdog** (every 60 s by default): retries failed terminations, finds orphaned studio-tagged instances and terminates them or warns (per the configured policy), and marks database instances missing at the provider. Every cleanup is logged in `gpu_events`.
6. **Emergency kill switch**: _TERMINATE AI GPU_ (type `TERMINATE`) and _TERMINATE ALL AI STORY STUDIO GPU RESOURCES_ (type `TERMINATE ALL`). It only touches resources tagged `ai-story-studio`, never other machines on the account.
7. **Shutdown cleanup**: on SIGINT or SIGTERM the server terminates any instance still tracked as active.

## 13. Cost architecture

`usage_records` stores seconds × hourly rate for each category (startup, model_load, generation, upscale, audio, lipsync), linked to GPU, job, attempt, project, story and shot. From these the app derives daily and monthly spend, attempt cost, approved-clip cost, scene and episode cost, cost per finished minute, attempts per approved shot, approval rate, asset reuse rate, and cost by model, GPU and provider. Mock usage is flagged `is_mock=1` and labelled "simulated" in the UI. Budgets compare mock spend with mock limits and real spend with real limits, so they never mix. Defaults are ₹200/day and ₹1,500/month, with a warning at 80 % and new cloud generations blocked at 100 %. Budgets are never raised automatically.

## 14. Security architecture

- The server binds to `127.0.0.1` by default because this is a single-user tool.
- All state-changing requests need a per-process CSRF token **and** a same-origin `Origin`/`Referer`.
- Strict CSP (`default-src 'self'`, no inline scripts, no third-party resources), `nosniff`, `X-Frame-Options: DENY`.
- All HTML output is escaped by the template function. User content cannot inject markup.
- All SQL is parameterised. Dynamic identifiers are checked against a pattern, and backup import checks columns against the live schema.
- Uploads are limited by size, MIME type and magic bytes. Request bodies are capped per route.
- Secrets live only in `.env`, which is git-ignored (`.env.example` is provided). The logger redacts secret-looking keys and values. Credentials are never rendered in the browser. The GPU worker (Phase 2) requires token authentication, validates paths and parameters, allows no shell execution and holds no cloud credentials (§16).

## 15. Testing strategy

`npm test` runs the Node built-in test runner, with an in-memory SQLite database and temporary storage per test. There are 84 TypeScript tests (plus 34 worker tests, §16) covering the spec §78 list: CRUD, locks, variants, ordering, Story Package validation and atomic import, prompt construction, history preservation, approve/reject, the mock queue, budget calculation and blocking, GPU safety, mock providers, audio caching, timeline and mixer, similarity, quality and export validation, backup round-trip, security validation, web CSRF/escaping/traversal, and the whole demo workflow.

`npm run check` runs lint (ESLint + Prettier), typecheck (`tsc --strict`), the tests and the production build.

## 16. Local AI worker (Phase 2)

`worker/` is the Python process that will run open-source models on a GPU. It is local in Phase 2 and a temporary cloud GPU from Phase 5. See [worker/README.md](../worker/README.md).

```
Studio (TypeScript)                                   Worker (Python, worker/ais_worker)
  GenerationService ──► Worker*Provider ──► WorkerClient ══HTTP+Bearer══► WorkerAPI ─► JobManager ─► Model (mock) ─► FFmpeg
  GpuSupervisor ──────► LocalWorkerGpuProvider (₹0/h, local, never paid)       │           (thread pool, cancel,   │
                                                                           /system   timeouts, persisted jobs)  job dir
  ◄──────────── download each output, verify SHA-256 + size, store locally ◄──────────────────────────────────────┘
```

- **Core without dependencies:** config, security, schemas, jobs, diagnostics, models and media use only the Python standard library. `server.py` (stdlib `ThreadingHTTPServer`) and `fastapi_app.py` (FastAPI/uvicorn, for production and Docker) both call the same `WorkerAPI.handle`, so their behaviour is identical.
- **Endpoints:** `/health` (no auth; liveness only), `/models`, `/system`, `/generate/image`, `/generate/image-to-video`, `/generate/audio`, `/process/lipsync`, `/process/upscale`, `/jobs`, `/jobs/{id}`, `/jobs/{id}/cancel`, `/jobs/{id}/files/{name}`.
- **Job processing:** a thread pool (one job at a time by default) with statuses `queued → loading_model → running → complete|failed|cancelled`. Cancellation is cooperative in Python and forced for FFmpeg, which is killed. There is a per-job timeout. Job records are persisted, jobs interrupted by a restart are marked failed, and old jobs are pruned.
- **Model interfaces:** `Model.load/unload/run` plus `ModelInfo` (kind, VRAM, licence, device, mock). The registry loads each model once and keeps at most two loaded, unloading the least recently used. Phase 2 registers mocks only. `WORKER_MOCK_MODELS=false` registers **nothing** rather than silently mocking.
- **FFmpeg / FFprobe:** the mock video model renders a real H.264 MP4 (a push-in on the approved still) at the requested fps and duration. The mock upscaler scales MP4s. The mock lip sync stream-copies the clip with a tag. Everything is probed with ffprobe. Without FFmpeg the mocks fall back to JSON clip manifests.
- **Diagnostics:** GPU names and VRAM plus the CUDA version (via `nvidia-smi`, no shell), CPU, memory, disk, FFmpeg versions, models, worker version and job counts.
- **App integration:** `connectWorker(studio)` runs at start-up when `WORKER_URL` is set and swaps the provider set to worker-backed adapters. Each adapter's `ProviderInfo` comes from the worker's `/models` (so mock stays mock). `WorkerClient` polls jobs, cancels them on abort or timeout, and verifies the SHA-256 and size of every download before anything becomes an asset. The token stays in the server process. The cost-safety gate still refuses non-mock models while `MOCK_GENERATION=true`. `GPUProvider` now declares `paid` and `local`: only paid providers need `ENABLE_CLOUD_GPU`, and the minimum-VRAM rental preference does not apply to a local machine.
