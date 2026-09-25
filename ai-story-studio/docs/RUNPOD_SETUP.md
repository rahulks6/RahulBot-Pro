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

The rented GPU runs a small program, the "AI worker", from a container image. You build it once, for free, with GitHub Actions:

1. Open your repository on **github.com**, then the **Actions** tab.
2. Choose **AI Story Studio worker image** on the left, then **Run workflow** → **Run workflow**. It takes about 20–40 minutes. It contains no secrets and no model weights.
3. When it has finished, open your GitHub profile → **Packages** → **ai-story-studio-worker** → **Package settings** → **Change visibility** → **Public**. RunPod can then download it without a password.
4. The image name is `ghcr.io/<your-github-name>/ai-story-studio-worker:1.1.0`, all in lower case. The app is preset to `ghcr.io/rahulks6/ai-story-studio-worker:1.1.0`. If your GitHub name differs, change it in **Cloud GPU → Advanced → Worker image**.

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
4. Click **Run dry-run diagnostics (free)**. It checks the key, the GPU prices, the worker image and the models **without renting anything**. Every line should be green, or say "note".

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
