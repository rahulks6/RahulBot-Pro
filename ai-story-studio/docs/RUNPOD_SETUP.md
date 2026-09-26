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
ghcr.io/rahulks6/ai-story-studio-worker:1.1.0
```

This is the app's default (**Cloud GPU → Advanced → Worker image**). If your GitHub user name is not `rahulks6`, replace it everywhere below, in lower case, and change the setting too.

Until this step is done, the dry run shows **Worker image: IMAGE REQUIRES AUTHENTICATION**, and the app refuses to rent any GPU. That is intended.

Choose **one** way to build and push the image: **A** or **B**. Then do **Make it public** and **Verify**.

### Option A: let GitHub build it (no Docker needed)

1. On **github.com**, open your repository → **Releases** → **Draft a new release**.
2. Click **Choose a tag**, type `ai-story-studio-worker-v1.1.0`, and click **Create new tag … on publish**.
3. Set **Target** to the branch with AI Story Studio (`claude/story-studio-audio-pipeline-w7vu3o`, or `main` after merging).
4. Enter a title, e.g. `Worker image 1.1.0`, and click **Publish release**.
5. **Actions** tab: wait for **AI Story Studio worker image** to show a green tick (20–40 minutes).

It pushes `ghcr.io/rahulks6/ai-story-studio-worker:1.1.0` using GitHub's own short-lived token. You create no token.

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
docker build --platform linux/amd64 -f worker\Dockerfile.cuda -t ghcr.io/rahulks6/ai-story-studio-worker:1.1.0 worker
```

It takes 20–60 minutes the first time and must end without `ERROR`. The build checks itself: every AI library must install and import, and PyTorch must stay at the CUDA 12.6 build.

**B5. Check the image before pushing** (optional, about a minute, CPU only)

```powershell
docker image inspect --format "{{json .Config.Cmd}} {{json .Config.ExposedPorts}} {{.Architecture}}" ghcr.io/rahulks6/ai-story-studio-worker:1.1.0
docker run --rm -d --name ais-worker-test -p 8765:8765 -e WORKER_AUTH_TOKEN=aisw_local_test_only_0123456789abcdef ghcr.io/rahulks6/ai-story-studio-worker:1.1.0
curl.exe http://127.0.0.1:8765/health
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:8765/models
docker rm -f ais-worker-test
```

The expected output, line by line:

- the `inspect` line shows `["python","-m","ais_worker"] {"8765/tcp":{}} amd64`;
- `/health` returns `{"status": "ok", "version": "1.1.0", "ready": true}`;
- `/models` returns `401`, because the worker refuses requests without the session token.

**B6. Push the image, then sign out again**

```powershell
docker push ghcr.io/rahulks6/ai-story-studio-worker:1.1.0
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
docker manifest inspect ghcr.io/rahulks6/ai-story-studio-worker:1.1.0
```

The first two must print **IMAGE EXISTS AND PUBLICLY PULLABLE**. The Docker command must print a JSON manifest that contains `"architecture": "amd64"`.

| Result                                 | Meaning and what to do                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **IMAGE EXISTS AND PUBLICLY PULLABLE** | Done. RunPod can download it.                                                                                                           |
| **IMAGE REQUIRES AUTHENTICATION**      | Still private, **or never pushed**: GitHub answers both the same way to anonymous users. Finish option A or B, then **Make it public**. |
| **IMAGE DOES NOT EXIST**               | Wrong name or tag (for example `1.1.0` was not pushed), or no `linux/amd64` build.                                                      |
| **REGISTRY UNREACHABLE**               | This PC could not reach `ghcr.io` (internet, proxy, firewall or antivirus). This says nothing about the image; try again.               |

### Run the free dry run again

In AI Story Studio, open **Cloud GPU → Run dry-run diagnostics (free)**. **Worker image** should now be **OK**.

## Step 4: Unlock cloud mode in the `.env` file

The two master switches live in the `.env` file, so they cannot be flipped by accident.

1. Close AI Story Studio (close its black window).
2. Open the AI Story Studio folder, right-click **`.env`** → **Open with** → **Notepad**.
3. Change these two lines:
   ```
   MOCK_GENERATION=false
   ENABLE_CLOUD_GPU=true
   ```
