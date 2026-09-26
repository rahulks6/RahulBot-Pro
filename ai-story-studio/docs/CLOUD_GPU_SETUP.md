# Cloud GPU: how it works (Phase 5)

For the click-by-click setup, see [RUNPOD_SETUP.md](RUNPOD_SETUP.md). This page explains the design.

```
AI Story Studio (Windows, no NVIDIA GPU)
   │  0. preflight: the worker image must be publicly pullable (anonymous registry check), else nothing is rented
   │  1. plan: cheapest GPU ≥ needed VRAM and ≤ max ₹/h; batch estimate ≤ session budget; worst case ≤ daily/monthly budget
   │  2. create pod  ── RunPod REST API v2 (https://api.runpod.io/v2) ──►  temporary NVIDIA GPU
   │                                                                       └─ AI worker container (worker/Dockerfile.cuda)
   │  3. wait: BOOTING → WORKER_STARTING → READY (/health ready=true, then authenticated /system: a usable NVIDIA GPU and CUDA-enabled PyTorch)
   │  4. send jobs ── https://{pod}-8765.proxy.runpod.net + per-session bearer token ──► real models
   │  5. poll gently (2 s → 6 s), download, validate every file, store atomically
   │  6. terminate when no work remains (or idle / lifetime / budget / Stop / Emergency / failure)
   ▼
Existing editor, mixer and FFmpeg BUILD FINAL → final 1080p MP4
```

## Modes and gates

The app is always in exactly one mode, shown in a banner on every page:

| Mode               | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| **MOCK** (default) | Placeholders only, ₹0                                         |
| **MOCK PROVIDERS** | `.env` unlocked, but real cloud generation is not switched on |
| **LOCAL WORKER**   | A worker you run yourself (`WORKER_URL`), ₹0                  |
| **REAL CLOUD**     | Real models on a rented GPU; costs money                      |

REAL CLOUD requires **all six** gates:

1. `MOCK_GENERATION=false` in `.env`.
2. `ENABLE_CLOUD_GPU=true` in `.env`.
3. The provider is implemented (RunPod).
4. An API key is saved.
5. **Cloud GPU enabled** is switched on in the app.
6. **Real generation enabled** is switched on in the app.

The first five alone allow the guided test GPU. The GPU supervisor re-checks the gates before every rental. There is no path from mock to paid generation without all of them.

## Lifecycle states

`DISABLED → AUTHENTICATING → PROVISIONING → BOOTING → WORKER_STARTING → READY → GENERATING ⇄ DOWNLOADING → IDLE → TERMINATING → STOPPED`, or `FAILED`. Every transition is stored (`gpu_instances.lifecycle_state`) and logged as a GPU event. The GPU page shows the history; the banner shows the live state, runtime and cost.

## Cost protection

| Limit                  | Setting / `.env` hard cap                                 | Enforcement                                                                                     |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hourly price           | `maxHourlyRateInr` / `MAX_GPU_HOURLY_RATE`                | GPUs above it are never rented. USD prices are converted with the `usdToInr` setting.           |
| Session budget         | `sessionBudgetInr` / `SESSION_BUDGET`                     | Batch estimate refused above it; checked before every job; timer terminates at it (wall clock). |
| Idle shutdown          | `idleTimeoutMinutes` / `IDLE_SHUTDOWN_MINUTES`            | Counts only while the GPU is READY or IDLE (a long video job is not idle).                      |
| Maximum lifetime       | `maxLifetimeMinutes` / `MAX_GPU_LIFETIME_MINUTES`         | Terminates at the limit whatever is running.                                                    |
| Concurrent GPUs        | `maxConcurrentInstances` / `MAX_CONCURRENT_GPU_INSTANCES` | Default 1; a second start is refused (`GPU_LIMIT`).                                             |
| Daily / monthly budget | Settings → Budget                                         | Worst case (lifetime or session budget) must fit before renting.                                |

`.env` caps can only **lower** the Settings values. At termination, wall-clock time not attributed to jobs (boot, waits) is recorded as idle usage, so budgets see the true spend.

## Automatic termination

The GPU is terminated when:

- no generation work remains (`after_batch`, the default; BUILD FINAL holds one GPU across its speech, music and lip-sync runs);
- the idle timeout expires;
- the maximum lifetime is reached;
- the session budget is reached;
- you press **Stop GPU** or **EMERGENCY STOP GPU**;
- the worker fails to start within the start-up timeout (default 8 minutes);
- the worker becomes unusable.

Termination is retried; a failure stays in `TERMINATING` for the watchdog, which also runs every minute. On shutdown (Ctrl+C, closing the console window via SIGHUP/SIGBREAK) the app terminates its GPUs.

**Backup inside the GPU:** `worker/ais_worker/pod_guard.py` terminates its own pod when no authenticated request arrives for idle + 10 minutes, or at lifetime + 5 minutes. It uses the pod-scoped `RUNPOD_POD_ID` / `RUNPOD_API_KEY` that RunPod injects into pods; your account key is never sent to the GPU. _(Pending live validation: confirm on the first real test that RunPod injects these variables.)_

