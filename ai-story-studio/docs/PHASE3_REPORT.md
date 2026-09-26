# Phase 3 report: real open-source models, licence gate and benchmark workflow

**Status: Phase 3 infrastructure is implemented. The benchmarks themselves still need to be run on your GPU machine. Waiting for your results and approval before Phase 4.** Nothing was rented or downloaded, and the cost was ₹0.

## Why the benchmarks were not run here

Spec §82 asks to benchmark real models for quality, consistency, VRAM, speed, reliability, licence and integration effort. The build environment has **no GPU**, **no access to the model hub**, and **no PyPI or PyTorch downloads**, so no real model could be loaded. The work therefore delivers everything needed to run those benchmarks on your own GPU, with one command or from the app, and to decide from the results. Following the spec, **no model was chosen in advance**.

## Delivered

| Area               | What                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate research | `worker/models.example.json`: 18 candidates across image, image-to-video, TTS, upscale, music, SFX and lip sync, each with licence class, notes and sources (public information, September 2026). All are disabled.                                                                |
| Licence gate       | Worker: non-commercial and unknown models refused; conditional models need acknowledgement; refusals reported with the reason. App: non-commercial and unknown models can never be selected for production.                                                                        |
| Real adapters      | diffusers text-to-image (FLUX / Qwen-Image / SDXL families), diffusers image-to-video (Wan / LTX families, with frame and dimension snapping and fps retiming), Kokoro TTS, Chatterbox TTS, FFmpeg Lanczos upscaler                                                                |
| Adapter behaviour  | Only supported arguments passed, cancellation between steps, peak-VRAM tracking, error mapping (`OUT_OF_MEMORY`, `CUDA_FAILURE`, `MODEL_LOAD_FAILED` with install hints)                                                                                                           |
| Benchmark harness  | `POST /benchmarks` and a CLI. The built-in suite covers the same character in several situations, an establishing shot, in-image text, motion, and emotional speech. It records load and run times, VRAM, reliability, reproducibility and technical checks.                       |
| App                | Model Benchmarks page: start, refresh and import (SHA-256 verified), side-by-side outputs, 1–5 quality and consistency ratings, aggregates with cost per output, licence-checked selection with rationale and history. The selection drives which worker model each provider uses. |
| Docs               | `docs/BENCHMARKING.md`: a step-by-step guide for the GPU machine. `worker/requirements-gpu.txt`.                                                                                                                                                                                   |

## Licence findings that matter for publishing

These are from public sources (September 2026). Re-check each model card before enabling.

| Model                  | Licence note                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| Qwen-Image 1.0 / 2512  | Apache-2.0. **Qwen-Image 2.1 moved to non-commercial**; do not upgrade blindly. |
| FLUX.2 [klein] 4B      | Apache-2.0.                                                                     |
| FLUX.2 [dev]           | Non-commercial without a separate licence.                                      |
| Wan 2.1 / 2.2          | Apache-2.0.                                                                     |
| LTX-2.x                | Community licence, revenue-gated (about US$10M).                                |
| Kokoro                 | Apache-2.0.                                                                     |
| Chatterbox             | MIT.                                                                            |
| F5-TTS                 | Non-commercial.                                                                 |
| ACE-Step 1.5           | Apache-2.0.                                                                     |
| MusicGen               | Non-commercial weights.                                                         |
| Stable Audio Open      | Community licence, free under US$1M revenue.                                    |
| LatentSync             | Apache-2.0.                                                                     |
| MuseTalk               | MIT; model usable commercially.                                                 |
| Wav2Lip (open release) | Non-commercial.                                                                 |

## Tests and checks

| Check                                                         | Result                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker: ruff, `ruff format --check`, `mypy --strict`, pyright | clean                                                                                                                                                                                                          |
| Worker: pytest                                                | **53 passed**: catalog and licence gate, adapter contract tests with fake libraries, real FFmpeg upscaling and frame encoding, benchmark end to end (mock models), cancellation, broken-model reliability, CLI |
| App: `npm run check` (lint, typecheck, tests, build)          | clean; **88 tests passed**, including licence-checked selection and a benchmark through a real worker process with verified imports and the selection applied on reconnect                                     |
| Manual                                                        | Benchmarks page driven in a browser: start → refresh → summary → ratings grid → selection                                                                                                                      |

**Honest limit:** the adapter tests use fakes that mimic the documented diffusers, Kokoro and Chatterbox APIs. They prove our wiring, not the libraries. The first real run on your GPU is the real verification. Errors there surface as clear job errors, and the benchmark records them as reliability failures.

## What you need to do

Follow [BENCHMARKING.md](BENCHMARKING.md):

1. On the GPU machine, install the CUDA build of PyTorch and `requirements-gpu.txt`.
2. Review and enable candidates in `models.json`, starting with the smaller ones, such as Wan 2.2 TI2V 5B, FLUX.2 [klein] 4B and Kokoro.
3. Run the benchmark from the Model Benchmarks page, rate the outputs, and record your selections.

## Phase 4 recommendations

1. Adapters for music (ACE-Step 1.5), SFX and ambience (Stable Audio Open, if its licence fits), lip sync (LatentSync or MuseTalk), and an AI upscaler (Real-ESRGAN via spandrel), each benchmarked with this harness.
2. Real episode assembly with FFmpeg: concat with transitions and titles, loudnorm, sidechain ducking and a limiter, H.264/AAC 1080p masters validated by `FfprobeMediaProbe`.
3. Voice-reference cloning for Chatterbox, with consent recorded on the voice profile.
