# Benchmarking real models on your GPU (Phase 3)

The build environment has no GPU and no access to the model hub, so **real benchmarks must be run on your own GPU machine**. Everything below runs locally and **rents nothing**.

## 1. Prepare the worker machine

Requirements: an NVIDIA GPU with a recent driver, Python 3.11 or newer, and FFmpeg on your `PATH`.

```bash
cd ai-story-studio/worker
python3 -m venv .venv && . .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124   # match your CUDA driver
pip install -r requirements-gpu.txt
nvidia-smi   # confirm the GPU is visible
```

## 2. Choose candidate models

```bash
cp models.example.json models.json
```

For each candidate you want to try:

1. Open its model card, using the `license_url` and `sources` fields.
2. Confirm the **repo id, revision and licence**. The example records public information from September 2026, and licences change: for example, Qwen-Image 2.1 moved to a non-commercial licence.
3. Set `"enabled": true`.
4. For a `conditional` licence (revenue thresholds, use restrictions), read the terms. If they fit how we publish, set `"license_acknowledged": true`.

The licence gate refuses `non_commercial` and `unknown` models, and any `conditional` model you haven't acknowledged. `WORKER_ALLOW_NONCOMMERCIAL=true` lifts the non-commercial block **for private evaluation only**; such models can never be selected for production in the app.

Be realistic about VRAM. `min_vram_gb` is a rough floor, and `cpu_offload: true` trades speed for memory. Start with the smaller candidates, such as Wan 2.2 TI2V 5B, FLUX.2 [klein] 4B and Kokoro.

## 3. Run the worker and benchmark

```bash
export WORKER_AUTH_TOKEN=<random 32+ char secret>
export WORKER_MODELS_FILE=$PWD/models.json
export WORKER_MODEL_CACHE_DIR=$HOME/.cache/ais-models     # large downloads live here
python3 -m ais_worker                                      # serves the API on 127.0.0.1:8765
```

You can run a benchmark in either of two ways.

**Option A: CLI (from `worker/`).** Prints a summary table and the path of `results.json`.

```bash
python3 -m ais_worker.benchmark --models flux2-klein-4b,qwen-image,wan2.2-ti2v-5b,kokoro-82m --image approved_still.png
```

**Option B: the app** (recommended, because it adds human ratings).

1. In `ai-story-studio/.env`, set:
   ```
   MOCK_GENERATION=false          # allows REAL models, and only on the local worker
   ENABLE_CLOUD_GPU=false         # keep cloud GPUs off
   WORKER_URL=http://127.0.0.1:8765
   WORKER_AUTH_TOKEN=<same secret>
   ```
2. Run `npm run dev`.
3. Open **Model Benchmarks**, tick the models, pick an approved still as the image-to-video source, and set the GPU hourly rate you'd pay in the cloud (this drives the cost-per-output estimate).
4. Start the benchmark, then press **Refresh** until it completes. The outputs are downloaded, verified and stored locally.

## 4. What is measured, and what you judge

| Measured automatically                                                     | Judged by you on the Benchmarks page                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Load time, mean and p95 run time, peak VRAM (PyTorch)                      | **Quality** (1–5) for each output                                                                     |
| Success rate and error codes (e.g. `OUT_OF_MEMORY`) — reliability          | **Consistency** (1–5): is it the same character across the character-front / action / close-up cases? |
| Same-seed reproducibility                                                  | Notes: artefacts, hands, text rendering, motion                                                       |
| Output checks: size, duration, fps, codec, audio peak / clipping / silence | Integration effort (write it in the selection rationale)                                              |
| Estimated cost per output at your hourly rate                              |                                                                                                       |

The default suite puts the **same original character** in different situations, adds an establishing shot, in-image text, gentle motion and a walk, plus calm, excited and whispered speech. That tests what matters for recurring-character stories. You can pass your own suite JSON with `--suite`.

## 5. Select

For each kind, pick a model, write down **why**, and acknowledge conditional licences. The app keeps the decision history and refuses non-commercial or unknown licences. After you reconnect the worker (Settings → Local AI worker), the selected model is used for generation.

## Not in Phase 3

- **Music, SFX and lip-sync adapters** are listed in the catalog as candidates with `adapter: "none"`; their adapters come in Phase 4.
- **An AI upscaler (Real-ESRGAN)** is also Phase 4. The FFmpeg Lanczos resize is the non-AI baseline.
- **Cloud GPUs** stay off until Phase 5, and paid runs until you explicitly approve them.
