# Phase 5 completion report: real cloud GPU and real AI generation (v1.1.0)

**Summary:** the code is implemented and the RunPod integration is mock-tested; **live provider validation is pending.** No RunPod API key, no GPU and no model downloads were available in the build environment. Nothing below has run against the real RunPod API, a real GPU or a real model. Mock mode remains the default, and the whole phase cost ₹0.

| Level                                          | Status                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code implemented                               | **Yes**: RunPod v2 adapter, GPU lifecycle, cost protection, auto termination, recovery, worker image, UI, installer, docs                                                                                              |
| Tested against a mock RunPod and a fake worker | **Yes**: 64 new app tests and 16 new worker tests (including section 0)                                                                                                                                                |
| Tested against the real RunPod API             | **Partly, by the owner's dry run:** key, connectivity and `openapi.json` contract passed. The GPU list failed with HTTP 400; it is fixed (section 0) and needs one more dry run to confirm.                            |
| Tested with a real GPU                         | **No**                                                                                                                                                                                                                 |
| Tested with a real AI model                    | **No** (adapters contract-tested against stand-ins for the libraries)                                                                                                                                                  |
| Full real episode generated                    | **No**                                                                                                                                                                                                                 |
| Windows installer run on Windows               | **On a GitHub Windows runner:** the setup `.exe` installed the app, started it in MOCK mode and upgraded it. It has not been run on your PC yet. The new `scripts\*-Worker-Image` scripts are statically checked only. |

## 0b. Update: second real dry run (GPU discovery against the published contract)

The second real dry run reported:

> RunPod rejected the GPU catalog request (HTTP 400): product is required with include=AVAILABILITY; availability differs by product context … 49 GPU type(s) listed; 0 with a secure price … no GPU type with at least 24 GB VRAM.

**How the correct contract was established.** A new read-only workflow, **RunPod API schema snapshot**, downloaded Runpod's **published** `https://api.runpod.io/v2/openapi.json` (REST API 2.0.0) and the "List GPU types" reference. It used no key. The relevant parts are kept as test fixtures:

- `test/fixtures/runpod-catalog-openapi.json`
- `test/fixtures/runpod-pods-openapi.json`

**Root cause of the HTTP 400.**

- Availability in `GET /v2/catalog/gpus` is **product-specific**: `product` (`POD` | `CLUSTER` | `SERVERLESS`) is **required** with `include=AVAILABILITY`, and there is no default.
- The previous build did read the declared parameters, but it only knew `include`/`cloud`/`cloudType`/`gpuCount`. It therefore sent `include=AVAILABILITY&cloud=SECURE` **without `product`**, and never sent `count` (the published name), because it only recognised `gpuCount`.

**Root cause of "0 GB / no price".** The published `GpuType` uses these fields, which the parser did not read:

- `memory` (VRAM in GB);
- `price.secure` / `price.community`;
- `secure` / `community` (offered per cloud);
- `availability` (a level string, `NONE`/`LOW`/`MEDIUM`/`HIGH`) and `dataCenters`.

The parser read `memoryInGb` and `securePrice` instead.

**Corrected sequence.**

