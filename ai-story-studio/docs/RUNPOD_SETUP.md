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

## Step 3: Nothing to publish (skip to step 4)

Since version 1.3 a GPU starts from Docker Hub's public PyTorch image
(`pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime`) and AI Story Studio sends it the AI worker code itself,
over the GPU's HTTPS address, protected by the per-session token and a checksum fixed when the GPU was
created. There is **no Docker, GitHub or GHCR step**. The first start on a new GPU volume installs the AI
libraries (pinned versions, a few minutes; with a RunPod network volume they are kept for next time).

> Status: this path is tested locally against the real bootstrap script and the real worker (without a
> GPU); the first run on a real RunPod GPU is **NOT TESTED** yet — the Real Mode Test is that run.

Only if you deliberately choose **Advanced → Cloud GPU → Worker source: Prebuilt worker image** do you
need to build and publish an image yourself: see [ADVANCED_WORKER_IMAGE.md](ADVANCED_WORKER_IMAGE.md).
Normal users skip this.

## Step 4: Connect RunPod in AI Story Studio

Real AI on RunPod is the default: there is nothing to unlock in `.env`, and nothing falls back to
placeholder media when generation fails (the step fails and says why).

1. Start AI Story Studio. The first start opens the **setup wizard**; step 3 is **Connect RunPod**.
   (Later, the same is on **Settings → AI Engine**.)
2. Paste the API key and press **Save and test** (on the AI Engine page: **TEST CONNECTION**, then
   **SAVE**). The key is stored **encrypted** on this PC (Windows data protection), never shown again
   (only its last four characters), never written to a log, a backup or a project export.
   - "Not saved: RunPod authentication failed" means the key was mistyped or has no write permission.
     Create a new one.
3. The page shows **RUNPOD CONNECTED ✓**, and Home shows **AI Engine: RUNPOD READY ✓**. If it says
   **Needs attention**, each problem is listed with its one fix.

Test and save never rent a GPU.

## Step 5: The Real Mode Test

**Advanced Mode → Real Mode Test → RUN REAL MODE TEST** (also on Settings → AI Engine) proves the real
engine once, for a few rupees:

1. The app shows the GPU it would rent, its price and the estimated cost, and waits for **CONFIRM AND RUN**.
2. It rents the GPU, starts the worker (which proves CUDA itself), draws one ORIGINAL test character,
   animates it, speaks one English and one Hinglish line, **terminates the GPU**, then builds
   `test_english.mp4` and `test_hinglish.mp4` from the SAME clip on this PC and checks both (ffprobe,
   full decode, not frozen, not black).
3. Each stage shows **PASS**, **FAIL**, **BLOCKED** or **NOT TESTED** with the reason. You then watch and
   listen and mark the four review steps; only then can it say **REAL-AI VERIFIED**. See
   [REAL_MODE_TEST.md](REAL_MODE_TEST.md).

The same page has the **character consistency test** (13 pictures of one character,
[CHARACTER_CONSISTENCY_TEST.md](CHARACTER_CONSISTENCY_TEST.md)) and the **20–30 s bilingual scene test**.

Afterwards, check the **RunPod console → Pods** page: no pod named `ais-…` should be running.

## Step 6: Make a video

Press **+ CREATE NEW VIDEO**, describe the story, choose the length and style, and press **GENERATE**.
The studio rents a suitable GPU, writes the story, designs the characters, draws and animates every
shot, records the voices, builds the full episode and the Shorts on this PC, checks them, and
terminates the GPU. You review the result, then approve publishing (see
[YOUTUBE_SETUP.md](YOUTUBE_SETUP.md)).

## Step 7: Advanced Mode (optional)

**Advanced Mode → Cloud GPU** keeps the expert controls: the free dry-run diagnostics, allowed GPU
types, cloud type (secure/community), network volume, the worker source (automatic, or your own image), models and licences, and
the individual switches. The dry run asks RunPod for stock and prices and checks the pod's base image
**without renting anything**:

```
GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6
```

A GPU counts only if it has enough VRAM for the models of the job, RunPod reports it in stock for pods,
its hosts offer CUDA 12.6 or newer, and its price is within your limits. Among those the studio prefers,
in order: compatibility, enough VRAM, earlier successful starts, quality headroom, reliability, speed.
If a GPU type cannot be started it tries up to two other suitable types. The app never rents a GPU
while the pod's base image (by default the public PyTorch image) cannot be pulled anonymously.

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
