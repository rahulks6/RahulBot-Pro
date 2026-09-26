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

The rented GPU runs a small program, the "AI worker", from a **container image**. RunPod downloads that image when the GPU starts, so it must be published somewhere RunPod can read it **without a password**: your GitHub account's container registry (`ghcr.io`), with the image set to **public**. The image holds program code only. It has **no model weights** (those download on the GPU the first time) and **no secrets**.

Your image name is `ghcr.io/<your-github-name>/ai-story-studio-worker:1.1.0`, in lower case. The app is preset to `ghcr.io/rahulks6/ai-story-studio-worker:1.1.0`. If your GitHub name is different, change it in **Cloud GPU → Advanced → Worker image**.

Choose **one** of the two ways to build and publish it.

### Option A (recommended): let GitHub build it

This needs no Docker and uses none of your PC's disk space. It is free for a public repository.

1. Open your repository on **github.com**.
2. Click **Releases** (right side), then **Draft a new release**.
3. Click **Choose a tag** and type exactly `ai-story-studio-worker-v1.1.0`, then click **Create new tag: ai-story-studio-worker-v1.1.0 on publish**.
4. Set **Target** to the branch that contains AI Story Studio (for example `claude/story-studio-audio-pipeline-w7vu3o`, or `main` once it is merged).
5. Enter any title (for example `Worker image 1.1.0`) and click **Publish release**.
6. Open the **Actions** tab. The run **AI Story Studio worker image** starts by itself. Wait until it shows a green tick (about 20–40 minutes).

   Once the app is merged into your default branch, you can instead use **Actions → AI Story Studio worker image → Run workflow**.

Then go to **Make it public** below.

### Option B: build it on this PC with Docker Desktop

This needs about 25 GB of free disk space. It downloads about 6 GB and uploads about 6 GB, so it can take hours on a slow connection. Your PC needs no NVIDIA GPU to build it.

1. **Install Docker Desktop**, if you do not have it: https://www.docker.com/products/docker-desktop/. Keep the default options (WSL 2) and restart Windows if it asks. Start **Docker Desktop** and wait until it shows **Engine running**.
2. **Build:** in the AI Story Studio folder, double-click `scripts\Build-Worker-Image.bat` and type your GitHub user name when asked. It builds `ghcr.io/<you>/ai-story-studio-worker:1.1.0`. The same command in PowerShell:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\build-worker-image.ps1 -Owner <your-github-name>
   ```
3. **Create a GitHub token for uploading:**
   - On github.com, open your picture → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
   - Tick **only** `write:packages`, choose a short expiration (7 days), then click **Generate token** and copy it.
   - Never put the token in a file, in `.env`, or in a chat.
4. **Upload:** double-click `scripts\Push-Worker-Image.bat`, type your GitHub user name, and paste the token when asked (it is not shown). The script:
   - signs in with `docker login --password-stdin`, so the token never appears on a command line;
   - uploads the image;
   - **signs out again**, so Docker no longer keeps the token.

   The same command in PowerShell:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\push-worker-image.ps1 -Owner <your-github-name>
   ```

### Make it public (once, for either option)

1. Open `https://github.com/users/<your-github-name>/packages/container/package/ai-story-studio-worker`. You can also get there from your GitHub profile → **Packages** → **ai-story-studio-worker**.
2. Click **Package settings** (right side). Under **Danger Zone**, click **Change visibility** → **Public**, type the name to confirm, and click the button.

A public image can be downloaded by anyone. It contains only the open-source worker code, which is also in your repository: no keys, no tokens, no model weights and no stories.

### Check it without a password

Double-click `scripts\Verify-Worker-Image.bat`, or run `npm run check:image` in the AI Story Studio folder. This is the same check as the app's diagnostics. The result is one of four answers:

| Result                                 | Meaning and what to do                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IMAGE EXISTS AND PUBLICLY PULLABLE** | Done. RunPod can download it.                                                                                                                                      |
| **IMAGE REQUIRES AUTHENTICATION**      | The package is still private, **or it was never pushed**: GitHub answers both the same way to anonymous users. Finish option A or B, then **Make it public**.      |
| **IMAGE DOES NOT EXIST**               | The name or tag is wrong (for example `1.1.0` was not pushed), or the image has no `linux/amd64` build. Check the name in **Cloud GPU → Advanced → Worker image**. |
| **REGISTRY UNREACHABLE**               | This PC could not reach `ghcr.io` (internet, proxy, firewall or antivirus). This says nothing about the image. Try again later or on another network.              |

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
   OK   Compatible GPUs and price      (e.g. "3 GPU type(s) with ≥ 24 GB VRAM within your ₹60/h limit; cheapest: …")
   OK   Worker image                   (IMAGE EXISTS AND PUBLICLY PULLABLE)
   OK   Model: image / video / tts
   OK   Cost limits
   ```

   The four real-generation gate lines show **FAIL/OFF** until you turn them on, and that is expected:
   - `MOCK_GENERATION=false` and `ENABLE_CLOUD_GPU=true` are set in `.env` (step 4);
   - **Cloud GPU enabled** is switched on in step 6;
   - **Real generation enabled** is switched on in step 7.

   You can run the diagnostics before any of that. Nothing is rented either way.
   - If **Compatible GPUs and price** fails, the message now includes RunPod's own reason, or explains the problem: no GPU with enough VRAM, none in stock, or none below your price limit (it then shows the cheapest one).
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