1. `GET /v2/openapi.json` reads the declared catalog parameters and the `product` enum.
2. `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=<cloud>&minCudaVersion=12.6` asks for pod stock for one GPU on the chosen cloud, on hosts with CUDA 12.6 or newer (the worker image's CUDA).
3. Each GPU is kept only if it has `memory` ≥ the models' VRAM, is offered on the cloud, has `price.<cloud>` ≤ the maximum ₹/h, and has `availability` of LOW, MEDIUM or HIGH.

A price alone is never treated as availability. If stock cannot be read, prices are shown but nothing is rentable. The next GPU step is pod creation, only after the image preflight, and it now uses the published fields `disk`, `registry` and `gpu.minCudaVersion`. Its body is validated against the published schema in tests.

**Also fixed from the published pod schema:**

- `status: ERROR` now fails fast instead of waiting out the timeout;
- `cost` is read as a number.

**Worker image.**

- **Build:** the Docker build of `worker/Dockerfile.cuda` **passes** on GitHub (build-check workflow).
- **Container check:** the container was started on a CPU runner:
  - it runs `python -m ais_worker` on `0.0.0.0:8765`;
  - `/health` returns `{"status": "ok", "version": "1.1.0", "ready": true}`;
  - `/models` returns **401** without the token;
  - it has PyTorch `2.7.1+cu126`;
  - the real models (`flux1-schnell`, `wan2.2-ti2v-5b`, `kokoro-82m`, `ffmpeg-lanczos`) are listed.
- **Push:** the image is **not pushed** yet. Only the owner can push to their registry and make the package public.
- **Anonymous check:** it still reports REQUIRES AUTHENTICATION, as expected.
- **Windows scripts:** the scripts are now parsed and exercised on a Windows runner by the Windows setup workflow.

**Tests:** the mock RunPod now serves and enforces the published catalog and pod-create schemas. There are new tests for:

- the exact HTTP 400;
- the corrected request sequence;
- published-shape parsing;
- "price ≠ availability";
- the CUDA filter;
- pod-create body conformance;
- the pod status enum.

**Still not tested:** no live RunPod catalog call with the corrected request (it needs your key: run the dry run), no GPU and no push.

## 0. Update: fixes after the first real dry run (Sept 2026)

The owner ran **Run dry-run diagnostics (free)** against a real RunPod account. It passed:

- RunPod API v2 reachable;
- API key accepted;
- API contract verified against RunPod's `openapi.json`;
- models and cost limits configured.

It found two real blockers, both fixed here. **No GPU was rented and nothing was spent.**

### Blocker 1: GPU list and prices (HTTP 400)

**Root cause.** Two parts:

1. **A hard-coded request.** The GPU list request `GET /v2/catalog/gpus?include=AVAILABILITY&gpuCount=1` was hard-coded from search results. It was **not** built from the `openapi.json` contract the app had just verified, and it did not send `cloudType`. RunPod documents `cloudType`, `gpuCount` and `minCudaVersion` as valid only together with `include=AVAILABILITY`.
2. **A hidden error message.** The error reporter only read `error` / `message` strings. RunPod's validation details were therefore dropped, and only "HTTP 400" was shown.

The exact parameter RunPod objected to cannot be confirmed from the build environment: RunPod's API and docs are unreachable there, and no key was available.

**Fix.**

- **Request built from the contract:** the query is now built **from the parameters `openapi.json` declares** for that endpoint, with enum spellings taken from the document. Only declared parameters are sent, and `cloudType`/`gpuCount` go only alongside `include`. An unknown _required_ parameter is reported as API drift instead of guessed.
- **Prices without stock:** if RunPod still refuses the stock query, prices are read without it (one free GET), so the price ceiling is still enforced.
- **Pagination** is followed, and more response shapes are parsed: `gpus` wrapper, per-data-centre availability, nested prices, per-cloud flags.
- **A useful message:** the error now shows **RunPod's own validation message, with credentials removed**.
- **A clear GPU diagnostic:** the dry run reports the minimum VRAM, the price ceiling and the cheapest GPU, and names which of these ruled a GPU out.

**Tests:** a strict mock of the catalog reproduces an HTTP 400 for the old query and accepts the new one.

**Status:** fixed and mock-tested. It is **not yet confirmed against the live RunPod API**; your next dry run is the confirmation.

### Blocker 2: worker image not pullable (HTTP 403)

**Root cause.** Two parts:

1. **The image was never published.** Its build workflow could only be started by hand (`workflow_dispatch`), and GitHub only offers **Run workflow** for workflows on the default branch. The app is still on its feature branch, so GitHub never listed that workflow, and the image `ghcr.io/rahulks6/ai-story-studio-worker:1.1.0` was never built or pushed.
2. **The check could not tell why.** GHCR gives anonymous users the same 403 for a missing package as for a private one, and the old check reported every refusal as "not pullable (HTTP 403)".

**Fix.**

- **Publishing from any branch:** a tag `ai-story-studio-worker-v1.1.0` (created from GitHub's Releases page) now starts the publishing workflow, without merging first.
- **Build check:** a new build-check workflow builds the image (without pushing) on every worker change, then starts it on a CPU runner and checks `/health`, authentication, `/system` and `/models`.
- **Windows scripts:** `scripts\Build-Worker-Image.bat`, `Push-Worker-Image.bat` and `Verify-Worker-Image.bat` build, push and check the image with Docker Desktop. The token is read hidden, passed with `--password-stdin`, and Docker signs out afterwards.
- **Dockerfile hardening:**
  - the base image's PyTorch/CUDA is pinned, so the build fails rather than replacing it;
  - the Kokoro language data is pre-installed;
  - a build-time import check covers every AI library and the worker;
  - an OCI source label is added.
- **Image check with four answers:** a registry-protocol check (anonymous token, manifest, `linux/amd64`) now answers **IMAGE EXISTS AND PUBLICLY PULLABLE / IMAGE REQUIRES AUTHENTICATION / IMAGE DOES NOT EXIST / REGISTRY UNREACHABLE**. A plain-text 403 from a proxy or firewall is reported as unreachable, not as "private".
- **Preflight:** the app now **refuses to rent a GPU unless the image is publicly pullable**, both in generation and in the guided test.

**Status:**

- **Build:** ready; see the build-check workflow run for the real build result.
- **Public image:** not verified, because it is not published yet (your step).

### Worker readiness (also added)

- `/health` now returns `ready`.
- `/system` also reports whether PyTorch can use CUDA.
- READY requires a usable NVIDIA GPU. A pod without one fails at once and is terminated, instead of waiting out the timeout.
- A new test starts the worker exactly as `Dockerfile.cuda`'s `CMD` and `ENV` do, and checks port, readiness, authentication, capabilities, GPU info, jobs, cancellation, metadata and clean SIGTERM exit.

### Results of this update

- **App:** **164/164** (`npm run check`: lint, typecheck, tests with FFmpeg, build). This is the 136 earlier tests plus 28 new ones:
  - catalog discovery, pricing, VRAM and price filtering;
  - malformed responses, HTTP 400 and error sanitization;
  - the image states;
  - readiness;
  - the no-rent preflight.
- **Worker:** **84/84** (ruff, format, `mypy --strict`, pyright clean). This is the 80 earlier tests plus 4 new container start-up tests.
- **What was not tested:** no RunPod call, no GPU, no real model and no image push. Safe defaults unchanged: `MOCK_GENERATION=true`, `ENABLE_CLOUD_GPU=false`, and both switches off.

## 1. Files changed

`.env.example`, `README.md`, `package.json` / `package-lock.json` (1.1.0), `docs/ARCHITECTURE.md`, `src/app/studio.ts`, `src/config/env.ts`, `src/domain/{enums,types}.ts`, `src/lib/{errors,logger}.ts`, `src/providers/types.ts`, `src/providers/worker/{client,providers}.ts`, `src/repositories/{gpu,jobs}.ts`, `src/services/{export,generation,gpu-supervisor,settings}.ts`, `src/storage/storage.ts`, `src/web/{app,server,ui}.ts`, `src/web/pages/ops.ts`, `src/web/public/app.css`, `test/{helpers,security-web.test}.ts`, `worker/{.dockerignore,Dockerfile,pyproject.toml}`, `worker/ais_worker/{__init__,api,catalog,config,fastapi_app,schemas,server}.py`, `worker/ais_worker/adapters/diffusers_models.py` and `worker/ais_worker/models/registry.py`.

## 2. Files added

- **Cloud layer:** `src/providers/cloud/{types,http,runpod,unsupported,gpu-provider,bridge}.ts` and `src/providers/worker/validate.ts`.
- **Services:** `src/services/{cloud,cloud-test,cloud-limits,model-manager,secrets}.ts`.
- **UI:** `src/web/pages/cloud.ts`.
- **Database:** `migrations/0004_cloud_gpu.sql` (additive only; existing projects load unchanged).
- **Worker:** `worker/ais_worker/pod_guard.py`, `worker/Dockerfile.cuda`, `worker/requirements-cloud.txt` and `worker/models.cloud.json`.
- **Build workflow:** `.github/workflows/ai-story-studio-worker-image.yml` (manual only, at the repository root, which GitHub requires).
- **Windows:** `installer/windows/{install.ps1,Install-AI-Story-Studio.bat,Start-AI-Story-Studio.bat,Check-Prerequisites.bat}` and `.gitattributes`.
- **Tests:** `test/{runpod,cloud-lifecycle,cloud-web}.test.ts`, `test/fixtures/{mock-runpod,fake-worker}.ts` and `worker/tests/test_phase5_cloud.py`.
- **Docs:** `docs/{PHASE5_AUDIT,CLOUD_GPU_SETUP,RUNPOD_SETUP,MODEL_SETUP,TROUBLESHOOTING_WINDOWS,SECURITY,PHASE5_COMPLETION_REPORT}.md`.

## 3. Architecture implemented

Story Studio (Windows) → `CloudGpuProvider` (RunPod v2) → temporary NVIDIA GPU → AI worker container → real models → results downloaded, validated and stored atomically → the existing editor, mixer and FFmpeg BUILD FINAL → MP4. The GPU is terminated automatically. The cloud path plugs into the existing `GPUProvider` and supervisor, so the FFmpeg pipeline and mock mode are untouched. Details: [CLOUD_GPU_SETUP.md](CLOUD_GPU_SETUP.md) and ARCHITECTURE §19.

## 4. Cloud provider implemented

**RunPod, REST API v2** (`https://api.runpod.io/v2`; v1 retires on 15 Nov 2026):

- test connection;
- GPU catalog with prices and stock;
- create a pod (image, GPU, secure/community cloud, env, ports, pod or network volume);
- read, list (paginated), stop and terminate;
- proxy URL for the worker;
- tolerant response parsing;
- a runtime contract check against `openapi.json` that blocks creation if RunPod's API has drifted.

Vast.ai and TensorDock are explicit placeholders that refuse every call.

## 5. AI models and adapters

The cloud catalog holds FLUX.1 [schnell] (image, with reference-guided image-to-image), Wan 2.2 TI2V 5B (image → video, with a strict refusal to fall back to text-to-video), Kokoro (speech), Stable Audio Open (music, SFX and ambience; conditional licence, needs your acknowledgement), and FFmpeg/Real-ESRGAN (upscale; the upscale mode is OFF / AUTO / FORCE). Chatterbox voice cloning keeps its consent safeguards. The model manager in the app handles enabling models, licence acknowledgements, and the VRAM, precision, storage and cached state of each. See [MODEL_SETUP.md](MODEL_SETUP.md).

## 6. Security changes

- **API key storage:** a local secret store (atomic writes, `chmod 600`; the installer restricts `data\` with icacls). The UI only ever shows the masked key, and the key never reaches the browser.
- **Log redaction:** the patterns now cover RunPod keys, Hugging Face tokens and worker tokens.
- **Worker tokens:** a new random 256-bit bearer token per cloud session, forgotten when the session ends.
- **Worker:** stays authenticated behind the HTTPS proxy; the pod-side guard uses only pod-scoped credentials.
- **Web:** the licence links only render `https://` URLs; Open Logs runs no shell.
- **Storage:** atomic writes for all assets.

See [SECURITY.md](SECURITY.md) for the residual risks.

## 7. Cost protections

- **Gates:** six gates before real generation (two in `.env`, the provider, the API key, and two in-app switches).
- **Hard caps:** `.env` caps that Settings cannot exceed.
- **Limits:**
  - maximum ₹/h;
  - session budget, applied as a pre-check, before every job, and by a wall-clock timer;
  - idle shutdown (only while READY or IDLE);
  - maximum lifetime;
  - one GPU at a time by default;
  - daily and monthly budgets checked against the worst case.
- **Termination:**
  - terminate when no work is left, with BUILD FINAL holding one GPU across its steps;
  - terminate on worker start-up timeout or any session failure.
- **Crash safety:**
  - the database row is written before renting;
  - a pod create is never retried after an ambiguous failure;
  - the watchdog, start-up recovery and ownership-scoped EMERGENCY STOP GPU (a button on every page);
  - the pod-side dead-man switch.
- **Billing:** wall-clock reconciliation, so budgets see the true spend.

## 8. Tests performed

- **App** (`npm run check`: lint, typecheck, tests, build): mock RunPod server and fake cloud worker tests for:
  - adapter, auth, retries and backoff, contract drift, pagination;
  - lifecycle states, provisioning failure, provider outage, invalid key;
  - worker start-up timeout, health check, job submission, polling and cancellation;
  - download corruption (retry, then discard);
  - budget and price refusal, session budget, idle and lifetime timers, `.env` caps, concurrency limit;
  - emergency stop scope, orphan recovery on restart, job recovery with no second generation;
  - mock mode, real-mode gates;
  - the guided GPU test;
  - the UI: mode banner, masked key, no key in logs, diagnostics, confirmation step;
  - character-reference image-to-image.
- **Worker** (`npm run check:worker` plus pyright): pod guard (idle, lifetime, fallback endpoint, a real HTTP endpoint), activity tracking, per-session selection and licence acknowledgement, cached state, cloud catalog validity, image-to-image, strict image-to-video, unknown pipeline class.
- **Other checks:**
  - the built app (`npm start` from `dist/`) serves every page in MOCK mode;
  - the Cloud GPU page was checked in a real browser;
  - the installer's file references and the `.env.example` defaults were validated statically.

## 9. Test results

| Suite                     | Result                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| App: existing tests       | **100 / 100** passed (with FFmpeg; 96 run without FFmpeg, since 4 need it) |
| App: new Phase 5 tests    | **36 / 36** passed                                                         |
| App total                 | **136 / 136**; lint, typecheck and build clean                             |
| Worker: existing tests    | **68 / 68** passed                                                         |
| Worker: new Phase 5 tests | **12 / 12** passed                                                         |
| Worker checks             | ruff, format, `mypy --strict` and pyright clean                            |

## 10. Remaining limitations

- There has been no live RunPod call, no real GPU and no real model run (see the top table).
- The worker image has never been built. Its dependency pins will be proven by the first GitHub Actions build, which costs no GPU money.
- The pod-side guard relies on RunPod injecting `RUNPOD_POD_ID` / `RUNPOD_API_KEY` into pods (unverified).
- Character consistency uses image-first video plus reference-guided image-to-image; there is no IP-Adapter or LoRA identity conditioning yet.
- Music and SFX in the cloud need the Stable Audio Open licence acknowledgement; there is no ACE-Step adapter yet.
- The Windows installer in this repository is new. **Your existing installer is not in the repository and was not modified** (see PHASE5_AUDIT F1). The new scripts are untested on Windows.
- Captions and intro/outro are covered by the existing title-card track; there is no separate caption generator.

## 11. Needs your RunPod API key

- Test Connection, including the API contract check.
- Dry-run diagnostics: GPU prices and stock.
- Confirming the v2 create-pod field shapes (`gpu`, `mounts`, `ports`) against the live API.

## 12. Needs a real paid GPU test

- The guided GPU test: pod boots from the image, the worker becomes healthy through the proxy, Kokoro speaks one sentence, and the GPU terminates.
- The same with FLUX.1 [schnell] (one 512×512 image).
- Wan 2.2 image-to-video from an approved still.
- Stable Audio music and SFX (after the licence acknowledgement).
- The pod guard terminating its own pod.
- Model caching on a network volume.
- A full episode.

## 13. Exact Windows setup steps

1. Unzip `AI-Story-Studio-Cloud-v1.1.0.zip` to a folder in your user profile, e.g. `C:\Users\<you>\AI-Story-Studio`.
2. Double-click `installer\windows\Install-AI-Story-Studio.bat`.
   - It checks Node.js, Python and FFmpeg and installs only what is missing.
   - It builds the app, creates the worker environment and a safe `.env`, and adds the desktop shortcut.
3. Start **AI Story Studio** from the desktop shortcut. The banner should read **MODE: MOCK**.
4. Follow [RUNPOD_SETUP.md](RUNPOD_SETUP.md):
   - create a RunPod account with a small credit and an API key;
   - run the GitHub Actions workflow once and make the image public;
   - set `MOCK_GENERATION=false` and `ENABLE_CLOUD_GPU=true` in `.env`;
   - save the key, run Test Connection and the dry-run diagnostics;
   - switch on Cloud GPU and run the guided test;
   - only then switch on Real generation.
