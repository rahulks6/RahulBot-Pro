"""Hugging Face diffusers adapters: text-to-image and image-to-video.

Pipelines are loaded with ``DiffusionPipeline.from_pretrained`` (the model
card decides the concrete pipeline class), so the same adapter serves
FLUX-family, Qwen-Image, SDXL, Wan, LTX and future models. Only arguments a
pipeline accepts are passed. Requires: torch (CUDA build), diffusers,
transformers, accelerate, pillow.
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path
from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..media import MediaTools
from ..models.base import Model
from ..schemas import ImageRequest, VideoRequest
from .common import cuda_available, fit_size, info_from, require, snap, step_callback, supported_kwargs, torch_dtype, track_vram


class _DiffusersBase:
    """Load/unload shared by image and video adapters."""

    def __init__(self, entry: CatalogEntry, cache_dir: Path | None) -> None:
        self.entry = entry
        self.params = entry.params
        self.cache_dir = cache_dir
        self.pipe: Any = None
        self.torch: Any = None
        self.diffusers: Any = None
        self.img2img: Any = None

    def _load(self, ctx: JobContext) -> None:
        torch = require("torch")
        diffusers = require("diffusers")
        if self.entry.min_vram_gb > 0 and not cuda_available(torch):
            raise JobError("CUDA_FAILURE", f"{self.entry.id} needs a CUDA GPU (≥ {self.entry.min_vram_gb} GB VRAM)")
        ctx.log(f"loading {self.entry.repo}@{self.entry.revision}")
        # The model card decides the pipeline, unless the catalog names one explicitly
        # (e.g. WanImageToVideoPipeline for a model whose default pipeline is text-to-video).
        class_name = self.params.get("pipeline_class")
        loader = getattr(diffusers, str(class_name), None) if class_name else diffusers.DiffusionPipeline
        if loader is None:
            raise JobError("MODEL_LOAD_FAILED", f"diffusers has no pipeline class {class_name!r}; upgrade diffusers")
        try:
            pipe = loader.from_pretrained(
                self.entry.repo,
                revision=self.entry.revision or None,
                torch_dtype=torch_dtype(torch, self.params.get("dtype")),
                cache_dir=str(self.cache_dir) if self.cache_dir else None,
            )
        except (OSError, ValueError) as exc:
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.repo}: {exc}") from exc
        if cuda_available(torch):
            if self.params.get("cpu_offload"):
                pipe.enable_model_cpu_offload()
            else:
                pipe.to("cuda")
        self.pipe, self.torch, self.diffusers = pipe, torch, diffusers

    def _unload(self) -> None:
        self.pipe = None
        self.img2img = None
        if self.torch is not None and cuda_available(self.torch):
            self.torch.cuda.empty_cache()

    def _call(self, ctx: JobContext, kwargs: dict[str, Any], pipe: Any = None) -> Any:
        pipe = pipe if pipe is not None else self.pipe
        steps = int(kwargs.get("num_inference_steps") or 30)
        kwargs["callback_on_step_end"] = step_callback(ctx, steps)
        try:
            with track_vram(self.torch, ctx):
                return pipe(**supported_kwargs(pipe.__call__, kwargs))
        except Exception as exc:
            if type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower():
                raise JobError("OUT_OF_MEMORY", f"{self.entry.id}: out of GPU memory") from exc
            raise


class DiffusersImageModel(_DiffusersBase, Model[ImageRequest]):
    def __init__(self, entry: CatalogEntry, cache_dir: Path | None) -> None:
        _DiffusersBase.__init__(self, entry, cache_dir)
        Model.__init__(self)
        self.info = info_from(entry, "cuda")

    def load(self, ctx: JobContext) -> None:
        self._load(ctx)
        self.loaded = True

    def unload(self) -> None:
        self._unload()
        self.loaded = False

    def _img2img_pipe(self) -> Any:
        if self.img2img is None:
            auto = getattr(self.diffusers, "AutoPipelineForImage2Image", None)
            if auto is None:
                raise JobError("IMAGE_GENERATION_FAILED", "this diffusers version has no AutoPipelineForImage2Image")
            try:
                self.img2img = auto.from_pipe(self.pipe)
            except Exception as exc:
                raise JobError(
                    "IMAGE_GENERATION_FAILED", f"{self.entry.id}: image-to-image is not available for this model ({exc})"
                ) from exc
        return self.img2img

    def run(self, request: ImageRequest, ctx: JobContext) -> None:
        w, h = fit_size(request.width, request.height, self.params.get("max_side"), int(self.params.get("dim_multiple", 16)))
        ctx.set_status("running", f"{self.entry.id} {w}x{h} seed {request.seed}")
        generator = self.torch.Generator(device="cpu").manual_seed(request.seed)
        extra: dict[str, Any] = {}
        pipe = None
        if request.init_image is not None:
            # Reference-guided generation: start from the approved character reference so
            # palette, proportions and clothing carry over between scenes.
            pil = require("PIL.Image")
            strength = request.strength or float(self.params.get("img2img_strength", 0.75))
            extra = {"image": pil.open(io.BytesIO(request.init_image)).convert("RGB").resize((w, h)), "strength": strength}
            pipe = self._img2img_pipe()
            ctx.log(f"reference-guided (image-to-image), strength {strength}")
        out = self._call(
            ctx,
            {
                **extra,
                "prompt": request.prompt,
                "negative_prompt": request.negative_prompt or None,
                "width": w,
                "height": h,
                "num_inference_steps": self.params.get("num_inference_steps"),
                "guidance_scale": self.params.get("guidance_scale"),
                "true_cfg_scale": self.params.get("true_cfg_scale"),
                "max_sequence_length": self.params.get("max_sequence_length"),
                "generator": generator,
            },
            pipe,
        )
        image = out.images[0]
        image.save(ctx.path("image.png"))
        ctx.add_output(
            "image.png",
            "image/png",
            width=image.width,
            height=image.height,
            native_resolution=(image.width, image.height) == (request.width, request.height),
        )


class DiffusersImageToVideoModel(_DiffusersBase, Model[VideoRequest]):
    def __init__(self, entry: CatalogEntry, cache_dir: Path | None, media: MediaTools) -> None:
        _DiffusersBase.__init__(self, entry, cache_dir)
        Model.__init__(self)
        self.info = info_from(entry, "cuda")
        self.media = media

    def load(self, ctx: JobContext) -> None:
        self._load(ctx)
        self.loaded = True

    def unload(self) -> None:
        self._unload()
        self.loaded = False

    def plan(self, request: VideoRequest) -> tuple[int, int, int, float]:
        """(width, height, frames, native_fps) respecting the model's constraints."""
        native_fps = float(self.params.get("native_fps", request.fps))
        k = int(self.params.get("frame_multiple", 1))
        frames = round(request.duration_sec * native_fps)
        if k > 1:
            frames = snap(frames - 1, k, k) + 1  # e.g. Wan/LTX want 4k+1 / 8k+1 frames
        w, h = fit_size(request.width, request.height, self.params.get("max_side"), int(self.params.get("dim_multiple", 16)))
        return w, h, frames, native_fps

    def accepts_image(self) -> bool:
        import inspect

        try:
            params = inspect.signature(self.pipe.__call__).parameters
        except (TypeError, ValueError):
            return True
        return "image" in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())

    def run(self, request: VideoRequest, ctx: JobContext) -> None:
        pil = require("PIL.Image")
        if not self.accepts_image():
            # Never silently fall back to text-to-video: shots must start from the approved still
            # (image-first workflow = character consistency).
            raise JobError(
                "VIDEO_GENERATION_FAILED",
                f"{self.entry.id}: pipeline {type(self.pipe).__name__} has no image input; set params.pipeline_class "
                "to an image-to-video pipeline. Refusing to generate video without the approved still.",
            )
        w, h, frames, native_fps = self.plan(request)
        ctx.set_status("running", f"{self.entry.id} {w}x{h} {frames} frames @{native_fps}fps")
        image = pil.open(io.BytesIO(request.image)).convert("RGB").resize((w, h))
        generator = self.torch.Generator(device="cpu").manual_seed(request.seed)
        out = self._call(
            ctx,
            {
                "image": image,
                "prompt": request.motion_prompt or "subtle natural motion",
                "negative_prompt": request.negative_prompt or None,
                "width": w,
                "height": h,
                "num_frames": frames,
                "num_inference_steps": self.params.get("num_inference_steps"),
                "guidance_scale": self.params.get("guidance_scale"),
                "generator": generator,
                "output_type": "pil",
            },
        )
        video = out.frames[0]
        frames_dir = ctx.dir / "frames"
        frames_dir.mkdir(exist_ok=True)
        for i, frame in enumerate(video):
            ctx.check()
            frame.save(frames_dir / f"frame_{i:05d}.png")
        ctx.set_status("running", "encoding H.264")
        self.media.frames_to_clip(ctx, frames_dir, ctx.path("clip.mp4"), in_fps=native_fps, out_fps=request.fps)
        shutil.rmtree(frames_dir, ignore_errors=True)
        duration = round(len(video) / native_fps, 3)
        ctx.add_output(
            "clip.mp4",
            "video/mp4",
            width=w,
            height=h,
            duration_sec=duration,
            fps=request.fps,
            native_resolution=(w, h) == (request.width, request.height),
        )
