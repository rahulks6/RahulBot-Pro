# Models for cloud generation

The cloud worker ships a catalog (`worker/models.cloud.json`). Since v1.3 nothing has to be published: GPU pods start from Docker Hub's public `pytorch/pytorch` image and the app uploads its own worker code and catalog to the pod (see RUNPOD_SETUP.md); a self-built image (`ghcr.io/…`) is still possible under Cloud GPU → Worker source. In **Simple Mode nothing needs choosing**: the defaults below are used and the GPU is picked for them automatically. In **Advanced Mode**, **Cloud GPU → Models (cloud)** enables or disables models and records the acknowledgement of conditional licences. Each GPU session receives those choices (`WORKER_ENABLED_MODELS`, `WORKER_LICENSE_ACK`).

No model weights are inside the Windows installer or the worker image: they download on the rented GPU the first time they are used.

> **Status:** these adapters are code-complete and contract-tested against stand-ins for the libraries. **No model has run on a real GPU yet.** The **Real Mode Test** (Settings → AI Engine, see REAL_MODE_TEST.md) is the first real run.

## Default models

| Type           | Model                          | Licence (Sept 2026, re-check)                                                                                                 | Min / rec. VRAM | Download |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| Story writing  | Qwen2.5-7B-Instruct            | Apache-2.0                                                                                                                    | 18 / 24 GB      | ~15 GB   |
| Image          | FLUX.1 [schnell]               | Apache-2.0                                                                                                                    | 24 / 48 GB      | ~34 GB   |
| Image (alt.)   | FLUX.2 [klein] 4B, disabled    | Apache-2.0                                                                                                                    | 12 / 24 GB      | ~16 GB   |
| Image → video  | Wan 2.2 TI2V 5B                | Apache-2.0                                                                                                                    | 24 / 48 GB      | ~34 GB   |
| Speech         | Kokoro 82M (EN + Hindi voices) | Apache-2.0 (Hindi phonemes via espeak-ng, GPL-3.0, run as a separate system program; the audio it helps make is not affected) | CPU/GPU         | ~1 GB    |
| Speech (clone) | Chatterbox, disabled           | MIT (voice references need recorded consent)                                                                                  | 6 / 8 GB        | ~3 GB    |
| Music          | Stable Audio Open 1.0          | **Conditional** (Community Licence, < US$1M revenue)                                                                          | 12 / 16 GB      | ~6 GB    |
| SFX / ambience | Stable Audio Open 1.0          | **Conditional**                                                                                                               | 12 / 16 GB      | ~6 GB    |
| Upscale        | FFmpeg Lanczos                 | FFmpeg                                                                                                                        | CPU             | none     |
| Upscale (AI)   | Real-ESRGAN, disabled          | BSD-3-Clause (check the weights file)                                                                                         | 4 / 8 GB        | ~0.1 GB  |

Non-commercial models (FLUX.2 [dev], F5-TTS, MusicGen, Wav2Lip) are **not** in the cloud image. A model with an unknown licence can never be enabled. Being listed is not a recommendation: use **Model Benchmarks** to compare.

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
2. **Reference-guided images:** with real cloud models, a shot's image starts from the character's approved reference sheet (image-to-image, strength 0.8 by default; **Settings → Generation → Character reference strength**, 0 = off). This carries palette, proportions and clothing over; it is not full identity conditioning (IP-Adapter / LoRA training is future work).
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

Edit `worker/models.cloud.json` (id, kind, adapter, repo, revision, licence, `commercial_use`, VRAM, precision, storage, capabilities, params), rebuild the worker image (GitHub Actions workflow), and benchmark it. Keep `commercial_use` honest; the licence gate depends on it.

## Hugging Face token

None of the defaults needs one. For a gated model, save a token in `.env` as `HF_TOKEN=`. It is passed to the GPU session environment (visible to you in the RunPod console) and never logged.
