# AI Story Studio (v1.3.1)

A private, local-first studio for **original** animated science-fiction cartoon series in **English and
Hinglish**. You describe an idea (or let it plan the season); it writes the episode with the series
memory, draws and animates every shot with open-source AI models on a rented **RunPod** GPU, voices it in
English, localizes it into natural Roman-script Hinglish that reuses the SAME pictures and clips, and
builds both finals, Shorts, captions, thumbnails and YouTube metadata. You review and approve; it uploads
to your English and Hinglish channels. Your PC needs **no NVIDIA GPU**.

> **Release status: CODE COMPLETE — REAL-AI VALIDATION BLOCKED.** Everything is built and tested against
> local stand-ins (mock RunPod, a fake worker, mock Google, placeholder AI) with real FFmpeg. **No real
> RunPod GPU, real model output or real YouTube upload has been run by the developers**: their machine
> cannot reach RunPod, Hugging Face or Google, and your RunPod key exists only on your PC. The in-app
> **Real Mode Test** is the first real run. Current, executed status:
> [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) · [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Setup: the one path

1. **Install:** double-click **`AI-Story-Studio-Setup-1.3.1.exe`**
   ([docs/WINDOWS_SETUP_EXE.md](docs/WINDOWS_SETUP_EXE.md)). It checks Node.js ≥ 22.18 and FFmpeg
   (installs them with WinGet only if missing), downloads the app's packages and builds it **on your
   PC** (internet needed; it is not a fully self-contained installer), and creates the shortcuts.
2. **Open** AI Story Studio from the desktop or Start Menu.
3. **Settings → AI Engine → paste your RunPod API key → TEST CONNECTION → SAVE**
   ([docs/RUNPOD_SETUP.md](docs/RUNPOD_SETUP.md)). That is all the infrastructure: no Docker, GitHub,
   container registry, worker image, RunPod template, endpoint, pod id, SSH or terminal.
4. **Advanced Mode → Real Mode Test** once ([docs/REAL_MODE_TEST.md](docs/REAL_MODE_TEST.md)), then the
   character consistency test ([docs/CHARACTER_CONSISTENCY_TEST.md](docs/CHARACTER_CONSISTENCY_TEST.md))
   and the 20–30 s bilingual scene test.
5. **Generate:** SERIES → your series → **GENERATE EPISODE** ([docs/SERIES_SYSTEM.md](docs/SERIES_SYSTEM.md)),
   or CREATE for a single video. Publishing: [docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md).

**Real AI is the default.** If real generation cannot run or fails, the step fails and says why; nothing
is ever replaced by placeholder media. Placeholder ("developer test mode", `MOCK_GENERATION=true`) exists
only for the automated tests and is always labelled.

## Documentation

| Current guide                                                                                               | What it covers                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [RUNPOD_SETUP](docs/RUNPOD_SETUP.md)                                                                        | RunPod account, key, safety limits                     |
| [REAL_MODE_TEST](docs/REAL_MODE_TEST.md)                                                                    | The real vertical test and its 22 stages               |
| [CHARACTER_CONSISTENCY_TEST](docs/CHARACTER_CONSISTENCY_TEST.md)                                            | 12 shots of one character, contact sheet, your verdict |
| [MODEL_SETUP](docs/MODEL_SETUP.md)                                                                          | Configured models, licences, pinned libraries          |
| [SERIES_SYSTEM](docs/SERIES_SYSTEM.md)                                                                      | Series, bible, seasons, episodes, continuity, canon    |
| [LOCALIZATION](docs/LOCALIZATION.md) · [HINGLISH_STYLE_GUIDE](docs/HINGLISH_STYLE_GUIDE.md)                 | English master → Hinglish version                      |
| [YOUTUBE_SETUP](docs/YOUTUBE_SETUP.md)                                                                      | Two channels, private test, approval, scheduling       |
| [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md)                                         | Design and secrets                                     |
| [WINDOWS_SETUP_EXE](docs/WINDOWS_SETUP_EXE.md) · [TROUBLESHOOTING_WINDOWS](docs/TROUBLESHOOTING_WINDOWS.md) | Installer                                              |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) · [TEST_REPORT](docs/TEST_REPORT.md)                 | What was executed, and what is BLOCKED                 |

Earlier reports (Phase 1–5, v1.1, v1.2) are in [docs/history/](docs/history/) and are **not** current
setup instructions. [docs/ADVANCED_WORKER_IMAGE.md](docs/ADVANCED_WORKER_IMAGE.md) is an optional expert
path that normal users never need.

## For developers

Requirements: **Node.js ≥ 22.18** (built-in SQLite, native TypeScript; no runtime npm dependencies) and
FFmpeg. The Python worker needs Python ≥ 3.11.

```bash
cd ai-story-studio
cp .env.example .env        # optional; real AI by default, localhost only (connect RunPod in the app)
npm install                 # dev tools only: typescript, eslint, prettier, @types/node
npm run dev                 # http://127.0.0.1:3000
```

| Script                 | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`          | Run from TypeScript sources with auto-restart                                              |
| `npm run build`        | Compile to `dist/`                                                                         |
| `npm start`            | Run the compiled build                                                                     |
| `npm run migrate`      | Apply database migrations (they also run automatically on start, after a backup)           |
| `npm test`             | The automated suite (stand-ins for RunPod, the worker, the models and Google; real FFmpeg) |
| `npm run check:worker` | Worker: ruff, mypy --strict, pytest                                                        |
| `npm run lint`         | ESLint + Prettier check                                                                    |
| `npm run typecheck`    | `tsc` strict type checking                                                                 |
| `npm run check`        | lint, typecheck, test and build, in that order                                             |
| `npm run seed`         | A demo project with labelled placeholders (developer test mode only)                       |

Data (SQLite database, media, logs) goes to `DATA_DIR` (default `./data`, git-ignored). Large files can go
to another drive with `GENERATED_ASSETS_PATH`, `TEMP_RENDER_PATH`, `DOWNLOAD_CACHE_PATH` and
`MODEL_CACHE_PATH` in `.env`; nothing is moved automatically, and the app refuses to start (naming the
setting) if such a drive is missing.

This app is self-contained in `ai-story-studio/` and does not touch the trading-bot code in the rest of
the repository.
