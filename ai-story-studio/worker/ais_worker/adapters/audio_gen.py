"""Stable Audio Open (diffusers ``StableAudioPipeline``): music beds, SFX and ambience.

Stable Audio Open 1.0 generates up to ~47 s of 44.1 kHz stereo per call. Longer
music beds are built by tiling generated sections with equal-power
crossfades; ambience is made seamlessly loopable (tail crossfaded into the
head) because the app loops it under long scenes. Output is mono 16-bit WAV
(the app mixer is mono), peak-limited to -1 dBFS. Post-processing uses the
standard library only, so it is fully tested without a GPU stack.

Licence: Stability AI Community Licence (free below US$1M annual revenue;
conditional → needs ``license_acknowledged``). Requires: torch (CUDA build),
diffusers, transformers, torchsde.
"""

from __future__ import annotations

import math
import sys
import wave
from array import array
from pathlib import Path
from typing import Any, TypeAlias

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..models.base import Model
from ..schemas import AudioRequest
from .common import cuda_available, info_from, require, supported_kwargs, torch_dtype, track_vram

DEFAULT_NEGATIVE = {
    "music": "vocals, singing, speech, low quality, distorted, noise, clipping",
    "sfx": "music, speech, vocals, low quality, distorted",
    "ambience": "music, speech, vocals, sudden loud sounds, low quality",
}


def build_prompt(request: AudioRequest, params: dict[str, Any]) -> tuple[str, str]:
    """Prompt + negative prompt for a music / SFX / ambience request."""
    kind = request.kind
    if kind == "music":
        parts = [request.genre, request.mood, "instrumental background score"]
        if request.energy:
            parts.append(f"{request.energy} energy")
        parts.append(str(params.get("music_style", "cinematic, warm, well mixed, no vocals")))
        prompt = ", ".join(p.strip() for p in parts if p and p.strip())
    elif kind == "ambience":
        prompt = f"{request.tag} ambience, continuous background atmosphere, steady, seamless, field recording"
    else:
        prompt = f"{request.tag} sound effect, clean, isolated, close perspective, high quality"
    negative = str(params.get(f"{kind}_negative_prompt", DEFAULT_NEGATIVE.get(kind, "")))
    return prompt[:500], negative


Samples: TypeAlias = "array[float]"  # array("f") of mono float samples


def write_wav_samples(path: Path, mono: Samples, sample_rate: int) -> None:
    pcm = array("h", (int(max(-1.0, min(1.0, x)) * 32767) for x in mono))
    if sys.byteorder == "big":
        pcm.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


def to_mono(audio: Any) -> Samples:
    """(channels, samples) tensor / ndarray / nested list → mono float samples."""
    if hasattr(audio, "detach"):
        audio = audio.detach().float().cpu()
        if audio.dim() == 2:
            audio = audio.mean(dim=0 if audio.shape[0] <= 8 else 1)
        return array("f", audio.reshape(-1).tolist())
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    rows = audio if audio and isinstance(audio[0], (list, tuple)) else [audio]
    if len(rows) > 8:  # (samples, channels) layout
        rows = [list(col) for col in zip(*rows, strict=True)]
    n = min(len(r) for r in rows)
    k = len(rows)
    return array("f", (sum(r[i] for r in rows) / k for i in range(n)))


def _equal_power(n: int) -> tuple[list[float], list[float]]:
    t = [(i + 0.5) / n * math.pi / 2 for i in range(n)]
    return [math.cos(x) for x in t], [math.sin(x) for x in t]


