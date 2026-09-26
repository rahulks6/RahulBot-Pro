# AI Story Studio

A private, local-first studio for **original** animated story videos. You type an idea; it writes the story, designs the characters, draws and animates every shot with real open-source AI models on a rented **RunPod** GPU, records the voices, and builds a **1080p full episode** plus **9:16 Shorts**, captions, thumbnails and YouTube metadata. You review, then approve, and it uploads or schedules through the official YouTube API. Your PC needs **no NVIDIA GPU**.

> **v1.2.0 — idea → video → YouTube.** Simple Mode (Home, Create, My Videos, Characters, Publish, Settings), a first-run setup wizard, the AI Engine page (RunPod key stored encrypted), automatic story writing, the production orchestrator with automatic retries, Shorts drawn natively in 9:16, captions, thumbnails, YouTube publishing behind a human approval, one AI storage location, and an uninstaller. **Real AI is the default**; the mock providers remain only as the labelled developer test mode for automated tests.
>
> **Status (honest):** everything is implemented and tested against local stand-ins (mock RunPod, mock worker, mock Google). **No real RunPod GPU, real model or real YouTube upload has been run by the developers** (no key or GPU was available). The in-app **Real Mode Test** is the first real check. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

Setup guides: [RunPod](docs/RUNPOD_SETUP.md) · [Models](docs/MODEL_SETUP.md) · [YouTube](docs/YOUTUBE_SETUP.md) · [Real Mode Test](docs/REAL_MODE_TEST.md) · [Architecture](docs/ARCHITECTURE.md)

This app is self-contained in `ai-story-studio/` and does not touch the trading-bot code in the rest of the repository.

## Quick start

**Windows (easiest):** double-click **`AI-Story-Studio-Setup-1.2.0.exe`**. It copies the app to `%USERPROFILE%\AI-Story-Studio`, checks Node.js and FFmpeg (and the optional Python), installing only what is missing, builds the app, and creates the desktop and Start Menu shortcuts and the **Settings → Apps** entry (Uninstall keeps your data). The first start opens the setup wizard. Running it again upgrades the app and keeps your `.env` and `data` folder. See [docs/WINDOWS_SETUP_EXE.md](docs/WINDOWS_SETUP_EXE.md).

**Windows (from the zip):** run `installer\windows\Install-AI-Story-Studio.bat`, then start the app from the **AI Story Studio** desktop shortcut. See [docs/TROUBLESHOOTING_WINDOWS.md](docs/TROUBLESHOOTING_WINDOWS.md).

**Any OS, by hand.** Requirements: **Node.js ≥ 22.18**. The app uses Node's built-in SQLite and runs TypeScript natively, and it has no runtime npm dependencies.

```bash
cd ai-story-studio
cp .env.example .env        # optional; real AI by default, localhost only (connect RunPod in the app)
npm install                 # dev tools only: typescript, eslint, prettier, @types/node
MOCK_GENERATION=true npm run seed   # optional demo project with labelled placeholders (developer test mode)
npm run dev                 # http://127.0.0.1:3000
```

