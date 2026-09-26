# Windows setup program (`AI-Story-Studio-Setup-1.1.0.exe`)

A single `.exe` that carries the whole app. It is the easiest way to install AI Story Studio on Windows.

## Install

1. Double-click **`AI-Story-Studio-Setup-1.1.0.exe`**.
2. Windows may show **"Windows protected your PC"**, because the program is not code-signed (a certificate costs money). Click **More info → Run anyway**. Some antivirus programs are also suspicious of new unsigned programs; allow it if you downloaded it yourself from your own GitHub repository.
3. A black window opens. Press **Enter** to install into `C:\Users\<you>\AI-Story-Studio`, or type another folder.
   - The folder must be empty, new, or an earlier AI Story Studio installation. The setup refuses any other folder, so it can never overwrite unrelated files.
4. The setup copies the app, then runs the installer script. That script:
   - checks Node.js, Python and FFmpeg, and installs them with WinGet **only** if they are missing;
   - installs the app's dependencies and builds the app;
   - creates a safe `.env` (MOCK mode, cloud GPU off);
   - creates the **AI Story Studio** desktop shortcut.

   It takes about 5–15 minutes and needs an internet connection. It never installs CUDA or NVIDIA drivers.

5. Answer **Y** to start AI Story Studio. It opens in your browser at http://127.0.0.1:3000/, and the banner reads **MODE: MOCK**.

No administrator rights are needed. The only exception is a WinGet install of a missing prerequisite, which may show its own Windows prompt.

## Use it

- **Starting:** use the **AI Story Studio** shortcut on your desktop. Keep its black window open while you work; closing that window stops the app.
- **Cloud GPU:** to switch on real generation, follow [RUNPOD_SETUP.md](RUNPOD_SETUP.md).

## Upgrade

Run a newer setup `.exe` and choose the same folder:

- the app files are replaced, and files that the new version no longer ships are removed;
- your `.env`, your `data` folder (projects, database, saved API key), `node_modules` and the worker's Python environment are never changed by the copy step.

Close AI Story Studio before upgrading.

## Options (for automated installs)

```
AI-Story-Studio-Setup-1.1.0.exe -dir "D:\Apps\AI-Story-Studio" -yes -no-start
```

| Option          | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `-dir`          | Installation folder                                                                     |
| `-yes`          | Ask no questions (unattended)                                                           |
| `-no-start`     | Do not offer to start the app at the end                                                |
| `-no-shortcut`  | No desktop shortcut                                                                     |
| `-extract-only` | Only copy the files; run `installer\windows\Install-AI-Story-Studio.bat` yourself later |
| `-version`      | Print the version                                                                       |

## If it fails

The setup stops and shows what went wrong. The full log is in `installer\windows\install.log` inside the installation folder. Most problems are covered in [TROUBLESHOOTING_WINDOWS.md](TROUBLESHOOTING_WINDOWS.md), for example Node.js MSI error 1603, the Python Store alias and FFmpeg. After fixing the problem, run the setup again: it is safe to run as often as needed.

## Building the `.exe` yourself

- **Where the code is:** the setup program is a small Go program in `installer/windows/setup/`. It uses only Go's standard library, and the app is embedded in it.
- **Building it:** `installer/windows/build-setup.sh` cross-compiles it on Linux, macOS or Windows (Git Bash) with Go 1.24 or newer. The embedded app is taken from the **committed** sources (`git archive`), so `.env`, `data/`, `node_modules`, logs and other local files can never end up in the `.exe`.
- **Building on GitHub:** the GitHub Actions workflow **AI Story Studio Windows setup** builds the `.exe` on a Windows machine. It then tests it by installing, starting the app in MOCK mode, and upgrading. Download the `.exe` from the run's **Artifacts**.
