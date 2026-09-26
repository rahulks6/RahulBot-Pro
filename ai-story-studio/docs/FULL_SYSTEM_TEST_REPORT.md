# AI Story Studio v1.1.1 — full system test report

Date: 2026-09-26.

- **Environment:** Linux test container (Node 22.22, Python 3.11, FFmpeg static build, Chromium) and GitHub Actions `windows-latest` (Node 24, Python 3.11, FFmpeg via Chocolatey, Microsoft Edge).
- **Data:** every test uses a temporary data folder. None touched your database or `C:\Users\Shadow\AI-Story-Studio\data`.
- **Mode:** mock only (`MOCK_GENERATION=true`, `ENABLE_CLOUD_GPU=false`). No RunPod request was made and **no paid GPU was used**.

## Totals

| Suite                                                                      | Result                                        | Command                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| App (Node test runner), FFmpeg available                                   | **213 / 213 pass**, 0 skipped                 | `FFMPEG_PATH=… FFPROBE_PATH=… npm run check` (lint, typecheck, test, build)         |
| Worker (pytest), FFmpeg on PATH                                            | **85 / 85 pass**, 0 skipped                   | `npm run check:worker` (ruff, ruff format, mypy --strict, pytest); pyright 0 errors |
| Setup program (Go)                                                         | **9 / 9 pass**                                | `go test ./...` in `installer/windows/setup`                                        |
| Browser smoke, Chromium (local)                                            | **30 / 30**, then **20 / 20** after a restart | `node test/e2e/browser-smoke.mjs` (+ `--verify-only`)                               |
| Browser smoke, Microsoft Edge on Windows (installed with the setup `.exe`) | **30 / 30**, then **20 / 20** after a restart | GitHub Actions "AI Story Studio Windows setup"                                      |

Without FFmpeg, the FFmpeg-dependent tests report a skip with the reason; they never pass silently.

## App tests by file

| File                         |   Tests | What it proves                                                                                                             |
| ---------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------- |
| add-story-regression.test.ts |       6 | Add Story via the real form; `/stories` + project page; restart; validation; stale form                                    |
| milo-workflow.test.ts        |      12 | The whole Milo episode through the web UI, BUILD FINAL checked with ffprobe, backup/restore, restart                       |
| crud-routes.test.ts          |      12 | Create/edit/delete for projects, stories, scenes, shots, characters, locations, props, styles; settings; key masking; logs |
| startup.test.ts              |       1 | Two real server processes: the second refuses, the first is untouched                                                      |
| storage-paths.test.ts        |       4 | The four storage paths; media on the "second drive"; missing drive stops with a clear message                              |
| runpod-errors.test.ts        |       8 | 400 / 401 / 403 / 404 / 409 / 429 / 5xx / timeout / malformed → safe, specific messages                                    |
| runpod-catalog.test.ts       |      18 | GPU discovery per RunPod's published catalog contract; filtering by VRAM, price, stock                                     |
| runpod.test.ts               |      14 | Pod create/read/delete request shapes against the published schema                                                         |
| cloud-lifecycle.test.ts      |      26 | Every gate; hourly price; session budget; idle; lifetime; one GPU; emergency stop; recovery; dry run                       |
| gpu-budget.test.ts           |      15 | Daily/monthly budgets; price ceiling; idle/lifetime; kill switch; paid providers refused in mock mode                      |
| cloud-web.test.ts            |       5 | Mode banner on every page; API key masked and not logged; dry run rents nothing; guided test confirmation                  |
| security-web.test.ts         |      13 | CSRF + same origin; security headers; escaping; body limit; path traversal; secrets never logged                           |
| image-check.test.ts          |       7 | Worker image check: public / needs authentication / does not exist / registry unreachable                                  |
| backup.test.ts               |       3 | Full and metadata backups restore; tampered backups rejected without writing                                               |
| projects-stories.test.ts     |       7 | Repository-level CRUD and ordering                                                                                         |
| generation.test.ts           |       9 | Queue, retries, mock-only enforcement                                                                                      |
| assembly.test.ts             |       7 | FFmpeg assembly (real encode)                                                                                              |
| audio-timeline.test.ts       |       9 | Mixing, ducking, loudness                                                                                                  |
| quality.test.ts              |      12 | Quality reports and review gate                                                                                            |
| locks-prompts.test.ts        |       8 | Character/location/prop locks; prompt building                                                                             |
| story-package.test.ts        |       5 | Story Package import and validation                                                                                        |
| voice-reference.test.ts      |       3 | Voice reference needs recorded consent; revoke                                                                             |
| benchmarks.test.ts           |       3 | Benchmarks need a worker; real models need mock off                                                                        |
| worker.test.ts               |       5 | App ↔ real Python worker process (mock models)                                                                             |
| demo.test.ts                 |       1 | Demo seed end to end                                                                                                       |
| **Total**                    | **213** |                                                                                                                            |

## Milo mock end-to-end (exact fixtures)

- Project "Milo Test Episode" (series "Milo Adventures", 16:9, 30 fps → 1920×1080).
- Story "Milo and the Glowing Star".
- Style "Warm 3D Kids Adventure", made the project default.
- Character Milo (Main character, with your description and visual description).
- Locations "Milo's House" and "Magical Forest". Prop "Glowing Star".
- The 3 scenes with your text, one shot each, with Milo and the star cast.
- Narration per scene.

Every step was done through the pages' real forms:

| Step                      | Result                                                                        |
| ------------------------- | ----------------------------------------------------------------------------- |
| Prompts                   | Built prompts contain Milo, the star, the forest and the 3D style             |
| Mock images → approve     | 3 generated, 3 approved on the shot pages                                     |
| Mock clips → approve      | 3 generated, 3 approved                                                       |
| Narration without a voice | Refused with guidance (B2), then a narrator voice was created and chosen      |
| Mock narration TTS        | Queued and run; no failed jobs                                                |
| Assets                    | All `is_mock = 1`, labelled MOCK; `/media` streams; traversal blocked         |
| Editor                    | Timeline built from the approved assets                                       |
| Quality check             | Reports stored; mock output is named as mock                                  |
| BUILD FINAL (FFmpeg)      | Export complete; **ffprobe: H.264, 1920×1080, 30/1 fps, AAC, duration > 3 s** |
| Backup / restore          | Metadata and full backups restore into a **separate** studio                  |
| Restart                   | Everything still present                                                      |
| Cloud                     | No cloud GPU record; no provider contacted                                    |

**The output is placeholder MOCK media**, not AI-generated images, video or speech. Images are coloured shapes; clips are manifests that reuse the still image; narration is a tone pattern. It proves the pipeline, not the models.

## Not tested (and why)

| Item                             | Status          | Reason                                                                                                       |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| Live RunPod GPU discovery        | NOT VERIFIED    | Needs your API key; this container cannot reach api.runpod.io. The code follows RunPod's published contract. |
| Worker image pull by RunPod      | NOT VERIFIED    | Image not yet published to GHCR (anonymous check: REQUIRES AUTHENTICATION)                                   |
| Real GPU, real image, video, TTS | NOT TESTED      | Needs a paid GPU; forbidden in this task                                                                     |
| Your Windows PC                  | NOT TESTED here | Covered by the Windows CI run of the same `.exe`; your own install is the final check                        |
