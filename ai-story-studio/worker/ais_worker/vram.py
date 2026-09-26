"""GPU memory planning for real models (LOCAL GPU and cloud).

Before a job runs, the worker estimates how much VRAM it needs and compares it
with what is free (capped by the app's "Max VRAM usage" setting). It then picks
the lightest memory configuration that fits, in this order:

  1. everything on the GPU                       (fastest)
  2. model CPU offload  (components move to the GPU one at a time)
  3. sequential CPU offload (layers stream to the GPU; lowest VRAM, slowest)

VAE tiling / slicing and attention slicing are switched on where they help.
None of these change the picture. Lower resolution or fewer frames DO change
it, so they are only used when the app allows quality reduction — and every
change is recorded on the job. If nothing fits, the job fails with
INSUFFICIENT_VRAM and says what to do.

Estimates are approximate planning values (catalog min_vram_gb at a reference
size, scaled by pixels × frames). Real peaks are measured and reported
(peak_vram_mb) so the app can learn better estimates from benchmarks.
"""

from __future__ import annotations

import gc
import logging
from dataclasses import dataclass, field
from typing import Any

from .catalog import CatalogEntry

log = logging.getLogger("ais_worker.vram")

OFFLOAD_LEVELS = ("none", "model", "sequential")
# Share of the no-offload requirement still needed on the GPU with each offload level.
OFFLOAD_FACTOR = {"none": 1.0, "model": 0.6}

# Reference sizes the catalog's min_vram_gb figures refer to.
REF_IMAGE_PIXELS = 1024 * 1024
REF_VIDEO_PIXEL_FRAMES = 1280 * 704 * 49


@dataclass(frozen=True)
class MemoryPolicy:
    max_vram_fraction: float = 0.9
    cpu_offload: str = "auto"  # auto | none | model | sequential
    vae_tiling: str = "auto"  # auto | on | off
    attention: str = "auto"  # auto | sdpa | slicing | off
    auto_unload: bool = True
    allow_quality_reduction: bool = False
    # False for requests that carry no policy (older apps, cloud): keep the catalog's cpu_offload flag.
    explicit: bool = False

    @classmethod
    def from_settings(cls, settings: dict[str, Any]) -> MemoryPolicy:
        raw = settings.get("memory")
        if not isinstance(raw, dict):
            return cls()

        def pick(key: str, allowed: tuple[str, ...], default: str) -> str:
            v = raw.get(key)
            return v if isinstance(v, str) and v in allowed else default

        frac = raw.get("max_vram_percent")
        return cls(
            max_vram_fraction=min(1.0, max(0.1, float(frac) / 100)) if isinstance(frac, (int, float)) else 0.9,
            cpu_offload=pick("cpu_offload", ("auto", *OFFLOAD_LEVELS), "auto"),
            vae_tiling=pick("vae_tiling", ("auto", "on", "off"), "auto"),
            attention=pick("attention", ("auto", "sdpa", "slicing", "off"), "auto"),
            auto_unload=raw.get("auto_unload") is not False,
            allow_quality_reduction=raw.get("allow_quality_reduction") is True,
            explicit=True,
        )


@dataclass
class MemoryPlan:
    offload: str
    vae_tiling: bool
    vae_slicing: bool
    attention_slicing: bool
    estimated_gb: float
    available_gb: float
    feasible: bool
    reason: str = ""
    adjustments: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "offload": self.offload,
            "vae_tiling": self.vae_tiling,
            "vae_slicing": self.vae_slicing,
            "attention_slicing": self.attention_slicing,
            "estimated_vram_gb": self.estimated_gb,
            "available_vram_gb": self.available_gb,
            "adjustments": list(self.adjustments),
        }


def estimate_vram_gb(entry: CatalogEntry, width: int, height: int, frames: int = 1) -> float:
    """Approximate VRAM (GB) to run ``entry`` fully on the GPU at this size."""
    base = float(entry.min_vram_gb or 0)
    if base <= 0:
        return 0.0
    weights = float(entry.params.get("weights_vram_gb") or base * 0.7)
    pixels = width * height * (max(1, frames) if entry.kind == "video" else 1)
    scale = pixels / (REF_VIDEO_PIXEL_FRAMES if entry.kind == "video" else REF_IMAGE_PIXELS)
    activations = (base - weights) * max(0.25, scale)
    return round(weights + activations, 1)


