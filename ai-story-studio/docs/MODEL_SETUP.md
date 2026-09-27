# Models for cloud generation

The cloud worker ships a catalog (`worker/models.cloud.json`). Since v1.3 nothing has to be published: GPU pods start from Docker Hub's public `pytorch/pytorch` image and the app uploads its own worker code and catalog to the pod (see RUNPOD_SETUP.md); a self-built image (`ghcr.io/…`) is still possible under Cloud GPU → Worker source. In **Simple Mode nothing needs choosing**: the defaults below are used and the GPU is picked for them automatically. In **Advanced Mode**, **Cloud GPU → Models (cloud)** enables or disables models and records the acknowledgement of conditional licences. Each GPU session receives those choices (`WORKER_ENABLED_MODELS`, `WORKER_LICENSE_ACK`).

No model weights are inside the Windows installer or the worker image: they download on the rented GPU the first time they are used.

> **Status (v1.3.1):** the adapters are code-complete and contract-tested against stand-ins for the
> libraries. **No model has run on a real GPU yet** (the development machine has no GPU and no access
> to RunPod or Hugging Face). The **Real Mode Test** (Advanced Mode → Real Mode Test) is the first real
> run; it now records the exact library versions and model commits it used.

## Configured models (audit of `worker/models.cloud.json`, v1.3.1)

| Catalog id                | Kind                       | Default | Hugging Face repo                   | Revision | Licence                                                                                                  | Commercial use                                                              | Min / rec. VRAM | Precision | Download |
| ------------------------- | -------------------------- | ------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------- | --------- | -------- |
| `qwen2.5-7b-instruct`     | story writing              | on      | `Qwen/Qwen2.5-7B-Instruct`          | `main`   | Apache-2.0                                                                                               | allowed                                                                     | 18 / 24 GB      | bf16      | ~15 GB   |
| `flux1-schnell`           | image                      | on      | `black-forest-labs/FLUX.1-schnell`  | `main`   | Apache-2.0                                                                                               | allowed                                                                     | 24 / 48 GB      | bf16      | ~34 GB   |
| `flux2-klein-4b`          | image                      | off     | `black-forest-labs/FLUX.2-klein-4B` | `main`   | Apache-2.0 (only the [klein] variant)                                                                    | allowed                                                                     | 12 / 24 GB      | bf16      | ~16 GB   |
| `wan2.2-ti2v-5b`          | image → video              | on      | `Wan-AI/Wan2.2-TI2V-5B-Diffusers`   | `main`   | Apache-2.0                                                                                               | allowed                                                                     | 24 / 48 GB      | bf16      | ~34 GB   |
| `kokoro-82m`              | speech (EN + Hindi voices) | on      | `hexgrad/Kokoro-82M`                | `main`   | Apache-2.0; Hindi phonemes via espeak-ng (GPL-3.0, a separate system program; the audio is not affected) | allowed                                                                     | CPU/GPU         | fp32      | ~1 GB    |
| `chatterbox`              | speech (voice clone)       | off     | `ResembleAI/chatterbox`             | `main`   | MIT; voice references need recorded consent                                                              | allowed                                                                     | 6 / 8 GB        | fp32      | ~3 GB    |
| `stable-audio-open-music` | music                      | on      | `stabilityai/stable-audio-open-1.0` | default  | Stability AI Community Licence                                                                           | **conditional** (free under US$1M annual revenue; acknowledgement required) | 12 / 16 GB      | fp16      | ~6 GB    |
| `stable-audio-open`       | SFX / ambience             | on      | `stabilityai/stable-audio-open-1.0` | default  | Stability AI Community Licence                                                                           | **conditional**                                                             | 12 / 16 GB      | fp16      | ~6 GB    |
| `ffmpeg-lanczos`          | upscale                    | on      | —                                   | —        | FFmpeg (LGPL/GPL, build dependent)                                                                       | allowed                                                                     | CPU             | —         | none     |
| `real-esrgan`             | upscale (AI)               | off     | `xinntao/Real-ESRGAN`               | default  | BSD-3-Clause (check the weights file)                                                                    | allowed                                                                     | 4 / 8 GB        | fp16      | ~0.1 GB  |

Licence facts were collected from the public model cards in September 2026 and **could not be
re-checked from the development machine** (Hugging Face is blocked there): re-check each card before
publishing. Non-commercial models (FLUX.2 [dev], F5-TTS, MusicGen, Wav2Lip) are not in the catalog; a
model with an unknown licence can never be enabled, and a conditional one only after you acknowledge it.

**Revisions:** every repo follows `main` (or its default branch), not a fixed commit. A new upload by
the model author could therefore change results. Each Real Mode Test now writes the exact commits the
worker used to `real-tests/<run>/model-revisions.txt`; pin them in `models.cloud.json` (`"revision":
"<commit>"`) after the first good run.

**Limitations to know:** FLUX.1 [schnell] is a 4-step model (fast, less fine detail); it has no native
identity adapter, so character consistency relies on image-to-image from the reference sheet (see
CHARACTER_CONSISTENCY_TEST.md). Wan 2.2 TI2V 5B makes short clips (about 5 s at 720p). Kokoro has no
emotion control and four Hindi voices (`hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi`); Hinglish quality is
unproven until you listen to the Real Mode Test.

