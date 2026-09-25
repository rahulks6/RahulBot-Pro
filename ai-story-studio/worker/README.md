# AI Story Studio worker (Phase 2)

The worker is the Python process that will run the open-source AI models on a GPU. The studio app talks to it over HTTP. On a local machine it runs next to the app. In Phase 5 the same container will run on a temporary cloud GPU.

> **Phase 2 ships mock models only.** They produce labelled placeholders and need no model weights. When FFmpeg is installed, the mock video, upscale and lip-sync models write **real H.264 MP4 files**, so the full media path is exercised end to end. Nothing here costs money.

## Run it

```bash
cd ai-story-studio
export WORKER_AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm run worker                       # = cd worker && python3 -m ais_worker  (Python ≥ 3.11, stdlib only)
```

Then point the app at the worker in `ai-story-studio/.env`, using the **same** token:

```
WORKER_URL=http://127.0.0.1:8765
WORKER_AUTH_TOKEN=<same token>
```

`npm run dev` connects to the worker on start-up. Settings → _Local AI worker_ shows the GPU, CUDA, FFmpeg and model status, and has a reconnect button.

The core and the built-in HTTP server need only the Python standard library. When FastAPI and uvicorn are installed (`pip install -r requirements.txt`), the production entry point is `uvicorn ais_worker.fastapi_app:app`. It is a thin adapter over the same `WorkerAPI`, so both servers behave identically.

Docker, with FFmpeg included and running as a non-root user:

```bash
docker build -t ais-worker worker/
docker run --rm -p 127.0.0.1:8765:8765 -e WORKER_AUTH_TOKEN=... -v ais-worker-data:/data ais-worker
```

## Configuration

| Variable                      | Default            | Notes                                                                                             |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `WORKER_AUTH_TOKEN`           | **required**       | At least 24 characters. The worker refuses to start without it.                                   |
| `WORKER_HOST` / `WORKER_PORT` | `127.0.0.1`/`8765` | Loopback by default. Port `0` picks a free port, which is printed at start.                       |
| `WORKER_DATA_DIR`             | `./worker-data`    | Job folders. Treated as disposable: the app downloads and verifies every output.                  |
| `WORKER_MOCK_MODELS`          | `true`             | `false` registers no models, because real adapters arrive in Phase 3. Nothing is silently mocked. |
| `WORKER_MAX_UPLOAD_MB`        | `64`               | Limit for base64 files embedded in requests.                                                      |
| `WORKER_MAX_CONCURRENT_JOBS`  | `1`                | One model on one GPU at a time.                                                                   |
| `WORKER_JOB_TIMEOUT_SEC`      | `1800`             | Jobs running longer are failed with `API_TIMEOUT`, and any FFmpeg process is killed.              |
| `FFMPEG_PATH`/`FFPROBE_PATH`  | found on `PATH`    |                                                                                                   |

## API

Every endpoint except `/health` requires `Authorization: Bearer <token>`.

| Method | Path                       | Purpose                                                                         |
| ------ | -------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/health`                  | Liveness only: `{status, version}`.                                             |
| GET    | `/models`                  | Installed models: kind, VRAM, licence, mock flag, loaded state.                 |
| GET    | `/system`                  | GPU, VRAM, CUDA, CPU, memory, disk, FFmpeg, models, worker version, job counts. |
| POST   | `/generate/image`          | Text-to-image. `init_image` is optional for image-to-image.                     |
| POST   | `/generate/image-to-video` | Animate an approved still.                                                      |
| POST   | `/generate/audio`          | `kind`: `tts` \| `music` \| `sfx` \| `ambience`                                 |
| POST   | `/process/lipsync`         | Clip plus dialogue WAV → synchronized clip. The original is kept.               |
| POST   | `/process/upscale`         | Image or clip → target resolution. Always flagged non-native.                   |
| GET    | `/jobs`, `/jobs/{id}`      | Status, progress, outputs (size, SHA-256, dimensions), metrics, errors, logs.   |
| POST   | `/jobs/{id}/cancel`        | Cancels queued or running jobs. FFmpeg subprocesses are killed.                 |
| GET    | `/jobs/{id}/files/{name}`  | Download an output file.                                                        |

Generation calls return `202` with a job. Poll `/jobs/{id}` until the status is `complete`, `failed` or `cancelled`.

**Job lifecycle:** `queued → loading_model → running → complete | failed | cancelled`. Every failure carries a stable code, such as `OUT_OF_MEMORY`, `CUDA_FAILURE`, `MODEL_LOAD_FAILED`, `FFMPEG_FAILED` or `API_TIMEOUT`. A crashing model fails its job, never the worker. Job records are saved to disk. If the worker restarts, jobs that were running are marked `failed` (`WORKER_UNAVAILABLE`) and finished results stay available.

## Security

- **Authentication:** constant-time bearer-token comparison. The token is never logged; the request log contains method and path only.
- **Paths:** every file path is resolved inside the job directory, and traversal, absolute paths, hidden files and symlink escapes are rejected. Download names must be simple names with an allowed extension.
- **Inputs:** every field is type- and range-checked, and unknown fields are rejected. Embedded files are size-limited and identified by magic bytes, never by name or declared type.
- **Execution:** subprocesses run from argument lists with no shell, time limits and kill-on-cancel. There is no endpoint that executes commands.
- **Credentials:** the worker needs **no cloud credentials**. It only holds its own bearer token.
- **Errors:** error responses never include stack traces; internals are logged on the worker only.

## Development

```bash
npm run check:worker     # ruff check + ruff format --check + mypy --strict + pytest
pyright                  # optional, from worker/
```

Tests that need FFmpeg are skipped when it is not installed. Set `FFMPEG_PATH`/`FFPROBE_PATH` to use a specific build.

## Model interfaces

`ais_worker/models/base.py` defines `Model` with `load` (called once per worker, tracked by the registry), `unload` and `run(request, ctx)`, plus `ModelInfo`: id, kind, version, licence, minimum VRAM, device and mock flag. The registry keeps at most two models loaded and unloads the least recently used. Phase 3 adds benchmarked open-source adapters (image, image-to-video, TTS, music, SFX, lip sync, upscaling) behind these interfaces. No model is chosen in advance.
