"""Upscalers: FFmpeg resampling (non-AI baseline) and AI super-resolution via spandrel."""

from __future__ import annotations

import io
import shutil
from pathlib import Path
from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..media import MediaTools
from ..models.base import Model
from ..schemas import UpscaleRequest, sniff
from .common import cuda_available, info_from, require, track_vram

ALLOWED_FLAGS = {"lanczos", "bicubic", "spline", "bilinear"}


class FfmpegUpscaler(Model[UpscaleRequest]):
    def __init__(self, entry: CatalogEntry, media: MediaTools) -> None:
        super().__init__()
        self.entry = entry
        self.media = media
        self.info = info_from(entry, "cpu")
        flags = str(entry.params.get("flags", "lanczos"))
        if flags not in ALLOWED_FLAGS:
            raise ValueError(f"unsupported scaler flags {flags!r}")
        self.flags = flags

    def run(self, request: UpscaleRequest, ctx: JobContext) -> None:
        kind = sniff(request.source)
        w, h = request.target_width - request.target_width % 2, request.target_height - request.target_height % 2
        if kind == "png":
            ctx.path("source.png").write_bytes(request.source)
            self.media.scale_image(ctx, ctx.path("source.png"), ctx.path("upscaled.png"), width=w, height=h, flags=self.flags)
            ctx.add_output("upscaled.png", "image/png", width=w, height=h, native_resolution=False)
        elif kind == "mp4":
            ctx.path("source.mp4").write_bytes(request.source)
            self.media.scale_video(ctx, ctx.path("source.mp4"), ctx.path("upscaled.mp4"), width=w, height=h, flags=self.flags)
            ctx.add_output("upscaled.mp4", "video/mp4", width=w, height=h, native_resolution=False)
        else:
            raise JobError("UPSCALE_FAILED", "the FFmpeg upscaler needs a PNG or MP4 source")


def tile_plan(width: int, height: int, tile: int, pad: int) -> list[tuple[tuple[int, int, int, int], tuple[int, int, int, int]]]:
    """Split an image into tiles for memory-bounded upscaling.

    Returns ``(padded_box, inner_box)`` pairs as ``(y0, y1, x0, x1)`` in source
    pixels: the model sees the padded box (context avoids seams) and only the
    inner box is kept. Inner boxes cover the image exactly once.
    """
    tile = max(16, tile)
    plan = []
    for iy0 in range(0, height, tile):
        for ix0 in range(0, width, tile):
            iy1, ix1 = min(height, iy0 + tile), min(width, ix0 + tile)
            padded = (max(0, iy0 - pad), min(height, iy1 + pad), max(0, ix0 - pad), min(width, ix1 + pad))
            plan.append((padded, (iy0, iy1, ix0, ix1)))
    return plan


