"""Shared helpers for real model adapters."""

from __future__ import annotations

import importlib
import inspect
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..models.base import ModelInfo

INSTALL_HINT = {
    "torch": "pip install torch --index-url https://download.pytorch.org/whl/cu124",
    "diffusers": "pip install diffusers transformers accelerate sentencepiece",
    "PIL": "pip install pillow",
    "kokoro": "pip install kokoro soundfile",
    "chatterbox": "pip install chatterbox-tts",
}


def require(module: str) -> Any:
    """Import a heavy dependency on demand, with an actionable error when it is missing."""
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        hint = INSTALL_HINT.get(module.split(".")[0], f"pip install {module.split('.')[0]}")
        raise JobError("MODEL_LOAD_FAILED", f"missing dependency '{module}' ({hint})") from exc


def info_from(entry: CatalogEntry, device: str) -> ModelInfo:
    return ModelInfo(
        id=entry.id,
        kind=entry.kind,  # type: ignore[arg-type]
        display_name=entry.display_name or entry.id,
        version=entry.revision or "n/a",
        license=entry.license,
        min_vram_gb=entry.min_vram_gb,
        device="cuda" if device == "cuda" else "cpu",
        mock=False,
        commercial_use=entry.commercial_use,
        license_url=entry.license_url,
    )


def supported_kwargs(fn: Callable[..., Any], kwargs: dict[str, Any]) -> dict[str, Any]:
    """Keep only arguments the pipeline's __call__ accepts (pipelines differ: FLUX has no negative_prompt, etc.)."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return {k: v for k, v in kwargs.items() if v is not None}
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return {k: v for k, v in kwargs.items() if v is not None}
    return {k: v for k, v in kwargs.items() if v is not None and k in params}


def snap(value: float, multiple: int, minimum: int | None = None) -> int:
    m = max(1, multiple)
    return max(minimum if minimum is not None else m, round(value / m) * m)


def fit_size(width: int, height: int, max_side: int | None, multiple: int) -> tuple[int, int]:
    """Largest size with the requested aspect ratio within ``max_side``, snapped to the model's multiple."""
    scale = min(1.0, (max_side or max(width, height)) / max(width, height))
    return snap(width * scale, multiple), snap(height * scale, multiple)


def torch_dtype(torch: Any, name: str | None) -> Any:
    dtype = getattr(torch, name or "bfloat16", None)
    if dtype is None:
        raise JobError("MODEL_LOAD_FAILED", f"unknown dtype {name!r}")
    return dtype


def cuda_available(torch: Any) -> bool:
    try:
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


@contextmanager
def track_vram(torch: Any, ctx: JobContext) -> Iterator[None]:
    """Record peak CUDA memory for the job (benchmarks compare this across models)."""
    use = cuda_available(torch)
    if use:
        torch.cuda.reset_peak_memory_stats()
    try:
        yield
    finally:
        if use:
            ctx.job.metrics["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1)


def step_callback(ctx: JobContext, total_steps: int) -> Callable[..., Any]:
    """diffusers ``callback_on_step_end``: progress + cooperative cancellation between steps."""

    def callback(pipe: Any, step: int, timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
        ctx.check()
        ctx.job.progress = min(0.95, (step + 1) / max(1, total_steps))
        return callback_kwargs

    return callback


def to_floats(audio: Any) -> list[float]:
    """Convert a numpy array / torch tensor / list of samples into a flat list of floats."""
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu()
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    flat: list[float] = []

    def walk(x: Any) -> None:
        if isinstance(x, (list, tuple)):
            for y in x:
                walk(y)
        else:
            flat.append(float(x))

    walk(audio)
    return flat
