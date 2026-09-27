# Test report — v1.3.1

Three kinds of result, never mixed: **automated tests** (stand-ins), **real integration tests** (real
RunPod, real models, real YouTube) and **manual media review** (a person watches and listens). A PASS in
the first kind says nothing about the other two.

Where: the development container (Linux, no NVIDIA GPU, Node.js v22.22.2, static FFmpeg 7). Its network
proxy rejects RunPod, Hugging Face and Google; PyPI answers 403; no RunPod key exists there (checked
2026-09-27).

## 1. AUTOMATED TESTS (stand-ins: mock RunPod, fake worker, mock Google, placeholder AI; real FFmpeg)

| Command / suite                                                          | Result                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `npm run check` — ESLint, Prettier, `tsc` strict, all app tests, build   | **CHECK**                                                       |
| Worker: `ruff check`, `ruff format --check`, `mypy` (strict), `pytest`   | **PASS** — 128 passed, 0 failed, 0 skipped (FFmpeg on the PATH) |
| Installer (Go): `go vet`, `go test` in `installer/windows/setup`         | **PASS**                                                        |
| Windows CI (build the .exe, install, Edge through every page, uninstall) | **CI**                                                          |

The one skipped app test is "Windows DPAPI round trip" (Windows only; it runs in Windows CI).

What the app suite covers (all executed in this run): database (clean migration on a real SQLite
file — 9 migrations, 53 tables, 27 indexes, FK and integrity checks, upgrade from 0008 with data kept,
app start on the migrated file; installer migration list = `migrations/`), repositories, Series /
Seasons / Episodes / Bible, continuity and canon approval over three consecutive episodes, duplicate
detection, English script, Hinglish localization, style checks and timing fit, shared master visuals,
Shorts, captions, thumbnails, metadata, the Series and Publish pages through HTTP, RunPod lifecycle
(provisioning, fallback, budget, watchdog, recovery), the worker bootstrap (real bootstrap script + real
worker, no GPU), YouTube with two channel profiles (mock Google; private only), the Real Mode Test harness
(22 stages; image and motion validation, two MP4s from one clip, ffprobe, decode; clean-up on success,
failure, cancel and timeout), the character consistency harness (13 reference-conditioned requests,
contact sheet, verdict) and the 20–30 s bilingual scene (placeholder AI, real FFmpeg, EN + HI finals from
one visual production).

New or changed tests in v1.3.1: `migrations-schema.test.ts` (7), `scene-test.test.ts` (1),
`real-mode-test.test.ts` (10, rewritten), `orchestrator.test.ts`, `worker/tests/test_bootstrap.py`
(+2), `worker/tests/test_catalog_adapters.py` (Kokoro voice names).

## 2. REAL INTEGRATION TESTS (real RunPod GPU, real models, real YouTube)

| Stage                                     | Result                                          | What is needed                                        |
| ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| RunPod authentication                     | **BLOCKED**                                     | your RunPod key (on your PC; RunPod unreachable here) |
| GPU provision / CUDA proven by the worker | **BLOCKED**                                     | same                                                  |
| Worker bootstrap on a real pod            | **BLOCKED**                                     | same                                                  |
| Image model load + real image             | **BLOCKED**                                     | same                                                  |
| Video model load + real animation         | **BLOCKED**                                     | same                                                  |
| English TTS / Hinglish TTS                | **BLOCKED**                                     | same                                                  |
| test_english.mp4 / test_hinglish.mp4      | **BLOCKED**                                     | same                                                  |
| GPU clean-up (success / failure / cancel) | **NOT TESTED** for real (PASS against the mock) | same                                                  |
| Character consistency (13 real pictures)  | **BLOCKED**                                     | same                                                  |
| 20–30 s bilingual scene with real AI      | **BLOCKED**                                     | same                                                  |
| YouTube private upload — English channel  | **BLOCKED**                                     | your Google OAuth client + channel                    |
| YouTube private upload — Hinglish channel | **BLOCKED**                                     | same                                                  |

No real asset was generated in this pass. No GPU was rented. Nothing was uploaded.

## 3. MANUAL MEDIA REVIEW (a person watches and listens)

| Review                      | Result         |
| --------------------------- | -------------- |
| Real image                  | **NOT TESTED** |
| Real motion                 | **NOT TESTED** |
| English voice               | **NOT TESTED** |
| Hinglish voice              | **NOT TESTED** |
| Character consistency       | **NOT TESTED** |
| Bilingual scene (both cuts) | **NOT TESTED** |

These are recorded in the app (Advanced → Real Mode Test) when you mark them after your run.

## How to turn section 2 and 3 into results

1. Install `AI-Story-Studio-Setup-1.3.1.exe`, paste your RunPod key (Settings → AI Engine), SAVE.
2. Advanced → Real Mode Test → RUN → CONFIRM; review the four outputs.
3. Run the character consistency test; give your verdict.
4. Run the bilingual scene test; watch both versions.
5. PUBLISH → YouTube: connect both channels; SAFE PRIVATE TEST UPLOAD on each.
