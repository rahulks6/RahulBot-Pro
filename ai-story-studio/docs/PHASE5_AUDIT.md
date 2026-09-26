# Phase 5 audit — AI Story Studio before cloud GPU work

Audited on 2026-09-25, at commit `44673fd`, before any Phase 5 code change. This audit documents what exists, what is mock, what is missing, and exactly what Phase 5 will touch.

## 0. Findings that change the plan

| #   | Finding                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **No Windows installer exists in this repository.** There are no `.ps1`, `.bat` or `.cmd` files and no installer directory. This holds for this branch, `main`, and the zip delivered after Phase 4. The installer you run on Windows was created outside this repository. | I cannot patch a file I cannot see. Phase 5 therefore keeps every path and script an installer relies on unchanged (`npm install`, `npm run build`, `npm start`, `worker/requirements.txt`, `.env.example`, `data/`). It **adds** `installer/windows/` with the prerequisite handling you asked for (Node / Python / FFmpeg re-checks, a WinGet 1603 fallback). If you send your existing installer, it can be merged instead. |
| F2  | **RunPod REST API v1 is deprecated and retires on 15 Nov 2026**, returning 410 Gone. Staged rate limits started on 17 Sep 2026. The current API is **REST v2** at `https://api.runpod.io/v2`.                                                                              | Phase 5 targets v2 only. The v1 endpoints most online examples use would stop working in seven weeks.                                                                                                                                                                                                                                                                                                                          |
| F3  | The RunPod documentation hosts (`docs.runpod.io`, `rest.runpod.io`, `api.runpod.io`) and GitHub are **blocked by this build environment's network policy**. Only web-search summaries were reachable.                                                                      | The adapter uses only the v2 details confirmed by several independent sources (below). Everything else is parsed tolerantly. A **runtime contract check** fetches RunPod's published `https://api.runpod.io/v2/openapi.json` from your PC and verifies every path and field we use before the first paid action. Live validation is still pending.                                                                             |
| F4  | Node 24.21 (your PC) runs `.ts` sources natively. `node:sqlite` is available. The `--disable-warning=ExperimentalWarning` flag is harmless.                                                                                                                                | No runtime change is needed for Node 24. The `engines` field stays `>=22.18`.                                                                                                                                                                                                                                                                                                                                                  |
| F5  | The npm `worker` script calls `python3`. On Windows `python3` is often the Microsoft Store alias.                                                                                                                                                                          | The installer and the docs use the venv's `python.exe`. The script is left unchanged so existing shortcuts keep working.                                                                                                                                                                                                                                                                                                       |

### RunPod API v2 facts used (from search results; verified again at runtime)

- **Base and auth:** base `https://api.runpod.io/v2`, header `Authorization: Bearer <API key>`, OpenAPI document at `/v2/openapi.json`.
- **Create:** `POST /v2/pods` with `name` and `image` required. The GPU is `gpu: { id, count }`, and exactly one of `gpu` or `cpu` must be set. Also `cloud` (default `SECURE`), `env` (object), `ports` (e.g. `"8765/http"`), and `mounts` (`{ persistent: { size, path } }` or `{ network: [{ volumeId, path }] }`).
- **Get and delete:** `GET /v2/pods/{id}` and `DELETE /v2/pods/{id}`.
- **Lifecycle:** `POST /v2/pods/{id}/action` with `{ "action": "start|stop|restart|terminate" }`.
- **List:** `GET /v2/pods` returns results with cursor pagination.
- **GPU catalog:** `GET /v2/catalog/gpus` (`include=AVAILABILITY`, `gpuCount`). Fields include `id`, `displayName`, `memoryInGb`, `securePrice`, `communityPrice`, `lowestPrice.uninterruptablePrice` and `stockStatus`.
- **Rate limits:** a 429 carries `Retry-After`. A create call must not be retried after a network error or 5xx, because a lost response must never duplicate a billed pod.
- **Pod HTTP proxy:** `https://{podId}-{port}.proxy.runpod.net`, with a 100-second request limit (Cloudflare 524).

## 1. Architecture (as found)

```
Browser (server-rendered pages, CSRF, strict CSP)
   │  127.0.0.1 only
Node 22/24 app (TypeScript, no runtime npm deps)
   ├─ Studio composition root (src/app/studio.ts)
   ├─ Repositories over node:sqlite (migrations 0001–0003)
   ├─ Services: generation queue, audio pipeline, timeline/mixer, assembler (FFmpeg),
   │            export/BUILD FINAL, quality, budget, GPU supervisor, voice consent, benchmarks
   ├─ ProviderSet (image, video, upscaler, tts, music, sfx, lipsync, gpu, probe)
   │     ├─ mock providers (default)
   │     └─ worker providers (WORKER_URL → Python worker over HTTP + bearer token)
   └─ LocalStorageProvider (DATA_DIR/storage, traversal-safe keys, SHA-256)
Python worker (worker/ais_worker): stdlib HTTP server (+FastAPI adapter), job manager,
   model registry with licence gate, adapters (diffusers image / I2V, Kokoro, Chatterbox,
   Stable Audio, spandrel, command lip sync, FFmpeg), benchmark harness.
```