## Software on the GPU (pinned)

| Part                                             | Version                                                              | Where it comes from                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Base image                                       | `pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime` (public, Docker Hub) | pulled by RunPod                                                        |
| PyTorch / CUDA / cuDNN                           | 2.7.1 / 12.6 / 9                                                     | the image; pinned with a constraints file so pip can never replace them |
| Python                                           | the image's own Python (recorded by the Real Mode Test)              | the image                                                               |
| diffusers, transformers, accelerate              | 0.35.1, 4.56.1, 1.10.1                                               | `worker/requirements-cloud.txt` (exact `==` pins)                       |
| huggingface_hub, sentencepiece, protobuf, pillow | 0.34.4, 0.2.0, 5.29.5, 11.3.0                                        | same                                                                    |
| kokoro, soundfile                                | 0.9.4, 0.13.1                                                        | same                                                                    |
| torchsde (Stable Audio), spandrel (Real-ESRGAN)  | 0.2.6, 0.4.1                                                         | same                                                                    |
| FFmpeg, espeak-ng                                | the Ubuntu packages of the image                                     | installed by the bootstrap with `apt` if missing                        |
| GPU hosts                                        | CUDA ≥ 12.6 drivers                                                  | RunPod catalog filter `minCudaVersion=12.6`                             |

Only the direct libraries are pinned. Their own dependencies (for example `misaki`, the Kokoro
phonemizer) are resolved by pip on the first install on a GPU volume and then reused from the volume.
Because the development machine cannot reach PyPI, a fully verified lock file could not be produced
here. Instead, the bootstrap records every installed version (`name==version`), and the Real Mode Test
saves it as `real-tests/<run>/installed-packages.txt`. Commit that list as
`worker/requirements-cloud.lock` after the first good run.

## Which GPU

24 GB of VRAM (RTX A5000, RTX 4090, L4, RTX 3090) runs every default model with CPU offloading. 48 GB (A6000, L40S) is faster. Leave **Allowed GPU types** empty and the studio chooses by, in this order: compatibility (CUDA version the image needs), enough VRAM for the models of that job, earlier successful starts, quality headroom, reliability (stock), then speed — not simply the cheapest. If a GPU type cannot be started, it tries up to two other suitable types. Your per-video, daily and monthly limits still apply.

## Story writing

The script (title, scenes, shots, dialogue, narration) is written by Qwen2.5-7B-Instruct on the same RunPod GPU session, before the pictures. The app checks the script's structure and asks the model to repair it (up to three attempts); long videos are written as an outline first, then one call per scene. If writing fails, the video stops at **Writing the story** with the reason and the GPU is released.

## Keeping downloads between sessions

The first session downloads the model weights (tens of GB), which adds several minutes. Two choices:

- **Pod volume** (default, 60 GB): deleted with the GPU. Simple, but every session downloads again.
- **RunPod network volume:** create one in the RunPod console (**Storage**) in the same region as your GPUs and put its id in **Cloud GPU → Advanced → Network volume id**. Weights are kept between sessions (network volumes are billed as storage even when no GPU runs).

## Character consistency

1. **Image first:** each shot's video starts from its approved still (image-to-video). The worker **refuses** to fall back to text-to-video if a pipeline cannot take the image.
2. **Reference-guided images:** with real cloud models, a shot's image starts from the character's approved reference sheet (image-to-image, strength 0.8 by default; **Settings → Generation → Character reference strength**, 0 = off). It is meant to carry palette, proportions and clothing over; it is not identity conditioning (no IP-Adapter is configured for FLUX.1 [schnell]; LoRA training is not built). Whether it is good enough is measured by the [character consistency test](CHARACTER_CONSISTENCY_TEST.md) — NOT TESTED on real pictures yet.
3. **Locked character descriptions, seeds and prompts** remain in force as before.

## Hinglish voices

The Hinglish version of a series episode uses Kokoro's **Hindi voices** (`hf_alpha`, `hf_beta`,
`hm_omega`, `hm_psi`), one persistent voice per character (see LOCALIZATION.md). The app sends each
line in mixed script — Hindi words in Devanagari, English words in Latin letters — and the worker
speaks Devanagari runs with the Hindi phonemizer and Latin runs with the English one, in the same
voice. Captions stay in Roman Hinglish. The Hindi phonemizer needs `espeak-ng` on the pod: the
bootstrap installs it with `apt` (as it does FFmpeg). **Not yet run on a real GPU**; the Real Mode
Test now includes one real Hinglish line.

## Voice cloning

Chatterbox can clone a voice only from a reference recording with a **recorded consent** (Phase 4). The safeguards are unchanged: no consent means no reference is sent, and revoking consent deletes the recording and regenerates the lines.

## Adding or changing a model

Edit `worker/models.cloud.json` (id, kind, adapter, repo, revision, licence, `commercial_use`, VRAM, precision, storage, capabilities, params) and commit it: the next GPU session receives the new catalog with the worker code (no image to rebuild). Then run the Real Mode Test and benchmark it. Keep `commercial_use` honest; the licence gate depends on it.

## Hugging Face token

None of the defaults needs one. For a gated model, save a token in `.env` as `HF_TOKEN=`. It is passed to the GPU session environment (visible to you in the RunPod console) and never logged.
