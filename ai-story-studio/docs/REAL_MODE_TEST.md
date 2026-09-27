# Real Mode Test (v1.3.1)

The first thing to prove is the real production engine on a **real RunPod GPU**, with one ORIGINAL
character, in English **and** Hinglish, from ONE animated clip:

```
RUNPOD AUTH → GPU → CUDA (proven by the worker) → IMAGE (+ validation) → VIDEO (+ motion validation)
→ ENGLISH TTS → HINGLISH TTS → GPU TERMINATED → test_english.mp4 + test_hinglish.mp4 (same clip)
→ FFPROBE → PLAYBACK → your review of the picture, the motion and both voices
```

It is one button; nothing has to be typed into a terminal.

## Before you start

1. A RunPod account with a little credit and an API key ([RUNPOD_SETUP.md](RUNPOD_SETUP.md), steps 1–2).
2. In the app: **Settings → AI Engine** → paste the key → **TEST CONNECTION** → **SAVE**. The AI Engine
   must say **READY ✓**. Nothing else: no Docker, GitHub, worker image, template, endpoint or pod id.

## Run it

1. **Advanced Mode → Real Mode Test** (or Settings → AI Engine) → **RUN REAL MODE TEST**.
2. Steps 1–3 run immediately and are free: key check, base-image check, and the GPU choice with its
   price and an estimate. **Nothing is rented yet.**
3. Press **CONFIRM AND RUN**. The page refreshes by itself; each stage shows its status (no fake
   percentage). The first run takes longer: the GPU installs the pinned libraries (a few minutes) and
   downloads the models (roughly 10–20 minutes the first time; less with a RunPod network volume).
4. At the end the page shows the image, the animated clip, both voices and **test_english.mp4** /
   **test_hinglish.mp4** in players, with downloads.
5. **Your review:** watch and listen, then mark each of the four review steps PASS or FAIL. Only when
   every automated step AND your four reviews pass does the page say **REAL-AI VERIFIED**.

The GPU is terminated as soon as the GPU part is finished, and also on any failure, on a timeout and
when you press Cancel. Combining, checking and playing happen on your PC with FFmpeg.

## The stages and what PASS means

