# AI Story Studio v1.1.1 — release readiness

**Overall: READY for mock-mode production work on Windows. NOT READY for real cloud generation** until the three steps at the end are done by you. Nothing in this release enables paid generation. The defaults stay `MOCK_GENERATION=true` and `ENABLE_CLOUD_GPU=false`.

| Subsystem                                      | Status              | Evidence / what is missing                                                                            |
| ---------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| Build (lint, typecheck, compile)               | READY               | `npm run check` exit 0                                                                                |
| Projects, Stories (incl. Add Story)            | READY               | Real forms, Chromium + Edge on Windows, restart persistence                                           |
| Characters, Locations, Props, Styles           | READY               | Create/edit/delete via real forms                                                                     |
| Scenes, shots, cast, prompts                   | READY               | Milo workflow + CRUD tests                                                                            |
| Generation queue (mock)                        | READY               | Image, clip and TTS jobs; retries; no failed jobs in the Milo run                                     |
| Mock image / video / audio pipelines           | READY (mock)        | Placeholder media only, clearly labelled MOCK                                                         |
| Assets, Editor, Quality check                  | READY               | Milo workflow                                                                                         |
| BUILD FINAL / Export (FFmpeg)                  | READY               | ffprobe-verified H.264/AAC 1920×1080 30 fps MP4                                                       |
| Backup / restore                               | READY               | Full and metadata backups restore into a separate studio; tampered files rejected                     |
| Settings                                       | READY               | All sections round-trip and survive restart; validation messages                                      |
| Logs                                           | READY               | Structured, with IDs; secrets redacted                                                                |
| Start-up / duplicate start / Windows installer | READY               | Setup `.exe` install + upgrade + Edge smoke in Windows CI; duplicate start refused safely             |
| Storage on a second drive                      | READY (optional)    | `.env` paths; missing drive stops with a clear message. Not yet used on your SSD                      |
| Cost-safety controls                           | READY (mock-tested) | Enforced on the server; every limit tested with a mocked provider. Never exercised against a real pod |
| RunPod authentication                          | READY               | You confirmed the key works; the app stores it server-side only                                       |
| RunPod GPU discovery                           | PARTIALLY READY     | Follows RunPod's published catalog contract; **not verified live** (needs your free dry run)          |
| Worker image (GHCR)                            | NOT READY           | Builds and passes `/health` in CI; **not published**, so RunPod cannot pull it yet                    |
| Real GPU / real image / real video / real TTS  | NOT READY           | Never run on a real GPU; needs the published image and a guided first GPU test                        |

## Open items

- **CRITICAL:** none.
- **HIGH:** none.
- **LOW:** A11 (a failed remote-job cancel is not reported; idle/lifetime limits still stop the GPU) and A12 (the setup `.exe` is unsigned).

## To go from mock to real (your steps, in order)

1. **Publish the worker image** ([RUNPOD_SETUP.md](RUNPOD_SETUP.md) step 3), then `npm run check:image` must say **IMAGE EXISTS AND PUBLICLY PULLABLE**.
2. **Cloud GPU → Run diagnostics (dry run).** This is free and rents nothing. GPU discovery must list GPUs within your ₹80/h ceiling.
3. **Guided first GPU test**, with your limits: ₹150 session budget, 10 min idle, 60 min lifetime, 1 GPU. This is the first step that costs money, and it asks for explicit confirmation.