## 2. Existing functionality

- **Projects and characters:** projects, stories, scenes and shots; characters with variants and reference sheets; locations; props; styles; Character, Location, Prop and Voice Locks; Story Package import; Prompt Builder.
- **Generation queue** (`src/services/generation.ts`): jobs run immediately or in batches. **GPU jobs are batched into one supervised GPU session:** `plan → withSession → run → terminate in finally`. The queue retries, keeps immutable attempt history, and supports approve / reject / regenerate and cancellation.
- **Audio:** TTS, music, SFX and ambience layers; audio caching; an automatic timeline; ducking; the mixer (−1 dBFS ceiling); solo previews; voice references with consent records and revocation.
- **BUILD FINAL:** real FFmpeg assembly to H.264 + AAC 48 kHz at 1080p or 1080×1920, with crossfades, fades, titles and two-pass loudnorm to −14 LUFS, validated with ffprobe. Without FFmpeg it falls back to a mock master.
- **Quality:** story, visual and audio checks, similarity, a YouTube checklist and human review.
- **Costs and GPU safety:** simulated costs; daily and monthly budgets with warn and block thresholds; a GPU supervisor with a price cap, worst-case budget check, idle timeout, maximum lifetime, watchdog and orphan policy; a tag-scoped kill switch; shutdown cleanup.
- **Worker:** authentication (constant-time bearer, 24+ characters), a job manager (cancel, timeouts, persistence), diagnostics, the licence gate and the benchmark harness.
- **Backup and restore**, **Model Benchmarks** with human selection, and the **Settings** page.

## 3. Mock vs real

| Area                                           | Status                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image / reference / video / upscale / lip sync | Mock by default. Real adapters exist in the worker (Phases 3–4) but have **never run on a real GPU**.                                                                     |
| TTS / music / SFX                              | Mock WAV synthesis by default. Real adapters: Kokoro, Chatterbox, Stable Audio (not yet run on a real GPU).                                                               |
| GPU provisioning                               | `MockGPUProvider` (simulated) or `LocalWorkerGpuProvider` (₹0). **No cloud provider exists.** The `runpod`, `tensordock` and `vast` values exist only as a settings enum. |
| Costs                                          | Simulated for mock, ₹0 for the local worker.                                                                                                                              |
| Mix and final MP4                              | Real.                                                                                                                                                                     |

## 4. Incomplete functionality (relevant to Phase 5)

1. There is no cloud GPU provider, no pod lifecycle, and no way to reach a remote worker other than a fixed `WORKER_URL`.
2. `GPUProvider.provision` assumes an instance is instantly usable. There is no readiness or health wait, and no worker binding per session.
3. Worker providers are bound once at start-up (`connectWorker`). They cannot follow a per-session cloud worker.
4. TTS, music and SFX jobs are "local" jobs. In cloud mode they must go into the GPU batch.
5. There is no remote job id on `generation_jobs`, so a restart could lose or duplicate remote work.
6. Downloads are verified by SHA-256 and size in memory. There is no file-type or readability validation and no retry, and storage writes are not atomic (no temp file and rename).
7. There is no session budget (only daily and monthly limits) and no concurrent-instance limit.
8. The diffusers image adapter refuses image-to-image, so character reference images are not sent to the worker. The I2V adapter would silently degrade to text-to-video if a pipeline ignored `image`.
9. There is no secret storage for cloud API keys, no log redaction, and no "Open Logs" action.
10. The worker Dockerfile is CPU and mock-only. There is no CUDA image.
11. There is no Windows installer in the repository (F1).

## 5. Provider interfaces

`src/providers/types.ts`: `ImageModel`, `VideoModel`, `Upscaler`, `TextToSpeechProvider`, `MusicProvider`, `SoundEffectProvider`, `LipSyncProvider`, `MediaProbe` and `GPUProvider` (`listOffers`, `provision`, `terminate`, `listInstances`, plus `paid` and `local` flags). Implementations:

- `src/providers/mock/*`
- `src/providers/worker/providers.ts` (the `Worker*` providers and `LocalWorkerGpuProvider`)
- `src/providers/ffprobe.ts`

The registry and the mock-mode gate live in `src/providers/registry.ts` (`assertGenerationAllowed`).

## 6. Generation pipeline

`GenerationService.processQueue`:

