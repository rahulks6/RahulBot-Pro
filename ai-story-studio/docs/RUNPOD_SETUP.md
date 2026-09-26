# RunPod setup (step by step, for Windows)

This guide connects AI Story Studio to **RunPod**, a service that rents NVIDIA GPUs by the minute. Your PC does **not** need an NVIDIA graphics card, CUDA or PyTorch: the studio rents a GPU only while it generates, then shuts it down.

> **Money:** renting a GPU costs real money, typically about ₹20–₹60 per hour for the GPUs this app uses. The app has several independent safety limits (see step 8). **The strongest limit is the RunPod balance:** RunPod is prepaid, so it can never spend more than the credit you add.

You need about 30 minutes the first time.

---

## Step 1: Create a RunPod account and add a small credit

1. Go to **https://www.runpod.io** and sign up.
2. In the RunPod console, open **Billing** and add a small amount of credit, for example **US$10**. Start small; you can add more later.

## Step 2: Create an API key

1. In the RunPod console, open **Settings → API Keys** (the menu names may differ slightly).
2. Click **Create API Key**. Give it a name such as `AI Story Studio`.
3. Give it permission to **read and write** (the studio must be able to create and delete GPUs).
4. **Copy the key** (it starts with `rpa_`). Keep it private, like a password. You paste it into the app in step 5; you never need to put it in a file.

## Step 3: Publish the AI worker image (once)

The rented GPU runs the "AI worker" from a **container image**. RunPod downloads that image when the GPU starts, so it must be published where RunPod can read it **without a password**: GitHub Container Registry (`ghcr.io`), with the package set to **public**. The image holds program code only: **no model weights** (they download on the GPU the first time) and **no secrets**.

The image name must be exactly:

```
ghcr.io/rahulks6/ai-story-studio-worker:1.2.0
```

This is the app's default (**Cloud GPU → Advanced → Worker image**). If your GitHub user name is not `rahulks6`, replace it everywhere below, in lower case, and change the setting too.

Until this step is done, the dry run shows **Worker image: IMAGE REQUIRES AUTHENTICATION**, and the app refuses to rent any GPU. That is intended.

Choose **one** way to build and push the image: **A** or **B**. Then do **Make it public** and **Verify**.

### Option A: let GitHub build it (no Docker needed)

1. On **github.com**, open your repository → **Releases** → **Draft a new release**.
2. Click **Choose a tag**, type `ai-story-studio-worker-v1.2.0`, and click **Create new tag … on publish**.
3. Set **Target** to the branch with AI Story Studio (`claude/story-studio-audio-pipeline-w7vu3o`, or `main` after merging).
4. Enter a title, e.g. `Worker image 1.2.0`, and click **Publish release**.
5. **Actions** tab: wait for **AI Story Studio worker image** to show a green tick (20–40 minutes).

It pushes `ghcr.io/rahulks6/ai-story-studio-worker:1.2.0` using GitHub's own short-lived token. You create no token.

### Option B: build and push it on this PC with Docker Desktop

It needs about 30 GB of free disk space, and downloads and uploads about 6 GB each way. Your PC needs no NVIDIA GPU.

**The easy way:** double-click `scripts\Publish-Worker-Image.bat` in the AI Story Studio folder. It runs B1–B6 below and pauses for **Make it public**. To run the steps yourself, open **PowerShell** and continue with B1.

**B1. Docker Desktop**

