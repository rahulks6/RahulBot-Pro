# AI Story Studio v1.1.1 — full application audit

Date: 2026-09-26. Scope: every navigation area, every create/update/delete route, the mock production pipeline, export, backup/restore, settings, cloud safety, logging, start-up and the Windows installer.

**How it was checked.** Findings come from the source code and from tests that drive the **real web routes and the real form markup**: `test/fixtures/web-driver.ts` reads each page's `<form>` elements and submits them as a browser without JavaScript would. There is also a real Chromium/Microsoft Edge run (`test/e2e/browser-smoke.mjs`) and real FFmpeg output checked with ffprobe. Every test uses a temporary data folder; none touched a user database. No RunPod call was made and no paid GPU was used.

Severity: **CRITICAL** = data loss, money spent without consent, or a core workflow broken. **HIGH** = a core workflow fails or misleads. **MEDIUM** = a real defect with a workaround. **LOW** = polish or documentation.

## Findings

| ID  | Severity | Area                    | Finding                                                                                                                                                                                                                                                                                                                                                                     | Status                                                |
| --- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A1  | HIGH     | Projects → Add Story    | Your manual test: Add Story, then Stories showed "Nothing here yet." **Not reproducible on this build** through the route, the real form, local Chromium or Windows Microsoft Edge (including across a restart). Most likely cause: the form was sent after the app restarted, so it was rejected with a terse error page and nothing was saved (see BUG_FIX_REPORT.md B1). | Fixed (hardened + explicit page + 6 regression tests) |
| A2  | HIGH     | Narration audio         | Narration TTS was queued even when the project had no narrator voice. The job could only fail later ("Project has no narrator voice"), which made BUILD FINAL fail vaguely.                                                                                                                                                                                                 | Fixed: refused at queue time with guidance            |
| A3  | HIGH     | Start-up                | A second copy (Start double-clicked twice) ran crash recovery **before** finding the port busy. That could requeue the running copy's in-flight jobs and, in cloud mode, terminate its GPU mid-job. It then crashed with a stack trace.                                                                                                                                     | Fixed: port claimed first, plain message              |
| A4  | HIGH     | Cloud cost safety       | A failure to stop a GPU during shutdown was swallowed silently, so a GPU could keep costing money unseen.                                                                                                                                                                                                                                                                   | Fixed: logged as an error + console WARNING           |
| A5  | MEDIUM   | Dialogue audio          | Dialogue audio was queued for a line with no speaking character, or a character without a voice, and failed later.                                                                                                                                                                                                                                                          | Fixed: refused at queue time with guidance            |
| A6  | MEDIUM   | GPU watchdog            | After a failed GPU start, the watchdog's clean-up error was swallowed.                                                                                                                                                                                                                                                                                                      | Fixed: logged                                         |
| A7  | MEDIUM   | Props                   | A prop's associated characters could not be changed after creation, and a character from **another project** could be attached (no check).                                                                                                                                                                                                                                  | Fixed + tests                                         |
| A8  | MEDIUM   | Storage                 | All heavy files had to live inside `data/` on C:. The paths could not be configured for a second drive.                                                                                                                                                                                                                                                                     | Fixed: 4 `.env` paths; missing drive = clear stop     |
| A9  | LOW      | Stale forms (all pages) | Any form sent after a restart showed "Invalid or missing CSRF token".                                                                                                                                                                                                                                                                                                       | Fixed: "Nothing was saved — reload" page              |
| A10 | LOW      | `.env.example`          | It said the local worker reads `.env`. It does not; its settings are environment variables of its own terminal.                                                                                                                                                                                                                                                             | Fixed (wording)                                       |
| A11 | LOW      | Worker client           | When you cancel a remote job, a failed cancel request to the worker is ignored. The GPU idle timeout and maximum lifetime still bound the cost.                                                                                                                                                                                                                             | Open (documented)                                     |
| A12 | LOW      | Installer               | The setup `.exe` is not code-signed, so SmartScreen asks "More info → Run anyway".                                                                                                                                                                                                                                                                                          | Open (needs a paid certificate)                       |

**No CRITICAL finding is open. No HIGH finding is open.**

## Navigation areas

Every area was loaded in a real browser (HTTP 200, not an error page, `MODE: MOCK` banner, no JavaScript errors), both locally and on Windows in Microsoft Edge.

