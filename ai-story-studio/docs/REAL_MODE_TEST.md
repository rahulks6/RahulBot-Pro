# Real Mode Test — milestone 1

The first thing to prove is the whole chain on a **real RunPod GPU**:

```
RUNPOD CONNECTED → REAL GPU PROVISIONED → REAL WORKER HEALTHY → CUDA → REAL IMAGE →
REAL IMAGE ANIMATED → REAL NARRATION → GPU TERMINATED → AUDIO + VIDEO COMBINED →
SHORT MP4 VALIDATED → PLAYS
```

AI Story Studio has this as one button, so nothing has to be typed into a Command Prompt.

## Before you start

1. RunPod account with a little credit, and an API key (see [RUNPOD_SETUP.md](RUNPOD_SETUP.md), steps 1–2).
2. The AI worker image published once and set to **public** ([RUNPOD_SETUP.md](RUNPOD_SETUP.md), step 3).
3. In the app: **Settings → AI Engine** → paste the key → **TEST CONNECTION** → **SAVE**. The page must
   say **RUNPOD CONNECTED ✓** and the AI Engine must be **READY ✓**. The engine only says READY when
   RunPod also confirms it can download the AI worker.

## Run it

1. **Settings → AI Engine → RUN REAL MODE TEST.**
2. Steps 1–3 run immediately and are free: key check, AI worker check, and the GPU choice with its
   price and an estimate. **Nothing is rented yet.**
3. Press **CONFIRM AND RUN**. The page refreshes by itself. The first run takes longer because the GPU
   downloads the AI models (roughly 10–20 minutes the first time, a few minutes after that when a
   RunPod network volume is used).
4. At the end the page shows the MP4 in a player, with a download link.

The GPU is terminated as soon as the GPU part is finished, and also on any failure or when you press
Cancel. Combining, checking and playing happen on your PC with FFmpeg.

## What each step proves

| #   | Step                          | PASS means                                                                                                                                          |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | RunPod API connected          | RunPod accepted the key; the RunPod API still matches what the app expects.                                                                         |
| 2   | AI worker available to RunPod | RunPod can download the worker image without a password.                                                                                            |
| 3   | GPU chosen and price shown    | A compatible GPU is in stock, chosen by VRAM, past success, stock and speed (price only breaks ties), within your limits.                           |
| 4   | Your confirmation             | You pressed CONFIRM AND RUN.                                                                                                                        |
| 5   | Real GPU provisioned          | A pod was created. If a GPU type has no capacity, the next compatible type is tried and the step says so.                                           |
| 6   | Real worker healthy           | The AI worker on the pod answers with its secret session token.                                                                                     |
| 7   | CUDA verified                 | The worker sees the NVIDIA GPU **and** PyTorch can use CUDA (GPU name, VRAM, CUDA and PyTorch versions are shown).                                  |
| 8   | Real image generated          | A real image model returned a valid PNG/JPEG.                                                                                                       |
| 9   | Real image animated           | The real image-to-video model animated **that image** into an MP4. A clip made by the worker's still-image camera move (not AI) is a **FAIL** here. |
| 10  | Real narration generated      | A real text-to-speech model returned decodable speech.                                                                                              |
| 11  | GPU terminated                | RunPod confirmed the pod is gone (billing stopped).                                                                                                 |
| 12  | Audio + video combined        | FFmpeg made one MP4 from the clip (looped if needed) and the narration.                                                                             |
| 13  | Short MP4 validated           | ffprobe: H.264 video, AAC audio, 1920×1080, 30 fps, correct length.                                                                                 |
| 14  | MP4 plays                     | FFmpeg decodes the whole file without errors, the animated clip actually moves (not a frozen picture), and it is not mostly black.                  |

The result words are only **PASS**, **FAIL**, **BLOCKED** (something only you can fix, e.g. no key or
worker image not published) and **NOT TESTED** (the step was never reached). Nothing is ever shown as
PASS without having run.

## Where the result is kept

- The page: Settings → AI Engine → Real Mode Test → details.
- The MP4 and the image: `data/storage/real-tests/<test id>/`.
- The log: `data/logs/studio.log` (lines "real mode test step"). Keys and tokens are never logged.

## Status of milestone 1 today

| Environment                                                                     | Result                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development container (no GPU; RunPod, Hugging Face and PyPI are blocked there) | **BLOCKED** — cannot reach RunPod.                                                                                                                          |
| Automated test with a mock RunPod and a fake worker returning FFmpeg-made media | The test **harness** passes (every step executes; combine, validate, decode and the frozen/still-motion checks are real). This is **not** a real-AI result. |
| Your PC with your RunPod key                                                    | **NOT TESTED** until you press RUN REAL MODE TEST.                                                                                                          |

After you run it, the step table is the real answer. If a step fails, its message says what to do.