| #   | Stage                                 | PASS means                                                                                                                                                                                             |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | RunPod authentication                 | RunPod accepted the key (read-only call); the API still matches the published contract.                                                                                                                |
| 2   | AI worker available to RunPod         | RunPod can pull the pod's base image (`pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime`) anonymously.                                                                                                    |
| 3   | GPU chosen and price shown            | A compatible GPU is in stock within your limits; price, estimate and fallbacks shown.                                                                                                                  |
| 4   | Your confirmation                     | You pressed CONFIRM AND RUN.                                                                                                                                                                           |
| 5   | Real GPU provisioned                  | A pod was created, the worker code was uploaded (token + SHA-256), libraries installed, the worker started. If a GPU type fails, the next one is tried.                                                |
| 6   | Real worker healthy                   | The worker answers with the secret session token.                                                                                                                                                      |
| 7   | CUDA verified by the worker           | The worker itself reports the GPU, VRAM, CUDA and that **PyTorch can use CUDA**; it records every installed library version and, after generation, the exact model commits (files in the test folder). |
| 8   | Real image generated                  | The image model returned a PNG/JPEG of the original test character.                                                                                                                                    |
| 9   | Image validated                       | FFmpeg decodes it; at least 256×256 (asked for 1280×720); not black; not one flat colour.                                                                                                              |
| 10  | Real image animated                   | The image-to-video model animated **that image**. The worker's still-image camera move (not AI) is a **FAIL**.                                                                                         |
| 11  | Motion validated                      | The clip decodes cleanly, has frames, lasts ≥ 2 s, is **not frozen** for its whole length, and is not black.                                                                                           |
| 12  | Real English narration                | "The signal is coming from somewhere beyond the portal." spoken by the TTS model.                                                                                                                      |
| 13  | Real Hinglish narration               | "Signal portal ke doosri side se aa raha hai. Scanner activate karo!" — sent to the voice as `Signal portal के दूसरी side से आ रहा है. Scanner activate करो!` with the Hindi voice `hf_alpha`.         |
| 14  | GPU terminated                        | RunPod confirmed the pod is gone. Also checked when the start failed (the supervisor's own clean-up is reported).                                                                                      |
| 15  | English MP4 built                     | `test_english.mp4`: the clip under the English voice.                                                                                                                                                  |
| 16  | Hinglish MP4 built from the same clip | `test_hinglish.mp4`: the SAME clip under the Hinglish voice (no second visual generation).                                                                                                             |
| 17  | FFprobe (both)                        | H.264 video, AAC audio, 1920×1080, 30 fps, the expected duration — for both files.                                                                                                                     |
| 18  | Playback (both)                       | FFmpeg decodes both files end to end without errors.                                                                                                                                                   |
| 19  | Your review: the picture              | You looked: an original young explorer with the robot, clean 3D style, no broken faces or hands.                                                                                                       |
| 20  | Your review: the motion               | You watched: it really moves (turn, robot rises, scanner glow, push-in) without melting.                                                                                                               |
| 21  | Your review: English voice            | You listened: clear, natural, the right words.                                                                                                                                                         |
| 22  | Your review: Hinglish voice           | You listened: natural Hindi rhythm and pronunciation, English tech words sound English, no broken or robotic sounds. **If not, mark FAIL** — see "If Hinglish sounds wrong" below.                     |

Result words are only **PASS**, **FAIL**, **BLOCKED** (something only you can fix, e.g. no RunPod key or
no FFmpeg) and **NOT TESTED** (never reached, or cancelled by you). Nothing is shown as PASS without
having run.

## Also on the Real Mode Test page

- **Character consistency test** — see [CHARACTER_CONSISTENCY_TEST.md](CHARACTER_CONSISTENCY_TEST.md).
- **Bilingual scene test (20–30 s)** — two young explorers, an abandoned future lab, a robot that detects
  a signal, a portal that activates. Made by the normal production pipeline: story, several shots,
  dialogue, music, ambience, SFX; the pictures and clips are made ONCE and the English and Hinglish
  versions share them. It is kept in the project "Technical tests (not series canon)". Review it on its
  video page (both versions, the Hinglish lines and the QC findings).

## If Hinglish sounds wrong

Kokoro's Hindi voices read the Hindi words through its Hindi phonemizer (espeak-ng) and the English words
through its English one. If step 22 fails (broken phonemes, odd pauses, robotic words): note what is
wrong, keep the files (`test_hinglish_voice.wav`), and do not start the series yet. The TTS provider is
replaceable (the worker's TTS interface); a Hindi-capable alternative would be benchmarked on the same
line before switching. No change is made automatically.

## Where the result is kept

- The page: Advanced Mode → Real Mode Test → Earlier runs → details.
- Files: `data/storage/real-tests/<test id>/` — `test_image.png`, `test_clip.mp4`,
  `test_english_voice.wav`, `test_hinglish_voice.wav`, `test_english.mp4`, `test_hinglish.mp4`,
  `installed-packages.txt`, `model-revisions.txt`.
- The log: `data/logs/studio.log` (lines "real mode test step"). Keys and tokens are never logged.

## Status today (v1.3.1)

| Environment                                                                     | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development container (no GPU; RunPod, Hugging Face, PyPI and Google blocked)   | **BLOCKED** — every real stage. Verified again on 2026-09-27: the proxy rejects connections to RunPod, and no RunPod key exists there.                                                        |
| Automated test with a mock RunPod and a fake worker returning FFmpeg-made media | The **harness** passes: all 18 automated stages execute (validation, two MP4s, ffprobe, decode are real FFmpeg), plus failure, cancel and timeout clean-up. This is **not** a real-AI result. |
| Your PC with your RunPod key                                                    | **NOT TESTED** until you press RUN REAL MODE TEST and review the outputs.                                                                                                                     |