class SpandrelUpscaler(Model[UpscaleRequest]):
    """AI super-resolution (Real-ESRGAN, SwinIR, … weights) loaded with ``spandrel``.

    Weights are never downloaded implicitly from an arbitrary URL: point
    ``params.weights_file`` at a local file you fetched after checking its
    licence, or set ``params.hf_filename`` to fetch it from the entry's
    Hugging Face ``repo``. The x2/x4 result is resized to the exact target
    with Lanczos. Output is always marked as NOT native resolution.
    """

    def __init__(self, entry: CatalogEntry, cache_dir: Path | None, media: MediaTools) -> None:
        super().__init__()
        self.entry = entry
        self.params = entry.params
        self.cache_dir = cache_dir
        self.media = media
        self.info = info_from(entry, "cuda")
        self.model: Any = None
        self.torch: Any = None
        self.device = "cpu"
        self.half = False

    def _weights(self) -> Path:
        local = self.params.get("weights_file")
        if local:
            path = Path(str(local)).expanduser()
            if not path.is_file():
                raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id}: weights file not found: {path}")
            return path
        filename = self.params.get("hf_filename")
        if self.entry.repo and filename:
            hub = require("huggingface_hub")
            return Path(
                hub.hf_hub_download(
                    repo_id=self.entry.repo,
                    filename=str(filename),
                    revision=self.entry.revision or None,
                    cache_dir=str(self.cache_dir) if self.cache_dir else None,
                )
            )
        raise JobError(
            "MODEL_LOAD_FAILED",
            f"{self.entry.id}: set params.weights_file (a local .pth/.safetensors whose licence you checked) or params.hf_filename",
        )

    def load(self, ctx: JobContext) -> None:
        torch = require("torch")
        spandrel = require("spandrel")
        require("PIL.Image")
        if self.entry.min_vram_gb > 0 and not cuda_available(torch):
            raise JobError(
                "CUDA_UNAVAILABLE",
                f"{self.entry.id} needs an NVIDIA GPU with CUDA (≥ {self.entry.min_vram_gb} GB VRAM). Use the FFmpeg "
                "upscaler, install the GPU runtime (System Health), or use CLOUD GPU.",
            )
        path = self._weights()
        ctx.log(f"loading upscaler weights {path.name}")
        try:
            desc = spandrel.ModelLoader().load_from_file(str(path))
        except Exception as exc:
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id}: {exc}") from exc
        if not isinstance(desc, spandrel.ImageModelDescriptor) or getattr(desc, "purpose", "SR") != "SR":
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id}: {path.name} is not a single-image super-resolution model")
        self.device = "cuda" if cuda_available(torch) else "cpu"
        desc.to(self.device).eval()
        self.half = bool(self.params.get("half", True)) and self.device == "cuda" and bool(getattr(desc, "supports_half", False))
        if self.half:
            desc.half()
        self.model, self.torch = desc, torch
        self.loaded = True

    def unload(self) -> None:
        self.model = None
        if self.torch is not None and cuda_available(self.torch):
            self.torch.cuda.empty_cache()
        self.loaded = False

    def _upscale_png(self, ctx: JobContext, src: Path, out: Path) -> tuple[int, int]:
        torch, image_mod = self.torch, require("PIL.Image")
        img = image_mod.open(io.BytesIO(src.read_bytes())).convert("RGB")
        w, h = img.size
        t = torch.frombuffer(bytearray(img.tobytes()), dtype=torch.uint8).reshape(h, w, 3).permute(2, 0, 1).unsqueeze(0)
        t = t.to(self.device).float().div(255)
        if self.half:
            t = t.half()
        s = int(self.model.scale)
        result = torch.zeros((1, 3, h * s, w * s), device=self.device, dtype=t.dtype)
        plan = tile_plan(w, h, int(self.params.get("tile", 512)), int(self.params.get("tile_pad", 16)))
        with torch.inference_mode(), track_vram(torch, ctx):
            for (y0, y1, x0, x1), (iy0, iy1, ix0, ix1) in plan:
                ctx.check()
                part = self.model(t[:, :, y0:y1, x0:x1])
                result[:, :, iy0 * s : iy1 * s, ix0 * s : ix1 * s] = part[
                    :, :, (iy0 - y0) * s : (iy1 - y0) * s, (ix0 - x0) * s : (ix1 - x0) * s
                ]
        pixels = result.clamp(0, 1).mul(255).round().byte().squeeze(0).permute(1, 2, 0).contiguous().cpu()
        image_mod.frombytes("RGB", (w * s, h * s), pixels.numpy().tobytes()).save(out)
        return w * s, h * s

    def run(self, request: UpscaleRequest, ctx: JobContext) -> None:
        kind = sniff(request.source)
        w, h = request.target_width - request.target_width % 2, request.target_height - request.target_height % 2
        try:
            if kind == "png":
                ctx.path("source.png").write_bytes(request.source)
                self._upscale_png(ctx, ctx.path("source.png"), ctx.path("ai.png"))
                self.media.scale_image(ctx, ctx.path("ai.png"), ctx.path("upscaled.png"), width=w, height=h)
                ctx.add_output("upscaled.png", "image/png", width=w, height=h, native_resolution=False)
            elif kind == "mp4":
                ctx.path("source.mp4").write_bytes(request.source)
                frames, upscaled = ctx.path("frames"), ctx.path("frames_up")
                fps = self.media.video_to_frames(ctx, ctx.path("source.mp4"), frames)
                upscaled.mkdir(exist_ok=True)
                names = sorted(p.name for p in frames.glob("frame_*.png"))
                for i, name in enumerate(names):
                    self._upscale_png(ctx, frames / name, upscaled / name)
                    ctx.job.progress = min(0.95, (i + 1) / max(1, len(names)))
                self.media.frames_to_clip(ctx, upscaled, ctx.path("ai.mp4"), in_fps=fps, out_fps=max(1, round(fps)))
                self.media.scale_video(ctx, ctx.path("ai.mp4"), ctx.path("upscaled.mp4"), width=w, height=h)
                ctx.add_output("upscaled.mp4", "video/mp4", width=w, height=h, native_resolution=False)
            else:
                raise JobError("UPSCALE_FAILED", "the AI upscaler needs a PNG or MP4 source")
        except Exception as exc:
            if type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower():
                raise JobError("OUT_OF_MEMORY", f"{self.entry.id}: out of GPU memory (lower params.tile)") from exc
            raise
        finally:
            for d in ("frames", "frames_up"):
                shutil.rmtree(ctx.path(d), ignore_errors=True)