| Area             | Create / edit / delete via the real forms                                                                                                                 | Result |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Dashboard        | read-only                                                                                                                                                 | OK     |
| Projects         | create, edit, blank-name validation, delete (cascades to stories/library; other projects untouched; `PRAGMA integrity_check` + `foreign_key_check` clean) | OK     |
| Stories          | add from the project page (exact notice), edit, delete; listed on /stories and the project page after refresh and restart                                 | OK     |
| Scenes / shots   | add 3 scenes, edit, move up, delete (positions compact); shot add/edit/delete                                                                             | OK     |
| Characters       | create, edit, duplicate name refused with a message, delete; voices create                                                                                | OK     |
| Locations        | create, edit, delete                                                                                                                                      | OK     |
| Props            | create with characters, change characters, clear characters, edit, delete; cross-project character refused                                                | OK     |
| Styles           | create, edit, delete; project default style                                                                                                               | OK     |
| Assets           | mock assets listed; `/media` serves with byte ranges; path traversal blocked                                                                              | OK     |
| Generation Queue | image, clip and TTS jobs queued and run; none failed; approve/reject on shot pages                                                                        | OK     |
| Editor           | timeline built from approved assets                                                                                                                       | OK     |
| Quality Check    | reports stored; mock output labelled as mock                                                                                                              | OK     |
| Exports          | BUILD FINAL with FFmpeg: ffprobe shows H.264 1920×1080 30/1 + AAC                                                                                         | OK     |
| GPU & Costs      | budget, price, idle, lifetime, 1-GPU limit, kill switch (mocked provider)                                                                                 | OK     |
| Model Benchmarks | needs a connected worker; real models need `MOCK_GENERATION=false`                                                                                        | OK     |
| Cloud GPU        | API key saved server-side, never shown/logged/stored in the DB; dry-run diagnostics; emergency stop                                                       | OK     |
| Settings         | all 6 sections save, show the saved value, survive a restart; invalid value refused with a message and nothing changed                                    | OK     |
| Logs             | JSON lines with `ts`, `level`, `msg` and IDs (`project`, `story`, …); keys redacted                                                                       | OK     |

## Other areas

- **Mock/real gates.** Nothing paid can run unless all of these hold: `MOCK_GENERATION=false`, `ENABLE_CLOUD_GPU=true`, an API key, cloud generation switched on and an explicit confirmation. Tests cover each gate on its own (`cloud-lifecycle.test.ts` "every gate is required", `gpu-budget.test.ts`). The mode banner is on every page.
- **Cost safety.** These are enforced on the server, in the GPU supervisor, not in the page, and each has a test with a mocked provider:
  - session budget and worst-case cost;
  - maximum hourly price;
  - idle timeout and maximum lifetime;
  - one GPU at a time;
  - emergency stop (only this installation's pods);
  - daily and monthly budgets.
- **Error matrix (RunPod).** 400, 401, 403, 404, 409, 429 (retried), 5xx (retried, HTML never echoed), timeout and malformed JSON each give a safe, specific message (`runpod-errors.test.ts`).
- **Swallowed errors.** Every `catch` in `src/` was reviewed. Two were silent on money-relevant paths (A4, A6) and are fixed. The rest either re-throw a clear message, report a "missing" item to the user, or are parse fallbacks. A11 is the one open low-risk case.
- **Database integrity.** SQLite with WAL, foreign keys ON, and transactions for multi-row writes. After the delete tests, `PRAGMA integrity_check` returns `ok` and `foreign_key_check` is empty. Restart persistence is tested three ways: Add Story, the Milo workflow and settings.
- **Security.**
  - The server binds to 127.0.0.1.
  - Every POST needs the CSRF token and a same-origin request.
  - Security headers are set; user content is escaped.
  - Request bodies are size-limited; media paths cannot escape storage.
  - Secrets are redacted in logs by key name and by value pattern; the API key lives only in `data/secrets.json`.
  - The kill switch needs a typed confirmation.
- **Start-up.**
  - A duplicate start is refused before anything changes (`startup.test.ts` spawns two real processes).
  - A missing storage drive gives a plain message.
  - `Start-AI-Story-Studio.bat`: if the app is already running, the browser opens the running copy and the new window explains why it stopped.
- **Worker image scripts.** Audited, not run: nothing was built or pushed in this task. They parse in Windows PowerShell 5.1 (CI), and the default image name matches the app. The anonymous check gives a definite registry verdict, and the build script refuses clearly without Linux containers.
- **Performance.** Every page is server-rendered with no client framework (each workflow step in the tests takes 10–130 ms). The whole mock Milo episode takes about 15 s in the test container, and the real FFmpeg 1080p encode in BUILD FINAL is about 14 s of that. Mock generation of all images, clips and narration takes about 0.5 s. The Logs page reads at most the last 400 KB of the log.
