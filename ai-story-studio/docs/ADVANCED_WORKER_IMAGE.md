# Advanced (optional): your own prebuilt worker image

> **You do not need this.** Since v1.3 the normal setup has no Docker, GitHub or GHCR step: GPUs start
> from Docker Hub's public PyTorch image and AI Story Studio uploads its own worker code (see
> [RUNPOD_SETUP.md](RUNPOD_SETUP.md)). This page is only for **Advanced Mode → Cloud GPU → Worker
> source: Prebuilt worker image**, e.g. to start GPUs faster with the libraries already inside. The
> image tag below (`1.2.0`) is the last one the workflow was set up for; use your own tag.

### Optional: publish a prebuilt AI worker image

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
