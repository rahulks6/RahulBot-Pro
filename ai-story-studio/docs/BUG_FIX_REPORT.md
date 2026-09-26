# AI Story Studio v1.1.1 — bug fix report

Each entry gives the symptom, the cause, the fix and the test that now guards it. "Reproduced" means the failure was seen before the fix. Where it was not, the entry says so.

## B1 — Add Story: story missing from the Stories page (your manual test)

**Symptom (reported).** Projects → open "Milo Test Episode" → New story title "Milo and the Glowing Star" → **Add story** → the Stories page showed "Nothing here yet."

**Reproduction attempts.** The failure was **not reproduced** on the v1.1.0 code:

- **Real route and form.** The project page's actual `<form>` was submitted: the story was created under the project and the app went to the story page. It was listed on `/stories` and on the project page, and still there after a restart.
- **Real browsers.** Chromium (local) and **Microsoft Edge on Windows** (GitHub Actions `windows-latest`, installed with the setup `.exe`) both passed. Add story worked by clicking and by pressing Enter, and the story was still listed after reload and after an app restart.
- **Code paths.** No route redirects to `/stories` after Add story. The story page itself never shows "Nothing here yet."; only an empty `/stories` list does. The database layer is sound: foreign keys ON, WAL, synchronous transactions.

**Most likely cause.** Every server start creates a new random CSRF form token, and every setup `.exe` upgrade or Start restarts the server. A project page opened **before** a restart still carries the old token. Pressing Add story on it was rejected with a small page reading "Error — Invalid or missing CSRF token", and **nothing was saved**. Clicking **Stories** in the menu then showed the empty list, "Nothing here yet." This matches every observed detail, but it is an inference: your exact session could not be replayed.

**Fixes.**

1. **A form sent after a restart now explains itself.** It shows HTTP 403 and "Please reload the page — **Nothing was saved.** AI Story Studio was restarted after this page was opened…", with a **Reload the page** button back to the page it came from. The warning is logged (`form rejected: stale or missing CSRF token`, with the path).
2. **The Add Story route is hardened** (`POST /projects/:id/stories`):
   - "Project could not be found." when the project does not exist; no orphan row is written.
   - "Story title is required." when the title is blank or spaces.
   - "Story could not be saved: <reason>" when the database refuses; the error is logged with the project ID.
   - The story is **read back** before success is reported. Success is only shown for a story really stored under that project: notice "Story 'Milo and the Glowing Star' created.", landing on the story page.
   - `story created` is logged with the project and story IDs.

**Tests.**

- `test/add-story-regression.test.ts` (6 tests, file database in a temporary folder): create project → Add story → `/stories` → project page → restart → still listed; blank title; unknown project; stale form after a restart.
- `test/e2e/browser-smoke.mjs` (Chromium locally, Microsoft Edge in Windows CI): Add story by click and by Enter; `/stories` after reload and after restart.

## B2 — Narration audio queued without a narrator voice

**Reproduced** by the new Milo workflow test. The narration job was accepted and failed later in the queue ("Project has no narrator voice"), so BUILD FINAL then failed with a vague missing-audio reason.

**Fix.** It is refused at queue time: "Narration needs a narrator voice: create one under Characters → Voices (role: narrator), then choose it as "Narrator voice" in the project settings." The message is shared by the queue and the audio pipeline (`src/services/audio-messages.ts`).

**Test.** `milo-workflow.test.ts` step 6 checks the refusal, then creates the voice and succeeds.

## B3 — Dialogue audio queued without a speaker or voice

Same pattern as B2, for dialogue lines with no speaking character, or whose character has no voice. They are now refused with "This dialogue line has no speaking character. Choose one first." or "Character "X" has no voice yet. Create one under Characters → Voices and assign it to X."

## B4 — Second copy of the app could disturb the running one

**Reproduced by reading the code.** `server.ts` ran start-up crash recovery **before** it tried the port:

- **Jobs.** Recovery requeues jobs marked running, so a second copy could requeue the first copy's in-flight jobs.
- **Cloud GPU.** In cloud mode, recovery stops leftover pods, so it could stop the GPU the first copy was using.
- **Crash.** The second copy then crashed with an `EADDRINUSE` stack trace.

**Fix.**

- The port is claimed first. A second copy prints "AI Story Studio seems to be already running at http://127.0.0.1:3000/ — Open that address in your browser, or close the other AI Story Studio window first… Nothing was changed." and exits with code 1.
- Requests wait until recovery has finished.

**Test.** `test/startup.test.ts` starts two real server processes: the second exits 1 with the message, and the first keeps serving.

## B5 — GPU clean-up failures were silent

A failed GPU termination during shutdown (`shutdownCleanup().catch(() => 0)`) and in the watchdog after a failed start were swallowed. Both are money-relevant. They are now logged as errors, and shutdown prints "WARNING: could not confirm that every cloud GPU was stopped. Check the RunPod console → Pods."

## B6 — Props: characters could not be changed; cross-project links allowed

- **Characters.** The prop page now has the **Associated characters** list (current ones pre-selected), and saving replaces the links. Selecting none clears them.
- **Cross-project links.** A character from another project is refused ("A chosen character does not belong to this project") and nothing is written, on create and on edit.
- **Test.** `crud-routes.test.ts`.

## B7 — Heavy files could not leave C:

New optional `.env` settings: `GENERATED_ASSETS_PATH`, `TEMP_RENDER_PATH`, `DOWNLOAD_CACHE_PATH` and `MODEL_CACHE_PATH` (the last for the local worker). Unset keeps today's folders inside `data/`, and nothing is moved automatically. If a configured drive is not available, the app stops at start with "GENERATED_ASSETS_PATH=D:\… is not available (…). Connect that drive, or remove the line from .env…". It never falls back silently, which would split your media across two places.

**Tests.** `storage-paths.test.ts` (4) and the worker's `test_model_cache_location_is_configurable`.

## B8 — `.env.example` said the worker reads `.env`

It does not: the worker's settings are environment variables of the terminal that runs `npm run worker`. The wording is corrected.

## Not bugs (checked)

- **Stories page empty while a project has stories.** Not possible: `/stories` lists all stories across projects; tested.
- **Stories page after refresh.** Refreshing re-reads the database. No state is kept in the page or the browser.
