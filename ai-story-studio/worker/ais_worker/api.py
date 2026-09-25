"""Framework-independent worker API.

``WorkerAPI.handle`` implements every endpoint; the stdlib HTTP server
(``server.py``) and the FastAPI adapter (``fastapi_app.py``) are thin shells
around it, so both behave identically and the logic is testable without a
web framework.

Endpoints (all require ``Authorization: Bearer <token>`` except /health):
  GET  /health                     liveness: {"status": "ok"} only
  GET  /models                     installed models, loaded state
  GET  /system                     GPU / VRAM / CUDA / disk / FFmpeg / models / version / jobs
  POST /generate/image             text-to-image (or image-to-image)
  POST /generate/image-to-video    animate an approved still
  POST /generate/audio             tts | music | sfx | ambience
  POST /process/lipsync            dialogue audio + clip → synced clip
  POST /process/upscale            image or clip upscaling
  GET  /jobs                       recent jobs
  GET  /jobs/{id}                  status, progress, outputs, metrics, errors
  POST /jobs/{id}/cancel           cancel queued or running job
  GET  /jobs/{id}/files/{name}     download an output file
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import __version__
from .catalog import CatalogEntry, LicenseError, check_license, load_catalog
from .config import WorkerConfig
from .diagnostics import system_report
from .jobs import JobContext, JobError, JobManager
from .media import MediaTools
from .models.base import Model, ModelKind
from .models.mock import MockAudioModel, MockImageModel, MockLipSyncModel, MockUpscaler, MockVideoModel
from .models.registry import ModelRegistry
from .schemas import ValidationError, parse_audio, parse_image, parse_lipsync, parse_upscale, parse_video
from .security import SecurityError, check_bearer, validate_output_name

log = logging.getLogger("ais_worker.api")


@dataclass
class Response:
    status: int
    body: dict[str, Any] | None = None
    file: Path | None = None
    mime: str = "application/json"
    headers: dict[str, str] = field(default_factory=dict)


def build_registry(config: WorkerConfig, media: MediaTools) -> tuple[ModelRegistry, list[dict[str, str]]]:
    """Register mock models (if enabled) and enabled catalog entries that pass the licence gate.

    Returns the registry and a list of catalog entries that were NOT registered, with the reason.
    """
    registry = ModelRegistry()
    skipped: list[dict[str, str]] = []
    if config.mock_models:
        registry.register(MockImageModel())
        registry.register(MockVideoModel(media))
        registry.register(MockAudioModel("tts"))
        registry.register(MockAudioModel("music"))
        registry.register(MockAudioModel("sfx"))
        registry.register(MockLipSyncModel(media))
        registry.register(MockUpscaler(media))
    if config.models_file is None:
        return registry, skipped
    for entry in load_catalog(config.models_file):
        if not entry.enabled:
            skipped.append({"id": entry.id, "reason": "disabled in catalog"})
            continue
        try:
            check_license(entry, config.allow_noncommercial)
        except LicenseError as exc:
            skipped.append({"id": entry.id, "reason": str(exc)})
            continue
        model = make_adapter(entry, config, media)
        if model is None:
            skipped.append({"id": entry.id, "reason": f"no adapter for '{entry.adapter}' yet"})
            continue
        registry.register(model, default=entry.default)
    return registry, skipped


def make_adapter(entry: CatalogEntry, config: WorkerConfig, media: MediaTools) -> Model[Any] | None:
    # Imported here so the worker starts without heavy optional packages.
    from .adapters.diffusers_models import DiffusersImageModel, DiffusersImageToVideoModel
    from .adapters.tts import ChatterboxTts, KokoroTts
    from .adapters.upscale import FfmpegUpscaler

    cache = config.model_cache_dir
    if entry.adapter == "diffusers_image":
        return DiffusersImageModel(entry, cache)
    if entry.adapter == "diffusers_i2v":
        return DiffusersImageToVideoModel(entry, cache, media)
    if entry.adapter == "kokoro_tts":
        return KokoroTts(entry)
    if entry.adapter == "chatterbox_tts":
        return ChatterboxTts(entry)
    if entry.adapter == "ffmpeg_upscale":
        return FfmpegUpscaler(entry, media)
    return None


class WorkerAPI:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self.media = MediaTools(config.ffmpeg_path, config.ffprobe_path)
        self.registry, self.catalog_skipped = build_registry(config, self.media)
        self.jobs = JobManager(config.jobs_dir, config.max_concurrent_jobs, config.job_timeout_seconds, config.max_jobs_kept)

    def close(self) -> None:
        self.jobs.shutdown()

    # ------------------------------------------------------------------------------

    def handle(self, method: str, path: str, headers: dict[str, str], body: bytes) -> Response:
        try:
            if len(body) > self.config.max_upload_bytes * 2:
                raise SecurityError(413, "request body too large")
            if method == "GET" and path == "/health":
                return Response(200, {"status": "ok", "version": __version__})
            check_bearer(headers.get("authorization"), self.config.auth_token)
            return self._route(method, path, body)
        except SecurityError as exc:
            return Response(exc.status, {"error": {"code": "FORBIDDEN" if exc.status != 404 else "NOT_FOUND", "message": str(exc)}})
        except JobError as exc:
            return Response(409, {"error": {"code": exc.code, "message": str(exc)}})
        except ValidationError as exc:
            return Response(422, {"error": {"code": "VALIDATION_FAILED", "message": "invalid request", "details": exc.errors}})
        except Exception:
            log.exception("request failed")
            return Response(500, {"error": {"code": "INTERNAL", "message": "internal worker error"}})

    def _route(self, method: str, path: str, body: bytes) -> Response:
        if method == "GET":
            if path == "/models":
                return Response(
                    200,
                    {"models": self.registry.describe(), "mock_only": self.registry.all_mock(), "catalog_skipped": self.catalog_skipped},
                )
            if path == "/system":
                return Response(200, self.system())
            if path == "/jobs":
                return Response(200, {"jobs": [j.public() for j in self.jobs.list()]})
            if m := re.fullmatch(r"/jobs/([^/]+)", path):
                return Response(200, self.jobs.get(m.group(1)).public())
            if m := re.fullmatch(r"/jobs/([^/]+)/files/([^/]+)", path):
                name = validate_output_name(m.group(2))
                file = self.jobs.output_path(m.group(1), name)
                mime = next(o.mime for o in self.jobs.get(m.group(1)).outputs if o.name == name)
                return Response(200, file=file, mime=mime)
        if method == "POST":
            if m := re.fullmatch(r"/jobs/([^/]+)/cancel", path):
                return Response(200, self.jobs.cancel(m.group(1)).public())
            if path == "/benchmarks":
                return self.submit_benchmark(self._json(body))
            handler = self._generators().get(path)
            if handler:
                return handler(self._json(body))
        raise SecurityError(404, "not found")

    def _json(self, body: bytes) -> Any:
        try:
            return json.loads(body or b"{}")
        except ValueError as exc:
            raise ValidationError([{"path": "", "message": f"invalid JSON: {exc}"}]) from exc

    def _generators(self) -> dict[str, Callable[[Any], Response]]:
        mb = self.config.max_upload_bytes
        return {
            "/generate/image": lambda b: self._submit("image", parse_image(b, mb), "image"),
            "/generate/image-to-video": lambda b: self._submit("image-to-video", parse_video(b, mb), "video"),
            "/generate/audio": lambda b: self._submit_audio(parse_audio(b, mb)),
            "/process/lipsync": lambda b: self._submit("lipsync", parse_lipsync(b, mb), "lipsync"),
            "/process/upscale": lambda b: self._submit("upscale", parse_upscale(b, mb), "upscale"),
        }

    def _submit_audio(self, req: Any) -> Response:
        kind: ModelKind = "sfx" if req.kind in ("sfx", "ambience") else req.kind
        return self._submit(f"audio:{req.kind}", req, kind)

    def _submit(self, job_kind: str, req: Any, model_kind: ModelKind) -> Response:
        model = self.registry.resolve(model_kind, getattr(req, "model", ""))
        summary = {k: v for k, v in vars(req).items() if not isinstance(v, (bytes, bytearray))}

        def runner(ctx: JobContext) -> None:
            ctx.job.model = {"id": model.info.id, "version": model.info.version, "mock": model.info.mock}
            self.registry.ensure_loaded(model, ctx)
            ctx.set_status("running", "generating")
            started = time.monotonic()
            model.run(req, ctx)
            ctx.job.metrics["run_seconds"] = round(time.monotonic() - started, 3)
            busy = ctx.job.metrics["run_seconds"] + ctx.job.metrics.get("load_seconds", 0.0)
            ctx.job.metrics["gpu_seconds"] = busy if model.info.device == "cuda" else 0.0
            ctx.progress(1.0)

        job = self.jobs.submit(job_kind, summary, runner)
        return Response(202, job.public())

    def submit_benchmark(self, body: Any) -> Response:
        """Start a benchmark job over enabled models (see benchmark.py)."""
        from .benchmark import DEFAULT_SUITE, BenchmarkRunner, validate_suite
        from .schemas import _V

        if not isinstance(body, dict):
            raise ValidationError([{"path": "", "message": "request body must be a JSON object"}])
        v = _V(body, self.config.max_upload_bytes)
        models = body.get("models", [])
        v.seen.add("models")
        if not isinstance(models, list) or len(models) > 20 or not all(isinstance(m, str) and len(m) <= 120 for m in models):
            v.err("models", "must be a list of up to 20 model ids")
            models = []
        include_mock = v.bool_("include_mock", False)
        source = v.file("source_image", ("png", "jpeg", "webp"), required=False)
        v.seen.add("suite")
        v.done()
        suite = validate_suite(body.get("suite") or DEFAULT_SUITE, self.config.max_upload_bytes)
        runner = BenchmarkRunner(self.registry, self.media, self.config.max_upload_bytes)
        selected = runner.select(models, include_mock)
        summary = {"models": [m.info.id for m in selected], "suite": suite.get("name", "custom"), "include_mock": include_mock}
        job = self.jobs.submit("benchmark", summary, lambda ctx: runner.run(ctx, suite, selected, source))
        return Response(202, job.public())

    def system(self) -> dict[str, Any]:
        return system_report(
            data_dir=self.config.data_dir,
            media_versions=self.media.versions(),
            models=self.registry.describe(),
            job_counts=self.jobs.counts(),
            mock_models=self.config.mock_models,
        )
