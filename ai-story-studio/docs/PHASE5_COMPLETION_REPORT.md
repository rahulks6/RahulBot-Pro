# Phase 5 completion report: real cloud GPU and real AI generation (v1.1.0)

**Summary:** the code is implemented and the RunPod integration is mock-tested; **live provider validation is pending.** No RunPod API key, no GPU and no model downloads were available in the build environment. Nothing below has run against the real RunPod API, a real GPU or a real model. Mock mode remains the default, and the whole phase cost ₹0.

| Level                                          | Status                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code implemented                               | **Yes**: RunPod v2 adapter, GPU lifecycle, cost protection, auto termination, recovery, worker image, UI, installer, docs                                          |
| Tested against a mock RunPod and a fake worker | **Yes**: 36 new app tests and 12 new worker tests                                                                                                                  |
| Tested against the real RunPod API             | **No.** The RunPod documentation and API hosts were blocked here; the details came from search results and are verified at runtime against RunPod's `openapi.json` |
| Tested with a real GPU                         | **No**                                                                                                                                                             |
| Tested with a real AI model                    | **No** (adapters contract-tested against stand-ins for the libraries)                                                                                              |
| Full real episode generated                    | **No**                                                                                                                                                             |
| Windows installer run on Windows               | **No.** There is no Windows and no PowerShell here; the scripts were statically checked only                                                                       |

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