## Ownership, crash recovery and the emergency stop

- Every pod is named `ais-<installation-id>-<random>`. The studio only ever terminates pods with its own installation prefix; your other pods and other PCs' pods are never touched.
- The database row is written **before** renting, so a crash cannot lose track of a paid resource.
- **On start-up:** interrupted jobs are requeued; leftover pods are terminated (or re-attached and left to the idle timer if cloud mode is on and the pod is healthy).
- **Job recovery:** each remote job id is stored. After a restart, the same GPU's job is re-polled and downloaded instead of being generated again.
- **EMERGENCY STOP GPU** terminates every tracked GPU **and** every pod at RunPod with this installation's prefix, in any mode.

## Downloads, retries and errors

- **Downloads** are validated for HTTP status, `Content-Length`, SHA-256 and size, real file type (magic bytes) against the declared type, minimum size, WAV decodability and, for video, ffprobe readability on a temporary `.partial` file. Up to 3 attempts; a file that stays corrupted is discarded ("Asset download failed validation… The corrupted file was discarded.").
- **Retries** use bounded exponential backoff (1 s → 30 s, `Retry-After` honoured) for rate limits, 5xx and network errors. A pod **create** is never retried after an ambiguous failure, so a lost response cannot rent two GPUs. Invalid keys, bad requests, unsupported GPUs, budget and licence refusals are never retried.
- **API drift:** before the first create, the app reads RunPod's published `openapi.json` and refuses to create anything if a path or required field changed.
- **GPU list and prices** (`GET /catalog/gpus`): the query is built from the parameters that `openapi.json` declares for this endpoint. `include=AVAILABILITY` asks for stock; `cloudType` and `gpuCount` are sent only together with it, as RunPod requires, and undeclared parameters are never sent. If RunPod refuses the stock query, prices are read without it (one extra free GET), so the price ceiling still applies. Pagination is followed. RunPod's validation message is shown with credentials removed. The dry run then filters by the VRAM your enabled models need and by your price ceiling, and says which of these ruled a GPU out.

## Worker start-up and readiness

The container starts the worker by itself (`CMD python -m ais_worker`), listening on `0.0.0.0:8765`, which RunPod exposes through its HTTPS proxy. The worker refuses to start without the per-session token.

| Endpoint                                                             | Authentication | What the app uses it for                                                                 |
| -------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `GET /health`                                                        | none           | `{"status","version","ready"}` only: liveness and readiness                              |
| `GET /system`                                                        | bearer token   | GPU name, VRAM, driver and CUDA version (`nvidia-smi`), and whether PyTorch can use CUDA |
| `GET /models`                                                        | bearer token   | capabilities, licences, VRAM needs, cached state                                         |
| `POST /generate/{image,video,audio,upscale,lipsync}`                 | bearer token   | submit a job (returns a job id)                                                          |
| `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, `GET /jobs/{id}/files/…` | bearer token   | status, metrics and output metadata (name, type, size, SHA-256), cancel, download        |

READY requires `/health` to answer `ready: true` **and** an authenticated `/system` that shows a usable NVIDIA GPU with CUDA-enabled PyTorch. A healthy worker on a machine without a usable GPU fails at once, and the pod is terminated, instead of waiting out the start-up timeout. The container contract (command, port, environment, `/health`, authentication, cancellation, clean exit on SIGTERM) is tested against `worker/Dockerfile.cuda` without Docker (`worker/tests/test_container_startup.py`). The **AI Story Studio worker build check** workflow builds the real image and starts it on a CPU runner (nothing is pushed).

## Container image, model cache and generated assets

These are kept apart:

| What                 | Where                                                                                | Size       | Lifetime                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container image**  | `ghcr.io/<you>/ai-story-studio-worker:1.1.0` → `/app` in the pod                     | a few GB   | Built once; code and libraries only. No model weights, no secrets.                                                                                                                           |
| **Model cache**      | `/workspace/models`, `/workspace/hf` (Hugging Face cache)                            | tens of GB | Downloaded on first use. Deleted with the pod on a pod volume; **kept between sessions on a RunPod network volume** (**Cloud GPU → Advanced → Network volume id**, same region as the GPUs). |
| **Generated assets** | `/workspace/worker-data/jobs/…` in the pod, then the studio's own storage on your PC | small      | The app downloads, validates and stores every result locally. Pod copies disappear with the pod.                                                                                             |

Weights are deliberately not baked into the image. That would make the image tens of GB, slow down every pull (and so every GPU start), and tie the image to one set of model versions. The first session with a new model is slower; with a network volume, later sessions reuse the cached weights (the model list shows **cached** per model).

## Logs

JSON-lines log in `data\logs\studio.log` (redacted), plus the **Logs** page and its **Open Logs folder** button. Cloud events include job, project, scene/shot, provider, state transitions, timings and safe error text.
