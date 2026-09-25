# Cloud GPU: how it works (Phase 5)

For the click-by-click setup, see [RUNPOD_SETUP.md](RUNPOD_SETUP.md). This page explains the design.

```
AI Story Studio (Windows, no NVIDIA GPU)
   │  1. plan: cheapest GPU ≥ needed VRAM and ≤ max ₹/h; batch estimate ≤ session budget; worst case ≤ daily/monthly budget
   │  2. create pod  ── RunPod REST API v2 (https://api.runpod.io/v2) ──►  temporary NVIDIA GPU
   │                                                                       └─ AI worker container (worker/Dockerfile.cuda)
   │  3. wait: BOOTING → WORKER_STARTING → READY (authenticated health check)
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

## Logs

JSON-lines log in `data\logs\studio.log` (redacted), plus the **Logs** page and its **Open Logs folder** button. Cloud events include job, project, scene/shot, provider, state transitions, timings and safe error text.
