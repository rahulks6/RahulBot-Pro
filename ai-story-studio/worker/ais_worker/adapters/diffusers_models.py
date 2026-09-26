"""Hugging Face diffusers adapters: text-to-image and image-to-video.

Pipelines are loaded with ``DiffusionPipeline.from_pretrained`` (the model
card decides the concrete pipeline class), so the same adapter serves
FLUX-family, Qwen-Image, SDXL, Wan, LTX and future models. Only arguments a
pipeline accepts are passed. Requires: torch (CUDA build), diffusers,
transformers, accelerate, pillow.

Every job: quality preset → VRAM plan (vram.py) → load with the planned
offload / VAE tiling / attention slicing → generate. An out-of-memory error
is retried once with stronger CPU offload (slower, same picture). Everything
that was decided is recorded in ``job.details`` (the app stores it on the attempt).
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
from ..vram import (
    OFFLOAD_LEVELS,
    MemoryPlan,
    MemoryPolicy,
    cuda_memory,
    estimate_vram_gb,
    plan_memory,
    reduce_for_vram,
    release_cuda_memory,
    resolve_params,
)
from .common import cuda_available, fit_size, info_from, require, snap, step_callback, supported_kwargs, torch_dtype, track_vram

NOT_INSTALLED_HINTS = (
    "offline",
    "cannot find the requested files",
    "does not appear to have",
    "not found in the cache",
    "localentrynotfound",
)


def is_oom(exc: BaseException) -> bool:
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


def _try(fn: Any, *args: Any) -> bool:
    """Call an optional pipeline memory switch; some pipelines do not implement every one."""
    if fn is None:
        return False
    try:
        fn(*args)
        return True
    except (NotImplementedError, AttributeError, ValueError, TypeError):
        return False


class _DiffusersBase:
    """Load/unload, memory planning and generation shared by image and video adapters."""

    def __init__(self, entry: CatalogEntry, cache_dir: Path | None) -> None:
        self.entry = entry
        self.params = entry.params
        self.cache_dir = cache_dir
        self.pipe: Any = None
        self.torch: Any = None
        self.diffusers: Any = None
        self.img2img: Any = None
        self.policy = MemoryPolicy()
        self.memory: MemoryPlan | None = None
        self.loaded_config: tuple[str, bool, bool] | None = None
        self.ip_adapter_loaded = False

    # --- planning ------------------------------------------------------------------

    def _plan(self, ctx: JobContext, settings: dict[str, Any], w: int, h: int, frames: int, video: bool) -> MemoryPlan:
        self.policy = MemoryPolicy.from_settings(settings)
        torch = require("torch")
        free, total = cuda_memory(torch)
        estimate = estimate_vram_gb(self.entry, w, h, frames)
        plan = plan_memory(self.entry, estimate, free, total, self.policy, video=video, megapixels=w * h / 1e6)
        ctx.job.metrics["estimated_vram_gb"] = plan.estimated_gb
        if free is not None:
            ctx.job.metrics["vram_free_before_gb"] = free
        return plan

    def _reconfigure_if_needed(self, ctx: JobContext) -> None:
        """A different memory configuration needs a reload (offload hooks are set at load time)."""
        assert self.memory is not None
        want = (self.memory.offload, self.memory.vae_tiling, self.memory.attention_slicing)
        if self.pipe is not None and self.loaded_config is not None and self.loaded_config != want:
            ctx.log(f"reloading {self.entry.id} with CPU offload '{self.memory.offload}'")
            self._unload()
            self.loaded = False

    # --- load / unload -------------------------------------------------------------

    def _load(self, ctx: JobContext) -> None:
        torch = require("torch")
        diffusers = require("diffusers")
        if self.entry.min_vram_gb > 0 and not cuda_available(torch):
            raise JobError(
                "CUDA_UNAVAILABLE",
                f"{self.entry.id} needs an NVIDIA GPU with CUDA (≥ {self.entry.min_vram_gb} GB VRAM), but PyTorch cannot use "
                "one. Install the GPU runtime (System Health), update the NVIDIA driver, or use CLOUD GPU.",
            )
        ctx.log(f"loading {self.entry.repo}@{self.entry.revision}")
        # The model card decides the pipeline, unless the catalog names one explicitly
        # (e.g. WanImageToVideoPipeline for a model whose default pipeline is text-to-video).
        class_name = self.params.get("pipeline_class")
        loader = getattr(diffusers, str(class_name), None) if class_name else diffusers.DiffusionPipeline
        if loader is None:
            raise JobError("MODEL_LOAD_FAILED", f"diffusers has no pipeline class {class_name!r}; upgrade diffusers")
        kwargs: dict[str, Any] = {
            "revision": self.entry.revision or None,
            "torch_dtype": torch_dtype(torch, self.params.get("dtype")),
            "cache_dir": str(self.cache_dir) if self.cache_dir else None,
        }
        if self.params.get("variant"):
            kwargs["variant"] = str(self.params["variant"])
        try:
            pipe = loader.from_pretrained(self.entry.repo, **kwargs)
        except (OSError, ValueError) as exc:
            text = f"{type(exc).__name__} {exc}".lower()
            if any(h in text for h in NOT_INSTALLED_HINTS):
                raise JobError(
                    "MODEL_NOT_INSTALLED",
                    f"{self.entry.display_name or self.entry.id} is not installed (or its download is incomplete). "
                    "Install it in the Model Manager.",
                ) from exc
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.repo}: {exc}") from exc
        plan = self.memory
        offload = plan.offload if plan else ("model" if self.params.get("cpu_offload") else "none")
        if cuda_available(torch):
            if offload == "sequential" and _try(getattr(pipe, "enable_sequential_cpu_offload", None)):
                pass
            elif offload in ("model", "sequential"):
                pipe.enable_model_cpu_offload()
            else:
                pipe.to("cuda")
            if plan:
                vae = getattr(pipe, "vae", None)
                if plan.vae_tiling and not _try(getattr(vae, "enable_tiling", None)):
                    _try(getattr(pipe, "enable_vae_tiling", None))
                if plan.vae_slicing and not _try(getattr(vae, "enable_slicing", None)):
                    _try(getattr(pipe, "enable_vae_slicing", None))
                if plan.attention_slicing:
                    _try(getattr(pipe, "enable_attention_slicing", None))
        self.pipe, self.torch, self.diffusers = pipe, torch, diffusers
        self.loaded_config = (offload, bool(plan and plan.vae_tiling), bool(plan and plan.attention_slicing))
        self.ip_adapter_loaded = False

    def _unload(self) -> None:
        self.pipe = None
        self.img2img = None
        self.loaded_config = None
        self.ip_adapter_loaded = False
        release_cuda_memory(self.torch)

    # --- generation ----------------------------------------------------------------

    def _call(self, ctx: JobContext, kwargs: dict[str, Any], pipe: Any = None) -> Any:
        pipe = pipe if pipe is not None else self.pipe
        steps = int(kwargs.get("num_inference_steps") or 30)
        kwargs["callback_on_step_end"] = step_callback(ctx, steps)
        try:
            with track_vram(self.torch, ctx):
                return pipe(**supported_kwargs(pipe.__call__, kwargs))
        except Exception as exc:
            if is_oom(exc):
                raise JobError(
                    "OUT_OF_MEMORY",
                    f"{self.entry.id} ran out of GPU memory. Choose a lower quality preset, set CPU offload to "
                    "'sequential' in Settings, close other GPU programs, or use CLOUD GPU.",
                ) from exc
            raise

    def _generate_with_oom_retry(self, ctx: JobContext, run: Any) -> Any:
        """Run; after an out-of-memory error, reload once with the next CPU-offload level (auto only)."""
        try:
            return run()
        except JobError as exc:
            plan = self.memory
            can_escalate = (
                exc.code == "OUT_OF_MEMORY"
                and plan is not None
                and self.policy.explicit
                and self.policy.cpu_offload == "auto"
                and plan.offload != "sequential"
            )
            if not can_escalate:
                raise
            assert plan is not None
            nxt = OFFLOAD_LEVELS[OFFLOAD_LEVELS.index(plan.offload) + 1]
            plan.adjustments.append(f"out of memory with offload '{plan.offload}': retried with '{nxt}' (slower, same result)")
            ctx.log(plan.adjustments[-1])
            plan.offload = nxt
            plan.vae_tiling = plan.vae_slicing = True
            plan.attention_slicing = nxt == "sequential"
            self._unload()
            self._load(ctx)
            ctx.job.details["memory"] = plan.public()
            return run()


class DiffusersImageModel(_DiffusersBase, Model[ImageRequest]):
    def __init__(self, entry: CatalogEntry, cache_dir: Path | None) -> None:
        _DiffusersBase.__init__(self, entry, cache_dir)
        Model.__init__(self)
        self.info = info_from(entry, "cuda")
        self.run_params: dict[str, Any] = {}
        self.size: tuple[int, int] = (0, 0)

    def prepare(self, request: ImageRequest, ctx: JobContext) -> None:
        params = resolve_params(self.entry, request.quality)
        max_side = int(params.get("max_side") or max(request.width, request.height))
        multiple = int(params.get("dim_multiple", 16))
        w, h = fit_size(request.width, request.height, max_side, multiple)
        plan = self._plan(ctx, request.settings, w, h, 1, False)
        while not plan.feasible and self.policy.allow_quality_reduction and max_side > 512:
            max_side, _, change = reduce_for_vram(max_side, 1, video=False)
            w, h = fit_size(request.width, request.height, max_side, multiple)
            reduced = self._plan(ctx, request.settings, w, h, 1, False)
            reduced.adjustments.insert(0, f"quality reduced to fit VRAM: {change}")
            plan = reduced
        ctx.job.details["memory"] = plan.public()
        if not plan.feasible:
            raise JobError("INSUFFICIENT_VRAM", plan.reason)
        params["max_side"] = max_side
        self.run_params, self.size, self.memory = params, (w, h), plan
        self._reconfigure_if_needed(ctx)

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

    def _ensure_ip_adapter(self, ctx: JobContext) -> dict[str, Any]:
        cfg = self.params.get("ip_adapter")
        if not isinstance(cfg, dict) or not cfg.get("repo"):
            raise JobError("IMAGE_GENERATION_FAILED", f"{self.entry.id}: no IP-Adapter is configured for reference images")
        if not self.ip_adapter_loaded:
            loader = getattr(self.pipe, "load_ip_adapter", None)
            if loader is None:
                raise JobError("IMAGE_GENERATION_FAILED", f"{self.entry.id}: this pipeline cannot use an IP-Adapter")
            ctx.log(f"loading IP-Adapter {cfg['repo']}/{cfg.get('subfolder', '')}/{cfg.get('weight_name', '')}")
            try:
                loader(
                    str(cfg["repo"]),
                    subfolder=str(cfg.get("subfolder", "")),
                    weight_name=str(cfg.get("weight_name", "")),
                    image_encoder_folder=str(cfg.get("image_encoder_folder", "image_encoder")),
                    cache_dir=str(self.cache_dir) if self.cache_dir else None,
                )
            except (OSError, ValueError) as exc:
                raise JobError(
                    "MODEL_NOT_INSTALLED",
                    f"The IP-Adapter files for {self.entry.id} are missing. Install the model again in the Model Manager.",
                ) from exc
            self.ip_adapter_loaded = True
        return cfg

    def run(self, request: ImageRequest, ctx: JobContext) -> None:
        if not self.run_params:  # called without prepare (older callers)
            self.prepare(request, ctx)
        params = self.run_params
        w, h = self.size
        ctx.set_status("running", f"{self.entry.id} {w}x{h} seed {request.seed}")
        pil = require("PIL.Image")
        extra: dict[str, Any] = {}
        pipe = None
        mode = str(params.get("reference_mode", "img2img"))
        reference: dict[str, Any] = {"mode": "none", "images": 0}
        if request.reference_images and mode == "ip_adapter":
            # Identity from the approved character references, composition from the prompt.
            cfg = self._ensure_ip_adapter(ctx)
            scale = request.reference_strength or float(cfg.get("scale", 0.6))
            _try(getattr(self.pipe, "set_ip_adapter_scale", None), scale)
            images = [pil.open(io.BytesIO(b)).convert("RGB") for b in request.reference_images[:4]]
            extra = {"ip_adapter_image": images if len(images) > 1 else images[0]}
            reference = {"mode": "ip_adapter", "images": len(images), "scale": scale}
            ctx.log(f"character reference: IP-Adapter, {len(images)} image(s), scale {scale}")
        elif request.init_image is not None:
            # Reference-guided generation: start from the approved character reference so
            # palette, proportions and clothing carry over between scenes.
            strength = request.strength or float(params.get("img2img_strength", 0.75))
            extra = {"image": pil.open(io.BytesIO(request.init_image)).convert("RGB").resize((w, h)), "strength": strength}
            pipe = self._img2img_pipe()
            reference = {"mode": "img2img", "images": 1, "strength": strength}
            ctx.log(f"reference-guided (image-to-image), strength {strength}")
        elif self.ip_adapter_loaded:
            # The adapter stays loaded between jobs: neutral input at scale 0 = no influence.
            _try(getattr(self.pipe, "set_ip_adapter_scale", None), 0.0)
            extra = {"ip_adapter_image": pil.new("RGB", (224, 224), (127, 127, 127))} if hasattr(pil, "new") else {}
        ctx.job.details["reference"] = reference
        ctx.job.details["effective_params"] = {
            "quality": request.quality,
            "width": w,
            "height": h,
            "steps": params.get("num_inference_steps"),
            "guidance_scale": params.get("guidance_scale"),
            "seed": request.seed,
        }

        def generate() -> Any:
            generator = self.torch.Generator(device="cpu").manual_seed(request.seed)
            return self._call(
                ctx,
                {
                    **extra,
                    "prompt": request.prompt,
                    "negative_prompt": request.negative_prompt or None,
                    "width": w,
                    "height": h,
                    "num_inference_steps": params.get("num_inference_steps"),
                    "guidance_scale": params.get("guidance_scale"),
                    "true_cfg_scale": params.get("true_cfg_scale"),
                    "max_sequence_length": params.get("max_sequence_length"),
                    "generator": generator,
                },
                pipe if pipe is None else self._img2img_pipe(),
            )

        out = self._generate_with_oom_retry(ctx, generate)
        self.run_params = {}
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
        self.run_params: dict[str, Any] = {}
        self.shape: tuple[int, int, int, float] = (0, 0, 0, 24.0)

    def load(self, ctx: JobContext) -> None:
        self._load(ctx)
        self.loaded = True

    def unload(self) -> None:
        self._unload()
        self.loaded = False

    def plan(self, request: VideoRequest, params: dict[str, Any] | None = None) -> tuple[int, int, int, float]:
        """(width, height, frames, native_fps) respecting the model's constraints."""
        p = params if params is not None else self.params
        native_fps = float(p.get("native_fps", request.fps))
        k = int(p.get("frame_multiple", 1))
        frames = round(request.duration_sec * native_fps)
        if k > 1:
            frames = snap(frames - 1, k, k) + 1  # e.g. Wan/LTX want 4k+1 / 8k+1 frames
        w, h = fit_size(request.width, request.height, p.get("max_side"), int(p.get("dim_multiple", 16)))
        return w, h, frames, native_fps

    def prepare(self, request: VideoRequest, ctx: JobContext) -> None:
        params = resolve_params(self.entry, request.quality)
        w, h, frames, fps = self.plan(request, params)
        memory = self._plan(ctx, request.settings, w, h, frames, True)
        max_side = int(params.get("max_side") or max(w, h))
        while not memory.feasible and self.policy.allow_quality_reduction and max_side > 480:
            # Only the resolution is reduced: the clip length follows the shot's duration.
            max_side, _, change = reduce_for_vram(max_side, frames, video=False)
            params["max_side"] = max_side
            w, h, frames, fps = self.plan(request, params)
            reduced = self._plan(ctx, request.settings, w, h, frames, True)
            reduced.adjustments.insert(0, f"quality reduced to fit VRAM: {change}")
            memory = reduced
        ctx.job.details["memory"] = memory.public()
        if not memory.feasible:
            raise JobError("INSUFFICIENT_VRAM", memory.reason)
        self.run_params, self.shape, self.memory = params, (w, h, frames, fps), memory
        self._reconfigure_if_needed(ctx)

    def accepts_image(self) -> bool:
        import inspect

        try:
            params = inspect.signature(self.pipe.__call__).parameters
        except (TypeError, ValueError):
            return True
        return "image" in params or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())

    def run(self, request: VideoRequest, ctx: JobContext) -> None:
        pil = require("PIL.Image")
        if not self.run_params:
            self.prepare(request, ctx)
        if not self.accepts_image():
            # Never silently fall back to text-to-video: shots must start from the approved still
            # (image-first workflow = character consistency).
            raise JobError(
                "VIDEO_GENERATION_FAILED",
                f"{self.entry.id}: pipeline {type(self.pipe).__name__} has no image input; set params.pipeline_class "
                "to an image-to-video pipeline. Refusing to generate video without the approved still.",
            )
        params = self.run_params
        w, h, frames, native_fps = self.shape
        ctx.set_status("running", f"{self.entry.id} {w}x{h} {frames} frames @{native_fps}fps")
        image = pil.open(io.BytesIO(request.image)).convert("RGB").resize((w, h))
        prompt = request.motion_prompt or "subtle natural motion"
        if request.camera_movement and request.camera_movement.lower() not in prompt.lower():
            prompt = f"{prompt}; camera: {request.camera_movement}"
        extra: dict[str, Any] = {}
        motion = params.get("motion_param")
        if isinstance(motion, dict) and motion.get("name"):
            lo, hi = float(motion.get("min", 0)), float(motion.get("max", 1))
            value = lo + (hi - lo) * request.motion_strength
            extra[str(motion["name"])] = round(value) if motion.get("int", True) else value
        ctx.job.details["effective_params"] = {
            "quality": request.quality,
            "width": w,
            "height": h,
            "frames": frames,
            "native_fps": native_fps,
            "steps": params.get("num_inference_steps"),
            "motion_strength": request.motion_strength,
            "camera_movement": request.camera_movement,
            "seed": request.seed,
        }

        def generate() -> Any:
            generator = self.torch.Generator(device="cpu").manual_seed(request.seed)
            return self._call(
                ctx,
                {
                    **extra,
                    "image": image,
                    "prompt": prompt,
                    "negative_prompt": request.negative_prompt or None,
                    "width": w,
                    "height": h,
                    "num_frames": frames,
                    "num_inference_steps": params.get("num_inference_steps"),
                    "guidance_scale": params.get("guidance_scale"),
                    "generator": generator,
                    "output_type": "pil",
                },
            )

        out = self._generate_with_oom_retry(ctx, generate)
        self.run_params = {}
        video = out.frames[0]
        frames_dir = ctx.dir / "frames"
        frames_dir.mkdir(exist_ok=True)
        for i, frame in enumerate(video):
            ctx.check()
            frame.save(frames_dir / f"frame_{i:05d}.png")
        ctx.set_status("encoding", "encoding H.264")
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