def tile(sections: list[Samples], total: int, overlap: int) -> Samples:
    """Join sections with equal-power crossfades, repeating them until ``total`` samples."""
    out = array("f")
    i = 0
    while len(out) < total and i < 10_000:  # bounded: never loop forever on degenerate input
        sec = sections[i % len(sections)]
        i += 1
        n = min(overlap, len(out), len(sec) // 2)
        if n == 0:
            out.extend(sec)
            continue
        fade_out, fade_in = _equal_power(n)
        tail = out[-n:]
        del out[-n:]
        out.extend(array("f", (tail[j] * fade_out[j] + sec[j] * fade_in[j] for j in range(n))))
        out.extend(sec[n:])
    return out[:total]


def make_loopable(x: Samples, overlap: int) -> Samples:
    """Crossfade the tail into the head so the clip loops without a click."""
    n = min(overlap, len(x) // 4)
    if n <= 0:
        return x
    fade_out, fade_in = _equal_power(n)
    head = array("f", (x[j] * fade_in[j] + x[len(x) - n + j] * fade_out[j] for j in range(n)))
    return head + x[n : len(x) - n]


def fade_edges(x: Samples, sr: int, fade_in: float, fade_out: float) -> Samples:
    x = array("f", x)
    a, b = min(len(x), int(fade_in * sr)), min(len(x), int(fade_out * sr))
    for j in range(a):
        x[j] *= j / a
    for j in range(b):
        x[len(x) - 1 - j] *= j / b
    return x


def limit_peak(x: Samples, ceiling: float = 0.891) -> Samples:
    """Scale down so the peak sits at ``ceiling`` (default -1 dBFS); never boosts."""
    peak = max((abs(v) for v in x), default=0.0)
    if peak <= ceiling:
        return x
    g = ceiling / peak
    return array("f", (v * g for v in x))


class StableAudioModel(Model[AudioRequest]):
    """Serves catalog entries of kind ``music`` or ``sfx`` (SFX entries also serve ambience)."""

    def __init__(self, entry: CatalogEntry, cache_dir: Path | None) -> None:
        super().__init__()
        self.entry = entry
        self.params = entry.params
        self.cache_dir = cache_dir
        self.info = info_from(entry, "cuda")
        self.pipe: Any = None
        self.torch: Any = None

    def load(self, ctx: JobContext) -> None:
        torch = require("torch")
        diffusers = require("diffusers")
        if self.entry.min_vram_gb > 0 and not cuda_available(torch):
            raise JobError(
                "CUDA_UNAVAILABLE",
                f"{self.entry.id} needs an NVIDIA GPU with CUDA (≥ {self.entry.min_vram_gb} GB VRAM). "
                "Leave music / ambience out (they are optional), install the GPU runtime (System Health), or use CLOUD GPU.",
            )
        ctx.log(f"loading {self.entry.repo}@{self.entry.revision}")
        try:
            pipe = diffusers.StableAudioPipeline.from_pretrained(
                self.entry.repo,
                revision=self.entry.revision or None,
                torch_dtype=torch_dtype(torch, self.params.get("dtype", "float16")),
                cache_dir=str(self.cache_dir) if self.cache_dir else None,
            )
        except (OSError, ValueError) as exc:
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.repo}: {exc}") from exc
        if cuda_available(torch):
            pipe = pipe.to("cuda")
        self.pipe, self.torch = pipe, torch
        self.loaded = True

    def unload(self) -> None:
        self.pipe = None
        if self.torch is not None and cuda_available(self.torch):
            self.torch.cuda.empty_cache()
        self.loaded = False

    def _generate(self, ctx: JobContext, prompt: str, negative: str, seconds: float, seed: int) -> Samples:
        steps = int(self.params.get("num_inference_steps", 100))
        device = "cuda" if cuda_available(self.torch) else "cpu"

        def callback(step: int, _timestep: Any, _latents: Any) -> None:
            ctx.check()
            ctx.job.progress = min(0.95, (step + 1) / max(1, steps))

        kwargs = {
            "prompt": prompt,
            "negative_prompt": negative or None,
            "audio_end_in_s": seconds,
            "num_inference_steps": steps,
            "guidance_scale": float(self.params.get("guidance_scale", 7.0)),
            "num_waveforms_per_prompt": 1,
            "generator": self.torch.Generator(device).manual_seed(seed),
            "callback": callback,
            "callback_steps": 1,
        }
        try:
            with track_vram(self.torch, ctx):
                result = self.pipe(**supported_kwargs(self.pipe.__call__, kwargs))
        except Exception as exc:
            if type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower():
                raise JobError("OUT_OF_MEMORY", f"{self.entry.id}: out of GPU memory") from exc
            raise
        return to_mono(result.audios[0])

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        if request.kind not in ("music", "sfx", "ambience"):
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id} generates music, SFX and ambience, not {request.kind}")
        sr = int(getattr(getattr(self.pipe, "vae", None), "sampling_rate", 0) or self.params.get("sample_rate", 44_100))
        max_section = float(self.params.get("max_section_sec", 47.0))
        prompt, negative = build_prompt(request, self.params)
        ctx.log(f"prompt: {prompt}")
        want = request.duration_sec
        total = max(1, round(want * sr))
        overlap = int(float(self.params.get("crossfade_sec", 1.0)) * sr)
        if want <= max_section:
            # Loopable ambience needs extra material for the tail→head crossfade.
            extra = overlap / sr if request.loopable else 0.0
            audio = self._generate(ctx, prompt, negative, min(max_section, want + extra), request.seed)
            if request.loopable:
                audio = make_loopable(audio, overlap)
            audio = audio[:total]
        else:
            count = int(self.params.get("max_sections", 3))
            sections: list[Samples] = []
            for k in range(count):
                ctx.set_status("running", f"section {k + 1}/{count}")
                sections.append(self._generate(ctx, prompt, negative, max_section, request.seed + k))
            audio = tile(sections, total, overlap)
            ctx.log(f"{want:.1f}s requested: tiled {count} × {max_section:.0f}s sections with {overlap / sr:.1f}s crossfades")
        if request.kind == "music":
            audio = fade_edges(audio, sr, 0.05, min(1.5, want / 4))
        elif request.kind == "sfx":
            audio = fade_edges(audio, sr, 0.0, min(0.1, want / 4))
        audio = limit_peak(audio)
        write_wav_samples(ctx.path("audio.wav"), audio, sr)
        ctx.add_output("audio.wav", "audio/wav", duration_sec=round(len(audio) / sr, 3))
