"""FFmpeg resampling upscaler: a real, deterministic, non-AI baseline for benchmarks."""

from __future__ import annotations

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..media import MediaTools
from ..models.base import Model
from ..schemas import UpscaleRequest, sniff
from .common import info_from

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