- Install it (or download it from https://www.docker.com/products/docker-desktop/):
  ```powershell
  winget install -e --id Docker.DockerDesktop
  ```
- Restart Windows if it asks.
- Start **Docker Desktop** and wait for **Engine running**.
- Check it:
  ```powershell
  docker version
  docker info --format "{{.OSType}}"
  ```
  The second command must print `linux`. If it prints `windows`, right-click the Docker icon near the clock → **Switch to Linux containers…**

**B2. Create a GitHub token for uploading.** It is only needed for pushing, and is never stored in AI Story Studio.

- Open https://github.com/settings/tokens/new?scopes=write:packages&description=AI%20Story%20Studio%20worker%20image (**Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**).
- Keep **only** `write:packages` ticked, choose **7 days** as the expiration, then click **Generate token** and copy it.
- Fine-grained tokens do not work for container packages.
- Never paste the token into a file, `.env`, a script or a chat.

**B3. Sign in to GitHub Container Registry**

```powershell
docker login ghcr.io -u rahulks6
```

At `Password:`, paste the token and press Enter. Nothing is shown while you paste. You should see `Login Succeeded`.

**B4. Build the image**

```powershell
cd "$env:USERPROFILE\AI-Story-Studio"
docker build --platform linux/amd64 -f worker\Dockerfile.cuda -t ghcr.io/rahulks6/ai-story-studio-worker:1.2.0 worker
```

It takes 20–60 minutes the first time and must end without `ERROR`. The build checks itself: every AI library must install and import, and PyTorch must stay at the CUDA 12.6 build.

**B5. Check the image before pushing** (optional, about a minute, CPU only)

```powershell
docker image inspect --format "{{json .Config.Cmd}} {{json .Config.ExposedPorts}} {{.Architecture}}" ghcr.io/rahulks6/ai-story-studio-worker:1.2.0
docker run --rm -d --name ais-worker-test -p 8765:8765 -e WORKER_AUTH_TOKEN=aisw_local_test_only_0123456789abcdef ghcr.io/rahulks6/ai-story-studio-worker:1.2.0
curl.exe http://127.0.0.1:8765/health
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:8765/models
docker rm -f ais-worker-test
```

The expected output, line by line:

- the `inspect` line shows `["python","-m","ais_worker"] {"8765/tcp":{}} amd64`;
- `/health` returns `{"status": "ok", "version": "1.2.0", "ready": true}`;
- `/models` returns `401`, because the worker refuses requests without the session token.

**B6. Push the image, then sign out again**

```powershell
docker push ghcr.io/rahulks6/ai-story-studio-worker:1.2.0
docker logout ghcr.io
```

If the upload stops half-way, run `docker push` again: finished parts are not sent twice.

`scripts\Build-Worker-Image.bat` and `scripts\Push-Worker-Image.bat` do B1–B6 with checks and plain-language errors. The push script asks for the token with hidden input, passes it through `--password-stdin`, and signs out afterwards.

### Make it public (once, after option A or B)

1. Open https://github.com/users/rahulks6/packages/container/package/ai-story-studio-worker. You can also get there from your GitHub profile → **Packages** → **ai-story-studio-worker**.
2. Click **Package settings** (right side).
3. Scroll to **Danger Zone** → **Change visibility** → **Public**. Type `ai-story-studio-worker` to confirm, and click the button.

Anyone can download a public image. This one contains only the open-source worker code that is already in your public repository: no keys, tokens, model weights or stories.

### Verify the anonymous pull

This check uses **no password**, exactly like RunPod. Any one of these:

```powershell
scripts\Verify-Worker-Image.bat
```

```powershell
npm run check:image
```

```powershell
docker logout ghcr.io
docker manifest inspect ghcr.io/rahulks6/ai-story-studio-worker:1.2.0
```

The first two must print **IMAGE EXISTS AND PUBLICLY PULLABLE**. The Docker command must print a JSON manifest that contains `"architecture": "amd64"`.

| Result                                 | Meaning and what to do                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **IMAGE EXISTS AND PUBLICLY PULLABLE** | Done. RunPod can download it.                                                                                                           |
| **IMAGE REQUIRES AUTHENTICATION**      | Still private, **or never pushed**: GitHub answers both the same way to anonymous users. Finish option A or B, then **Make it public**. |
| **IMAGE DOES NOT EXIST**               | Wrong name or tag (for example `1.2.0` was not pushed), or no `linux/amd64` build.                                                      |
| **REGISTRY UNREACHABLE**               | This PC could not reach `ghcr.io` (internet, proxy, firewall or antivirus). This says nothing about the image; try again.               |

### Run the free dry run again

In AI Story Studio, open **Cloud GPU → Run dry-run diagnostics (free)**. **Worker image** should now be **OK**.

## Step 4: Connect RunPod in AI Story Studio

Real AI on RunPod is the default in version 1.2: there is nothing to unlock in `.env`.

1. Start AI Story Studio. The first start opens the **setup wizard**; step 3 is **Connect RunPod**.
   (Later, the same is on **Settings → AI Engine**.)
2. Paste the API key and press **Save and test** (on the AI Engine page: **TEST CONNECTION**, then
   **SAVE**). The key is stored **encrypted** on this PC (Windows data protection), never shown again
   (only its last four characters), never written to a log, a backup or a project export.
   - "Not saved: RunPod authentication failed" means the key was mistyped or has no write permission.
     Create a new one.
3. The page shows **RUNPOD CONNECTED ✓**, and Home shows **AI Engine: RUNPOD READY ✓**. If it says
   **Needs attention**, each problem is listed with its one fix (for example the worker image of step 3
   is not public yet).

Test and save never rent a GPU.

## Step 5: The Real Mode Test (milestone 1)

**Settings → AI Engine → RUN REAL MODE TEST** proves the whole chain once, for a few rupees:

1. The app shows the GPU it would rent, its price and the estimated cost, and waits for **CONFIRM AND RUN**.
2. It rents the GPU, starts the worker, makes one real picture, animates it, speaks one narration line,
   builds a short MP4 on this PC with FFmpeg, checks the file (resolution, decoding, not frozen, not
   black) and **terminates the GPU**.
3. Each step shows **PASS**, **FAIL** or **BLOCKED** with the reason. The GPU is terminated even when a
   step fails. See [REAL_MODE_TEST.md](REAL_MODE_TEST.md).

Afterwards, check the **RunPod console → Pods** page: no pod named `ais-…` should be running.

## Step 6: Make a video

Press **+ CREATE NEW VIDEO**, describe the story, choose the length and style, and press **GENERATE**.
The studio rents a suitable GPU, writes the story, designs the characters, draws and animates every
shot, records the voices, builds the full episode and the Shorts on this PC, checks them, and
terminates the GPU. You review the result, then approve publishing (see
[YOUTUBE_SETUP.md](YOUTUBE_SETUP.md)).

## Step 7: Advanced Mode (optional)

**Advanced Mode → Cloud GPU** keeps the expert controls: the free dry-run diagnostics, allowed GPU
types, cloud type (secure/community), network volume, the worker image name, models and licences, and
the individual switches. The dry run asks RunPod for stock and prices and checks the worker image
**without renting anything**:

```
GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6
```

A GPU counts only if it has enough VRAM for the models of the job, RunPod reports it in stock for pods,
its hosts offer CUDA 12.6 or newer, and its price is within your limits. Among those the studio prefers,
in order: compatibility, enough VRAM, earlier successful starts, quality headroom, reliability, speed.
If a GPU type cannot be started it tries up to two other suitable types. The app never rents a GPU
while the worker image is not publicly pullable.

Optional hard limits in `.env` that the app can never exceed (rupees and minutes):

```
MAX_GPU_HOURLY_RATE=60
SESSION_BUDGET=150
MAX_GPU_LIFETIME_MINUTES=90
```

## Step 8: Safety controls (how the studio protects your money)

| Control                 | What it does                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Maximum hourly price    | Never rents a GPU above this price (₹/h)                                                               |
| Session budget          | Refuses a batch that would cost more, and stops the GPU when a session reaches it                      |
| Idle shutdown           | Terminates a GPU that is not working (default 10 minutes)                                              |
| Maximum GPU lifetime    | Terminates any GPU after this many minutes, no matter what                                             |
| One GPU at a time       | By default only one paid GPU can exist                                                                 |
| Terminate when finished | The default: the GPU stops as soon as no work is left                                                  |
| **EMERGENCY STOP GPU**  | Red button at the top of every page whenever a cloud GPU could exist                                   |
| Start-up check          | When the app starts, it finds GPUs left over from a crash and terminates them                          |
| GPU self-check          | If this PC is switched off, the worker on the GPU terminates its own pod after the idle/lifetime limit |
| Your RunPod balance     | RunPod is prepaid: it can never spend more than your credit                                            |

**Always check once in a while:** open the RunPod console → **Pods**. Nothing should be running when you are not generating.

## Removing the key

**Settings → AI Engine → DELETE KEY** removes it from this PC. Also delete the key in the RunPod console (**Settings → API Keys**) if you no longer use it. Without a key nothing can be rented.
