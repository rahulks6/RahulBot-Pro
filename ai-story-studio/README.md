# AI Story Studio

A private, local-first production studio for **original** story videos. It takes an idea to a Story Package, then through review, generation, shot review, BUILD FINAL and quality checks to a ready-to-upload 1080p video. It is built for our own production, not as SaaS, and human review stays in the loop.

> **Phase 3: local foundation, local Python AI worker, real open-source model adapters and a benchmark workflow.** By default (`MOCK_GENERATION=true`) every image, clip and sound is a clearly labelled placeholder and nothing costs money. Real models run only on your own GPU through the local worker, after the licence gate; cloud GPUs stay disabled. See [docs/BENCHMARKING.md](docs/BENCHMARKING.md).

This app is self-contained in `ai-story-studio/` and does not touch the trading-bot code in the rest of the repository.

## Quick start

Requirements: **Node.js ≥ 22.18**. The app uses Node's built-in SQLite and runs TypeScript natively, and it has no runtime npm dependencies.

```bash
cd ai-story-studio
cp .env.example .env        # optional; the defaults are safe (mock mode, localhost only)
npm install                 # dev tools only: typescript, eslint, prettier, @types/node
npm run seed                # build the demo project end to end in mock mode
npm run dev                 # http://127.0.0.1:3000
```

| Script                 | What it does                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`          | Run from TypeScript sources with auto-restart                                         |
| `npm run build`        | Compile to `dist/`                                                                    |
| `npm start`            | Run the compiled build                                                                |
| `npm run migrate`      | Apply database migrations (they also run automatically on start)                      |
| `npm run seed`         | Create the demo project (mock mode only)                                              |
| `npm test`             | 88 tests (Node test runner; includes a real worker integration run)                   |
| `npm run worker`       | Start the local Python AI worker (Phase 2) — see [worker/README.md](worker/README.md) |
| `npm run check:worker` | Worker: ruff, mypy --strict, pytest (53 tests)                                        |
| `npm run lint`         | ESLint + Prettier check                                                               |
| `npm run typecheck`    | `tsc` strict type checking                                                            |
| `npm run check`        | lint, typecheck, test and build, in that order                                        |

Data (SQLite database, media, logs) goes to `DATA_DIR`, which defaults to `./data` and is git-ignored.

## What Phase 1 includes

- Dashboard, Projects, Stories, Characters, Locations, Props, Styles, Assets, Generation Queue, Editor, Quality Check, Exports, GPU & Costs and Settings pages.
- Character, Location, Prop and Voice Locks. Character variants and reference sheets (views, expressions, poses).
- Scenes and shots with ordering, dialogue, narration, SFX cues, camera, lighting and lip-sync flags.
- **Story Package** JSON import with full validation and atomic import. See [docs/STORY_PACKAGE.md](docs/STORY_PACKAGE.md).
- **Prompt Builder**, which shows where each part of the prompt came from and never overwrites manually locked prompts.
- Image-first **mock generation** through a batched generation queue, with the mock GPU safety supervisor, immutable generation history, approve/reject/regenerate, retries and failure injection.
- Mock AI audio: voices, narration, music, SFX and ambience, with audio caching, an automatic timeline, ducking, a mixer and solo previews.
- **BUILD FINAL**, which produces a mock master manifest plus a real WAV mix and runs full export validation.
- Quality Check: story, visual and audio checks, a content similarity report, the YouTube Quality Check with disclaimer, and the human review checklist.
- Simulated cost tracking, budget warnings and blocking (₹200/day and ₹1,500/month by default), GPU settings, the watchdog and the emergency kill switch.
- Project backup and restore, either metadata-only or with full media.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, and [docs/PHASE1_REPORT.md](docs/PHASE1_REPORT.md) [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md) and [docs/PHASE3_REPORT.md](docs/PHASE3_REPORT.md) for the completion reports.

## Mocked vs real

| Component                              | Phase 1                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images, references                     | Mock PNG placeholders                                                                                                                             |
| Video clips, lip sync, video upscaling | Mock JSON manifests (the UI shows the source still with a simulated camera move)                                                                  |
| TTS, music, SFX, ambience              | Mock synthesized WAV tones and noise, which are real audio files                                                                                  |
| Audio mix                              | Real mixing in TypeScript (ducking, fades, loops, normalisation, peak protection) → WAV                                                           |
| Final MP4 encode                       | **Not yet.** A mock master manifest stands in; FFmpeg encoding arrives in Phase 4                                                                 |
| GPU provisioning, costs                | Simulated by `MockGPUProvider`; costs are labelled "simulated"                                                                                    |
| Python AI worker, Docker               | **Phase 2 — built** (`worker/`): auth, jobs, cancellation, diagnostics, mock models; renders real H.264 MP4 placeholders when FFmpeg is installed |