1. Assert the mode gates.
2. Run local jobs.
3. Plan the GPU (cheapest offer ≤ max ₹/h with the needed VRAM, then a worst-case budget check).
4. Run `withSession`, which records usage per job.
5. Terminate in `finally`.

`BUILD FINAL` queues missing speech, beds and lip sync, calls `processQueue` up to three times, then mixes and assembles.

## 7. Worker architecture

- **HTTP API** (`worker/ais_worker/api.py`):
  - `/health` needs no authentication.
  - `/models`, `/system`, `/jobs`, `/jobs/{id}`, `/jobs/{id}/files/{name}`, `/jobs/{id}/cancel`, `/generate/*`, `/process/*` and `/benchmarks` need a bearer token.
- **Job manager:** one worker thread by default, cooperative cancellation, and a per-job timeout.
- **Models:** the catalog comes from `WORKER_MODELS_FILE` and passes the licence gate; the registry uses LRU loading.
- **Container:** the Docker image is CPU-only (`python:3.11-slim`) and runs FastAPI with uvicorn.

## 8. Configuration

- `.env` holds `MOCK_GENERATION` (true), `ENABLE_CLOUD_GPU` (false), `HOST`, `PORT`, `DATA_DIR`, `WORKER_*`, `ASSEMBLY_MODE`, `FFMPEG_PATH` and `FFPROBE_PATH`.
- Runtime settings are stored in SQLite (`SettingsService`) under `budget`, `gpu`, `generation`, `audioMix`, `quality` and `encoding`.

## 9. Safety controls (as found)

- **Mode gate:** mock mode refuses real or paid providers; paid providers need both `MOCK_GENERATION=false` and `ENABLE_CLOUD_GPU=true`.
- **GPU supervisor:**
  - price cap;
  - worst-case budget check (maximum lifetime × rate);
  - termination in `finally`;
  - idle timeout and maximum lifetime;
  - watchdog with an orphan policy;
  - kill one or kill all, limited to studio-tagged resources, with typed confirmation;
  - shutdown cleanup on SIGINT and SIGTERM.
- **Web:** CSRF, same-origin checks, CSP, loopback binding, traversal-safe media.
- **Worker:** token authentication, safe path handling, shell-free FFmpeg calls, upload limits.

## 10. Tests (as found)

- App: 100 tests (`node --test`), with 4 of them skipped when FFmpeg is missing.
- Worker: 68 pytest tests, plus ruff, mypy (strict) and pyright.
- None of them touches a paid service.

## 11. Installer architecture

There is none in this repository (F1).

## 12. Files Phase 5 will modify or add

**Modify:**

- `src/providers/types.ts`: optional readiness and worker-binding hooks on `GPUProvider`, and `RunContext` remote-job hooks.
- `src/services/gpu-supervisor.ts`: lifecycle states, worker readiness wait with timeout-then-terminate, session budget, concurrency limit, budget-exceeded termination, crash recovery.
- `src/services/generation.ts`: cloud jobs go into the GPU batch (including TTS and audio in cloud mode), remote-job persistence and resume.
- `src/services/settings.ts`: `cloud` settings, upscale mode.
- `src/providers/registry.ts`: the real-cloud gate.
- `src/providers/worker/client.ts`: download retries and validation, remote-job hooks, resume.
- `src/providers/worker/providers.ts`: reference image to the worker.
- `src/storage/storage.ts`: atomic writes (temp file, then rename).
- `src/lib/logger.ts`: secret redaction.
- `src/config/env.ts`: new environment variables.
- `src/app/studio.ts`: cloud wiring.
- `src/web/server.ts`: crash recovery on start, SIGHUP/SIGBREAK on Windows.
- `src/web/ui.ts`: an always-visible mode badge and emergency stop.
- `src/web/pages/ops.ts`: GPU page states.
- `.env.example`, `package.json` (version 1.1.0) and `README.md`.
- `worker/ais_worker/{config,api,adapters/diffusers_models,server}.py`: self-termination guard, image-to-image, a strict I2V check, model manager fields.
- `worker/models.example.json`.

**Add:**

- `migrations/0004_cloud_gpu.sql`
- `src/providers/cloud/{types,http,runpod,unsupported,bridge}.ts`
- `src/services/{cloud,secrets,model-manager}.ts`
- `src/web/pages/cloud.ts`
- `worker/Dockerfile.cuda`, `worker/requirements-cloud.txt`, `worker/models.cloud.json`, `worker/ais_worker/pod_guard.py`
- `.github/workflows/ai-story-studio-worker-image.yml` (manual trigger only)
- `installer/windows/*`
- tests for all of the above
- docs: `CLOUD_GPU_SETUP.md`, `RUNPOD_SETUP.md`, `MODEL_SETUP.md`, `TROUBLESHOOTING_WINDOWS.md`, `SECURITY.md`, `PHASE5_COMPLETION_REPORT.md`
