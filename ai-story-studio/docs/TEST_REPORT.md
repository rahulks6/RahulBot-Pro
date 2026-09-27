# Test report — v1.3.0 (series, English + Hinglish, zero manual infrastructure)

Where: the development container (Linux, **no NVIDIA GPU**, no access to RunPod, Hugging Face,
PyPI or Google; FFmpeg 7 static build). Status words: **PASS** (executed and checked), **FAIL**,
**BLOCKED** (needs something only you have), **NOT TESTED**.

"Automated" means executed in the test suite against **stand-ins**: a mock RunPod REST API
(validated against RunPod's published OpenAPI schema), a fake cloud worker, the real Python worker
with mock models, a mock Google OAuth + YouTube Data API server, and **real FFmpeg**. It proves the
app's logic and file outputs; it does **not** prove real AI quality, real GPUs or real YouTube.

## Commands executed

| Command                                                        | Result                  |
| -------------------------------------------------------------- | ----------------------- |
| `npm run check` (ESLint, Prettier, `tsc` strict, tests, build) | **CHECK**               |
| `npm run check:worker` (ruff, ruff format, mypy, pytest)       | PASS — 126 worker tests |
| Windows CI (setup .exe build, install, Edge smoke, uninstall)  | **CI**                  |

## New tests (this version)

| File                                     | What it proves (automated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/worker-bootstrap.test.ts`          | The real bootstrap script receives the app's worker bundle (token + SHA-256), installs, and hands over to the real worker; tampered/unsafe archives are refused; the pod request uses the public PyTorch image and the bootstrap entrypoint.                                                                                                                                                                                                                                                                       |
| `worker/tests/test_bootstrap.py`         | Bootstrap server: handover, unsafe archive → failed, missing token/checksum → exit.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/series.test.ts`                    | Continuity rules (name/look/place fixes, contradictions), duplicate detection by story features, Hinglish checks and speech text; episode 1 → English master + Hinglish version with the SAME picture/clip assets, EN + HI 1920×1080 MP4s, Shorts, Roman captions, Hindi voice profiles; approval → canon; episode 2 memory + repeat flagged; rejection keeps canon; **three consecutive episodes** (3 remembers approved 1, not rejected 2; no repeat; cast reused); Hinglish timing fit (rewrite → pace → flag). |
| `test/series-web.test.ts`                | The Series screens through HTTP like a browser: SERIES in the menu, new series, bible and season edits, original characters with Hinglish style and Devanagari pronunciation, PLAN SEASON (planned only, repeats skipped, remove), GENERATE with no idea makes the next planned episode in English + Hinglish, episode review screen (both versions, named downloads, checks, proposed canon), APPROVE (nothing uploaded), canon by hand/retire, new season, Home "Continue Series".                               |
| `test/channels.test.ts`                  | Two channel profiles against the mock Google: separate sign-ins and tokens, same-channel warning, per-channel schedules with the audience's time zone (18:00 IST = 12:30 UTC), APPROVE BOTH all-or-nothing, English file → English channel and Hinglish file → Hinglish channel with `hi-Latn` Roman captions and its own title/thumbnail, private scheduled uploads, no double upload, per-channel private test, no token in logs.                                                                                |
| `test/real-mode-test.test.ts` (extended) | The Real Mode Test also sends a Hinglish line (mixed script, `hi-Latn`, a Hindi voice) and builds a validated Hinglish MP4 from the same animated clip.                                                                                                                                                                                                                                                                                                                                                            |

## What was NOT executed (and why)

| Item                                                                        | Status  | Why / what is needed                                              |
| --------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| RunPod authentication, GPU, CUDA, worker bootstrap on a real pod            | BLOCKED | your RunPod API key (only on your PC); no RunPod access from here |
| Real image, real image-to-video, real English and Hinglish voices           | BLOCKED | a real GPU (RunPod)                                               |
| Real story / Hinglish writing quality, character consistency on real images | BLOCKED | a real GPU; then a person's judgement                             |
| YouTube English / Hinglish channel, private upload, scheduling for real     | BLOCKED | your Google OAuth client and your channels                        |

The first real check is the **Real Mode Test** (Settings → AI Engine): one real picture → real
animation → real English narration + real Hinglish narration → two MP4s, GPU terminated. Then the
SAFE PRIVATE TEST UPLOAD on each channel (PUBLISH → YouTube). See REAL_MODE_TEST.md.