4. Optionally add hard limits that the app can never exceed (in rupees and minutes), for example:
   ```
   MAX_GPU_HOURLY_RATE=60
   SESSION_BUDGET=150
   MAX_GPU_LIFETIME_MINUTES=90
   ```
5. Save the file and start AI Story Studio again from the desktop shortcut.

The banner at the top now says **MODE: MOCK PROVIDERS**: cloud is unlocked but not switched on yet.

## Step 5: Save and test the API key

1. In the app, open **Cloud GPU** in the left menu.
2. Under **Provider and API key**, choose **RunPod**, paste your key into **API key**, and click **Save**. The key is stored only on this PC (`data\secrets.json`), and the page only ever shows its last four characters.
3. Click **Test Connection**. You should see "key accepted" and "API contract verified".
   - "RunPod authentication failed. Check your API key." means the key was mistyped or has no write permission. Create a new one.
4. Click **Run dry-run diagnostics (free)**. It checks the key, the GPU list and prices, the worker image and the models **without renting anything**. You should see:

   ```
   OK   Provider implemented
   OK   API key saved
   OK   API credentials and connectivity
   OK   Compatible GPUs and price      (e.g. "3 GPU type(s) with ≥ 24 GB VRAM in stock for pods in secure cloud (CUDA ≥ 12.6) at or below your ₹60/h limit; cheapest: …")
   OK   Worker image                   (IMAGE EXISTS AND PUBLICLY PULLABLE)
   OK   Model: image / video / tts
   OK   Cost limits
   ```

   The four real-generation gate lines show **FAIL/OFF** until you turn them on, and that is expected:
   - `MOCK_GENERATION=false` and `ENABLE_CLOUD_GPU=true` are set in `.env` (step 4);
   - **Cloud GPU enabled** is switched on in step 6;
   - **Real generation enabled** is switched on in step 7.

   You can run the diagnostics before any of that. Nothing is rented either way.
   - **Compatible GPUs and price** asks RunPod for pod stock in your cloud type:

     ```
     GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6
     ```

     A GPU counts only if all of these hold:
     - it has at least the VRAM your models need (24 GB by default);
     - RunPod reports it in stock for pods (LOW, MEDIUM or HIGH);
     - its hosts offer CUDA 12.6 or newer (the worker image's CUDA);
     - its current price for your cloud type is at or below your limit.

     If none qualifies, the message says which condition ruled the GPUs out, and shows RunPod's own reason for any refused request. A listed price alone is never treated as "available".

   - The app never rents a GPU while **Worker image** is not OK.

## Step 6: Switch on Cloud GPU and run the first test

1. Under **Switches**, tick **Cloud GPU enabled** and click **Save switches**. Leave "Real generation" off for now.
2. Click **Start Test GPU…**, choose **One spoken sentence**, and click **Steps 1–3**. Nothing is rented yet: the app shows the GPU it found and its price.
3. Click **Rent the GPU and run the test**. The page follows each step: renting, starting the worker, health check, generating one short sentence, downloading, checking the file, and **terminating the GPU**.
4. The first test takes longer because the GPU downloads the speech model. At the end you see **SUCCESS** or **FAILURE**, the GPU used, the runtime, the estimated cost (usually a few rupees) and where the test file was saved.

If the test fails, the GPU is still terminated automatically; read the error on the page. Then check the **RunPod console → Pods** page: it should list no running pod named `ais-…`.

## Step 7: Switch on real generation

1. Tick **Real generation enabled** and click **Save switches**. The banner turns red: **MODE: REAL CLOUD**.
2. Optional: in **Models (cloud)**, read the Stable Audio Open licence. If it fits how you publish, click **I have read and accept the licence**. Without this, music and sound effects are not generated in the cloud.
3. Start small: generate **one shot's image** first, check it, then continue with the whole story.

From now on, when you press **Generate** the studio rents a GPU, runs the work, downloads and checks each file, and terminates the GPU when nothing is left to do.

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

## Turning cloud mode off again

Untick the two switches on the **Cloud GPU** page. For a complete lock, set `MOCK_GENERATION=true` and `ENABLE_CLOUD_GPU=false` again in `.env` and restart.

## Removing the key

Click **Remove saved key** on the **Cloud GPU** page. Also delete the key in the RunPod console (**Settings → API Keys**) if you no longer use it.
