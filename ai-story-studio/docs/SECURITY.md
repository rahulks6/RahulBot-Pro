# Security (Phase 5 review)

A private, single-user desktop tool. The main risks are leaking the cloud API key, someone else using the rented GPU, and money being spent unintentionally.

## Secrets

| Secret                        | Where it lives                                                                                                                                 | Never                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| RunPod API key                | `DATA_DIR/secrets.json` (written atomically, `chmod 600`; the installer restricts `data\` to your Windows user), or `RUNPOD_API_KEY` in `.env` | sent to the browser (pages show `••••••••abcd` only), logged, sent to the GPU, committed |
| Per-session worker token      | Random 256-bit value (`aisw_…`), pod environment + local secret store (for crash recovery); forgotten at termination                           | reused across sessions, baked into the image, logged                                     |
| Hugging Face token (optional) | `.env` → pod environment                                                                                                                       | logged                                                                                   |

The logger redacts secret-looking keys and values (`rpa_…`, `hf_…`, `aisw_…`, `Bearer …`, `apiKey`, `token` fields) before writing. Tests assert that the key never appears in the page, the log file or the Logs page. `.env`, `data/` and `secrets.json` are git-ignored and excluded from the release zip.

## Cloud worker exposure

- The worker listens on port 8765 inside the pod and is reached through RunPod's HTTPS proxy.
- Every endpoint except `/health` (status and version only) requires the session bearer token, compared in constant time.
- Paths are confined to the job directory; uploads are size-limited; FFmpeg and lip-sync commands are argument lists with no shell.
- The pod guard uses only RunPod's pod-scoped credentials to terminate its own pod.

## Web app

The app binds to `127.0.0.1`; every POST requires a CSRF token and the same origin; the CSP is strict; templates escape everything; media paths are validated against traversal. New pages (Cloud GPU, GPU test, Logs) follow the same rules. The licence links only render `https://` URLs. **Open Logs folder** runs a fixed program with a fixed path argument, no shell.

## Command and prompt injection

Prompts never reach a shell. FFmpeg and ffprobe run as argument arrays via `execFile`. The worker's command lip-sync adapter substitutes only job-directory file paths into an operator-defined argument list. The RunPod API receives JSON bodies built from typed fields.

## Money-related safety

See [CLOUD_GPU_SETUP.md](CLOUD_GPU_SETUP.md#cost-protection). In brief:

- six gates before real generation;
- `.env` hard caps;
- price, session-budget, idle, lifetime and concurrency limits;
- termination in `finally`;
- watchdog and start-up recovery;
- ownership naming;
- emergency stop;
- the pod-side guard;
- no create retries after an ambiguous failure.

## Residual risks and assumptions

- **RunPod API v2 details** were confirmed from search results, because the documentation was blocked in the build environment. They are checked at runtime against RunPod's `openapi.json`, but no live call has been made yet.
- **Pod guard:** it assumes RunPod injects `RUNPOD_POD_ID` / `RUNPOD_API_KEY` into pods and that this key may delete its own pod. Verify during the first live test; the app's own timers do not depend on it.
- **Reinstalling:** a fresh installation with a new data folder gets a new installation id, so pods left by the old installation are no longer recognised as "ours". Check the RunPod console after reinstalling.
- **Pod environment visibility:** anyone with access to your RunPod account can see pod environment variables, including the per-session worker token, while that pod exists.
- **Container runs as root.** This is RunPod's standard; the pod is single-tenant and short-lived.
