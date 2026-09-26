# Phase 2 completion report: local Python AI worker

**Status: Phase 2 implemented. Waiting for human approval before Phase 3.** No paid cloud infrastructure was started and no paid API was called. The cost was ₹0.

## What was built (spec §81)

| Spec item          | Delivered                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python             | `worker/ais_worker`: config, security, schemas, jobs, diagnostics, media, models (Python ≥ 3.11, standard library only)                                                         |
| FastAPI            | `fastapi_app.py`, a thin adapter over the shared `WorkerAPI`, plus `requirements.txt`. The stdlib `server.py` provides the identical API without dependencies.                  |
| Docker             | `worker/Dockerfile`: python:3.11-slim with FFmpeg, non-root user, `/data` volume, healthcheck, token passed at run time                                                         |
| FFmpeg / FFprobe   | `media.py`: version detection, probing, still-to-clip H.264 rendering, scaling and stream copy. No shell, time-limited, killed on cancel.                                       |
| Worker health      | `GET /health` (no auth, liveness only)                                                                                                                                          |
| Job processing     | `JobManager`: thread pool, status lifecycle, per-job directories, outputs with SHA-256, metrics (load, run and GPU seconds), persisted records, recovery after restart, pruning |
| Cancellation       | `POST /jobs/{id}/cancel`: queued jobs cancel immediately; running jobs stop cooperatively, and FFmpeg is killed. Tested to finish in under 2 s.                                 |
| System diagnostics | `GET /system`: GPU and VRAM plus CUDA via `nvidia-smi`, CPU, memory, disk, FFmpeg versions, models, worker version, job counts                                                  |
| Model interfaces   | `Model` / `ModelInfo` / `ModelRegistry` (load once, LRU unload), with mock image, video, TTS, music, SFX/ambience, lip-sync and upscale adapters                                |

**App integration:**

- `WorkerClient`, worker-backed providers and `LocalWorkerGpuProvider` (₹0/h, `local`, never `paid`).
- `connectWorker` at start-up, a worker card with reconnect on the Settings page, and `npm run worker`.
- Downloads are SHA-256 verified before they are stored.
- MP4 previews in the UI, and HTTP Range support so browsers can seek video.

## Tests and checks

| Check                                                | Result                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker: `ruff check`, `ruff format --check`          | clean                                                                                                                                                |
| Worker: `mypy --strict`, `pyright`                   | clean (the FastAPI adapter is excluded because FastAPI was not installable)                                                                          |
| Worker: `pytest`                                     | **34 passed**: security, schemas, jobs, cancellation, timeouts, restart recovery, models, audio, FFmpeg (real H.264), HTTP end to end                |
| App: `npm run check` (lint, typecheck, tests, build) | clean; **84 tests passed**                                                                                                                           |
| App ↔ worker integration (`test/worker.test.ts`)     | starts the real worker process, rejects a wrong token, runs a whole episode through the worker to BUILD FINAL complete, and keeps the mock-only gate |
| Manual run                                           | demo seed through the worker: export complete in about 28 s with real MP4 clips; UI crawl clean                                                      |

FFmpeg tests ran against a static FFmpeg build. They are skipped automatically when FFmpeg is absent.

## Security decisions

- **Authentication:** a token of at least 24 characters is required. The worker refuses to start without it. Comparison is constant-time. The token never appears in logs, responses or the browser.
- **Network:** the worker binds to loopback by default, and `/health` exposes only status and version.
- **Files:** outputs are confined to the job directory, with traversal, symlink and hidden-file checks. Downloads are allow-listed by name and extension.
- **Inputs:** strict validation (types, ranges, unknown fields rejected). Embedded files are size-limited and checked by magic bytes. Request bodies are capped.
- **Execution:** no shell anywhere. Subprocesses have time limits and are killed on cancellation.
- **Credentials:** the worker holds no cloud credentials. Errors are returned as stable codes, with no stack traces.

## Cost-safety changes

- `GPUProvider` now declares `paid` and `local`.
- Only paid providers need `MOCK_GENERATION=false` and `ENABLE_CLOUD_GPU=true`.
- The local worker is never paid and costs ₹0/h.
- With `MOCK_GENERATION=true`, generation still refuses any non-mock model, including models reported by the worker (tested).
- `WORKER_MOCK_MODELS=false` registers no models instead of silently mocking.

## Known limitations

- **FastAPI and Docker are unverified here.** PyPI and Docker Hub were blocked in this environment, so the FastAPI adapter and the Docker image were written but not installed or built. The stdlib server serves the identical API and is what the tests exercise.
- **No GPU in this environment.** GPU diagnostics were verified on the "no GPU" path only (`nvidia-smi` is absent).
- **Mock models only.** Real open-source adapters are Phase 3.
- **Playwright's Chromium cannot decode H.264.** It lacks proprietary codecs, so in-browser MP4 playback was verified by serving and ffprobe-checking the files rather than by playing them. Chrome, Edge, Safari and Firefox play H.264.
- **Queue still runs in the web request.** The app-side generation queue still runs inside the web request. It now waits on worker jobs, but a background queue loop remains a later improvement.

## Phase 3 recommendations (benchmark real open-source models)

1. Install PyTorch with CUDA in a CUDA-based worker image. Add adapters behind `Model` for image (FLUX-family and SDXL-family candidates), image-to-video (LTX-family and Wan-family candidates), upscaling, and TTS. Choose models by measured quality, consistency, VRAM, speed, reliability and licence.
2. Add a `benchmark` job type that records VRAM peak, load and run time, and output metadata into the job metrics. The app then stores the results in its usage and attempt history.
3. Test on a local GPU first (the `LocalWorkerGpuProvider` path). Cloud GPUs stay off until Phase 5, and paid runs until explicit approval (spec §85).