def plan_memory(
    entry: CatalogEntry,
    estimate_gb: float,
    free_gb: float | None,
    total_gb: float | None,
    policy: MemoryPolicy,
    *,
    video: bool = False,
    megapixels: float = 1.0,
) -> MemoryPlan:
    """Choose offload / tiling for a job. ``free_gb``/``total_gb`` None = unknown (no CUDA)."""
    legacy = "model" if entry.params.get("cpu_offload") else "none"
    if free_gb is None or total_gb is None:
        # No CUDA information: keep the catalog behaviour (the load itself reports a missing GPU).
        return MemoryPlan(legacy if not policy.explicit else "model", video, video, False, estimate_gb, 0.0, True)
    available = round(min(free_gb, total_gb * policy.max_vram_fraction), 1)
    offload_min = float(entry.offload_min_vram_gb or entry.min_vram_gb or 0)
    needed = {
        "none": estimate_gb,
        "model": round(estimate_gb * OFFLOAD_FACTOR["model"], 1),
        "sequential": round(min(offload_min, estimate_gb * 0.35), 1) if estimate_gb else 0.0,
    }
    if not policy.explicit:
        offload = legacy
    elif policy.cpu_offload != "auto":
        offload = policy.cpu_offload
    else:
        offload = next((lvl for lvl in OFFLOAD_LEVELS if needed[lvl] <= available), "sequential")
    feasible = needed[offload] <= available or estimate_gb == 0
    tiling = policy.vae_tiling == "on" or (policy.vae_tiling == "auto" and (video or megapixels > 1.6 or offload != "none"))
    slicing = policy.attention == "slicing" or (policy.attention == "auto" and offload == "sequential")
    plan = MemoryPlan(offload, tiling, tiling, slicing, estimate_gb, available, feasible)
    if offload != "none":
        plan.adjustments.append(f"CPU offload: {offload} (needs ~{needed[offload]} GB on the GPU, {available} GB available)")
    if not feasible:
        plan.reason = (
            f"{entry.id} needs about {needed[offload]} GB of GPU memory even with {offload} CPU offload, "
            f"but only {available} GB is available. Choose a lower quality preset, a lighter model, close other "
            "GPU programs, allow lower resolution in Settings, or use CLOUD GPU."
        )
    return plan


def cuda_memory(torch: Any) -> tuple[float | None, float | None]:
    """(free GB, total GB) of the current CUDA device, or (None, None) without CUDA."""
    try:
        if not torch.cuda.is_available():
            return None, None
        free, total = torch.cuda.mem_get_info()
        return round(free / 1024**3, 1), round(total / 1024**3, 1)
    except Exception:  # noqa: BLE001 - memory info is advisory
        return None, None


def release_cuda_memory(torch: Any) -> None:
    """Drop cached CUDA blocks after unloading (safe: never frees memory still in use)."""
    gc.collect()
    try:
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as exc:  # noqa: BLE001 - a failed cache flush never fails a job
        log.debug("empty_cache failed: %s", exc)


def resolve_params(entry: CatalogEntry, quality: str) -> dict[str, Any]:
    """Catalog params for a quality preset (FAST / OPTIMIZED / QUALITY)."""
    params = dict(entry.params)
    preset = entry.presets.get(quality)
    if preset:
        params.update(preset)
        return params
    steps = params.get("num_inference_steps")
    if isinstance(steps, (int, float)) and steps > 0:
        if quality == "fast_preview":
            params["num_inference_steps"] = max(2, round(steps * 0.5))
        elif quality == "high_quality":
            params["num_inference_steps"] = round(steps * 1.5)
    if quality == "fast_preview" and isinstance(params.get("max_side"), (int, float)):
        params["max_side"] = min(int(params["max_side"]), 1024)
    return params


def reduce_for_vram(max_side: int, frames: int, *, video: bool) -> tuple[int, int, str]:
    """One step of quality reduction: 25% smaller, and for video 25% fewer frames (min 480 px / 17 frames)."""
    new_side = max(480, int(max_side * 0.75))
    new_frames = max(17, int(frames * 0.75)) if video else frames
    change = f"max side {max_side}→{new_side} px" + (f", frames {frames}→{new_frames}" if video and new_frames != frames else "")
    return new_side, new_frames, change
