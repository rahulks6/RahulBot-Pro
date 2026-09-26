# AI Story Studio — Implementation status

This file is the honest record of what has been **executed** and what has not. It uses only four
words:

| Word           | Meaning                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| **PASS**       | Actually executed, and the result was checked (automated test or a real run).               |
| **FAIL**       | Executed and did not work.                                                                  |
| **BLOCKED**    | Cannot be executed from the development machine; needs something only you have.             |
| **NOT TESTED** | The code exists but has not been executed for real (unit tests with stand-ins don't count). |

“PASS (automated)” means the code path ran end-to-end in the test suite with stand-in models (no
real AI). It is **not** a claim that real AI generation works. Real generation is only PASS after it
has run on a real GPU and the output was checked.

## Where development runs, and why real AI is BLOCKED there

The development container has no NVIDIA GPU. It also cannot reach `api.runpod.io`,
`huggingface.co`, PyPI or `download.pytorch.org` (the network policy answers 403). Your RunPod API
key exists only on your PC. So every **real** RunPod, GPU, model and YouTube step is BLOCKED here.
The app contains a one-click **Real Mode Test** (Settings → AI Engine) that runs milestone 1 on
your PC and records PASS/FAIL per step. See [REAL_MODE_TEST.md](REAL_MODE_TEST.md).

## Audit from zero (v1.2 start)

Baseline before any v1.2 change (commit 36a83c5):

| Check                                                      | Result                            |
| ---------------------------------------------------------- | --------------------------------- |
| `npm run check` (lint, format, typecheck, tests, build)    | PASS — 254/254 tests              |
| Worker `ruff`, `ruff format`, `mypy`, `pyright`, `pytest`  | PASS — 119 tests (FFmpeg present) |
| App starts on a fresh data folder; main pages answer 200   | PASS                              |
| Database migrations with automatic backup first            | PASS (automated)                  |
| Windows setup exe, install, start, Edge browser smoke (CI) | PASS (GitHub Actions, Windows)    |

What already existed and was reused (not rebuilt): projects, stories, scenes, shots, characters
with reference sheets, locations, props, styles, the generation queue, the timeline editor, audio
pipeline (TTS, music, ambience, SFX, mixing and loudness), FFmpeg BUILD FINAL (1920×1080, 30 fps,
H.264/AAC), quality checks, backups, the RunPod REST adapter with cost limits, a watchdog and
EMERGENCY STOP, the Python AI worker with real model adapters, and the Model Manager.

What the master specification asked for that did **not** exist at the start: Simple Mode, a
one-page Create flow, automatic story writing from a one-line idea, the automatic production
orchestrator, Shorts, captions files, thumbnails, YouTube metadata, YouTube OAuth and upload,
scheduling, the Publish page and the first-run wizard. Mock generation was also still the
user-facing default.

## Status by feature

The live table is kept up to date at the end of this file.