| Script                 | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run dev`          | Run from TypeScript sources with auto-restart                                                      |
| `npm run build`        | Compile to `dist/`                                                                                 |
| `npm start`            | Run the compiled build                                                                             |
| `npm run migrate`      | Apply database migrations (they also run automatically on start)                                   |
| `npm run seed`         | Create the demo project (mock mode only)                                                           |
| `npm test`             | 335 tests (Node test runner; mock RunPod, mock Google, fake cloud worker; real worker run; FFmpeg) |
| `npm run check:image`  | Can RunPod pull the worker image? (anonymous check; see docs/RUNPOD_SETUP.md step 3)               |
| `npm run worker`       | Start the local Python AI worker (Phase 2) — see [worker/README.md](worker/README.md)              |
| `npm run check:worker` | Worker: ruff, mypy --strict, pytest (123 tests)                                                    |
| `npm run lint`         | ESLint + Prettier check                                                                            |
| `npm run typecheck`    | `tsc` strict type checking                                                                         |
| `npm run check`        | lint, typecheck, test and build, in that order                                                     |

Data (SQLite database, media, logs) goes to `DATA_DIR`, which defaults to `./data` and is git-ignored.

**Heavy files on a second drive (optional).** The database, settings and logs stay in `DATA_DIR`. The large files can go elsewhere through `.env`:

- `GENERATED_ASSETS_PATH`: images, clips, audio, finished videos.
- `TEMP_RENDER_PATH`: BUILD FINAL work folders.
- `DOWNLOAD_CACHE_PATH`: cloud results while they are checked.
- `MODEL_CACHE_PATH`: model weights for the optional local worker.

Nothing is moved automatically. To move existing media:

1. Close the app.
2. Copy `data\storage` to the new folder, e.g. `D:\AI-Story-Studio-Data\storage`.
3. Add `GENERATED_ASSETS_PATH=D:\AI-Story-Studio-Data\storage` to `.env`.
4. Start the app and open a few assets.
5. Only then delete the old copy.

If the drive is not connected, the app refuses to start and names the setting, instead of silently writing to C:.

## What Phase 1 includes

- Dashboard, Projects, Stories, Characters, Locations, Props, Styles, Assets, Generation Queue, Editor, Quality Check, Exports, GPU & Costs and Settings pages.
- Character, Location, Prop and Voice Locks. Character variants and reference sheets (views, expressions, poses).
- Scenes and shots with ordering, dialogue, narration, SFX cues, camera, lighting and lip-sync flags.
- **Story Package** JSON import with full validation and atomic import. See [docs/STORY_PACKAGE.md](docs/STORY_PACKAGE.md).
- **Prompt Builder**, which shows where each part of the prompt came from and never overwrites manually locked prompts.
- Image-first **mock generation** through a batched generation queue, with the mock GPU safety supervisor, immutable generation history, approve/reject/regenerate, retries and failure injection.
- Mock AI audio: voices, narration, music, SFX and ambience, with audio caching, an automatic timeline, ducking, a mixer and solo previews.
- **BUILD FINAL**, which encodes a real MP4 master with FFmpeg (Phase 4; a mock master manifest when FFmpeg is missing) and runs full export validation.
- Quality Check: story, visual and audio checks, a content similarity report, the YouTube Quality Check with disclaimer, and the human review checklist.
- Simulated cost tracking, budget warnings and blocking (₹200/day and ₹1,500/month by default), GPU settings, the watchdog and the emergency kill switch.
- Project backup and restore, either metadata-only or with full media.

Cloud GPU (Phase 5): [CLOUD_GPU_SETUP](docs/CLOUD_GPU_SETUP.md) · [RUNPOD_SETUP](docs/RUNPOD_SETUP.md) · [MODEL_SETUP](docs/MODEL_SETUP.md) · [SECURITY](docs/SECURITY.md) · [TROUBLESHOOTING_WINDOWS](docs/TROUBLESHOOTING_WINDOWS.md) · [PHASE5_AUDIT](docs/PHASE5_AUDIT.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, and [docs/PHASE1_REPORT.md](docs/PHASE1_REPORT.md) [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md), [docs/PHASE3_REPORT.md](docs/PHASE3_REPORT.md) and [docs/PHASE4_REPORT.md](docs/PHASE4_REPORT.md) for the completion reports.

## Mocked vs real

| Component                              | Phase 1                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images, references                     | Mock PNG placeholders                                                                                                                                                                  |
| Video clips, lip sync, video upscaling | Mock JSON manifests (the UI shows the source still with a simulated camera move)                                                                                                       |
| TTS, music, SFX, ambience              | Mock synthesized WAV tones and noise, which are real audio files                                                                                                                       |
| Audio mix                              | Real mixing in TypeScript (ducking, fades, loops, normalisation, peak protection) → WAV                                                                                                |
| Final MP4 encode                       | **Phase 4 — real** with local FFmpeg: 1080p/1080×1920 H.264 + AAC 48 kHz, crossfades, titles, two-pass loudnorm to −14 LUFS, validated with ffprobe. Mock manifest only without FFmpeg |
| GPU provisioning, costs                | Mock mode: simulated by `MockGPUProvider`. **REAL CLOUD mode: RunPod (API v2) implemented and mock-tested; live validation pending**                                                   |
| Python AI worker, Docker               | **Phase 2 — built** (`worker/`): auth, jobs, cancellation, diagnostics, mock models; renders real H.264 MP4 placeholders when FFmpeg is installed                                      |
