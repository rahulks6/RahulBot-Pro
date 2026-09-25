# Troubleshooting on Windows

## Installing

The installer is `installer\windows\Install-AI-Story-Studio.bat`. `Check-Prerequisites.bat` checks without installing. The log is written to `installer\windows\install.log`.

| Problem                                                     | What to do                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WinGet: Node.js install failed, MSI error 1603**          | The installer first checks whether a usable Node.js (≥ 22.18) is already there, and only installs when needed. If WinGet fails: restart Windows, remove any older Node.js in **Settings → Apps**, then download the **LTS .msi** from https://nodejs.org, right-click → **Run as administrator**. Open a **new** window and run the installer again. |
| "Node.js was not found" right after installing it           | Windows only updates PATH for new windows. Close the window and run the installer again (it also reloads PATH itself).                                                                                                                                                                                                                               |
| Python found but "not usable", or the Microsoft Store opens | That is the Store alias, not real Python. Install Python 3.11 from https://www.python.org/downloads/windows/ and tick **Add python.exe to PATH**, or turn off **App execution aliases** for python in Windows Settings.                                                                                                                              |
| FFmpeg missing                                              | `winget install Gyan.FFmpeg`, or download "release essentials" from https://www.gyan.dev/ffmpeg/builds/, unzip it, and set `FFMPEG_PATH=C:\path\to\ffmpeg.exe` and `FFPROBE_PATH=...\ffprobe.exe` in `.env`.                                                                                                                                         |
| "running scripts is disabled on this system"                | Use the `.bat` files: they run the script with `-ExecutionPolicy Bypass` for that run only.                                                                                                                                                                                                                                                          |
| SmartScreen or antivirus blocks the `.bat`                  | Choose **More info → Run anyway**, or right-click → Properties → **Unblock**.                                                                                                                                                                                                                                                                        |

This PC does **not** need an NVIDIA GPU, CUDA or NVIDIA drivers; the installer never installs them.

## Starting

| Problem                               | What to do                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Browser shows "can't reach this page" | Wait a few seconds and reload. Keep the black window open: closing it stops the app.         |
| "EADDRINUSE" / port 3000 in use       | Another program uses port 3000. Set `PORT=3010` in `.env`, then open http://127.0.0.1:3010/. |
| "The app is not built yet"            | Run the installer again.                                                                     |

## Cloud GPU messages

| Message                                                                            | Meaning and fix                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RunPod authentication failed. Check your API key.                                  | Key mistyped, revoked, or read-only. Create a new read/write key.                                                                                       |
| No compatible GPU is currently available below your configured hourly price.       | Raise **Maximum hourly GPU price**, allow Community Cloud, or try later.                                                                                |
| Cloud worker did not become healthy within 8 minutes. The GPU has been terminated… | The worker image could not start: run diagnostics, check that the image is **public** and the name is right. The first start may need a longer timeout. |
| Generation stopped because your session budget was reached.                        | Raise the session budget, or generate fewer shots per batch.                                                                                            |
| This batch is estimated at ₹X, above your session budget…                          | Same; nothing was rented.                                                                                                                               |
| Asset download failed validation… The corrupted file was discarded.                | A transfer broke 3 times. Try again; if it persists, check your internet connection.                                                                    |
| RunPod's API no longer matches what AI Story Studio expects… Nothing was created.  | RunPod changed its API. Update AI Story Studio.                                                                                                         |
| RunPod is rate-limiting requests / temporarily unavailable                         | Retried automatically; wait a few minutes.                                                                                                              |
| A cloud GPU is already running (limit 1).                                          | Wait for it to finish, or press **Stop GPU**.                                                                                                           |
| No music model is enabled for cloud generation…                                    | Acknowledge the Stable Audio Open licence under **Models (cloud)**, or remove the scene's music mood.                                                   |

**Worried a GPU is still running?** Press **EMERGENCY STOP GPU** (top of every page), then check the RunPod console → **Pods**.

## Logs

Use **Logs** in the menu, or **Open Logs folder** (`data\logs\studio.log`). Keys and tokens are never written to it.
