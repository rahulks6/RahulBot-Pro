"""Model benchmark harness (spec §82).

Runs a suite of cases (image, image-to-video, TTS, upscale) against selected
models inside ONE cancellable worker job, and records per result:
load time, run time, peak VRAM, success/failure (reliability), same-seed
reproducibility and technical output checks (dimensions, duration, fps,
codec, audio peak/silence). Outputs are kept so humans can judge quality and
consistency side by side in the app; nothing here decides which model wins.

Usage (CLI, from worker/):
    WORKER_AUTH_TOKEN=... WORKER_MODELS_FILE=models.json python -m ais_worker.benchmark --models qwen-image,wan2.2-ti2v-5b
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import statistics
import sys
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .diagnostics import gpu_info
from .jobs import Job, JobCancelledError, JobContext, JobError
from .media import MediaTools, video_stream_info
from .models.base import Model
from .models.mock import encode_png
from .models.registry import ModelRegistry
from .schemas import ValidationError, parse_audio, parse_image, parse_upscale, parse_video

# A default suite built around what matters for recurring-character stories:
# the same original character in different situations, an establishing shot,
# readable in-image text, gentle motion, and expressive narration/dialogue.
CHARACTER = "a small round hedgehog inventor with chestnut spines, a mustard-yellow knitted scarf and brass goggles"
STYLE = "premium 3D animated film still, soft global illumination, appealing stylised characters"
DEFAULT_SUITE: dict[str, Any] = {
    "name": "story-studio-default",
    "version": 1,
    "image": {
        "seeds": [101, 202],
        "repeat_seed_check": True,
        "cases": [
            {"key": "character-front", "prompt": f"{STYLE}. Full-body front view of {CHARACTER}, plain studio background"},
            {"key": "character-action", "prompt": f"{STYLE}. {CHARACTER} running through a mossy forest clearing at dusk, excited"},
            {"key": "character-closeup", "prompt": f"{STYLE}. Close-up of {CHARACTER}, surprised expression, warm lantern light"},
            {
                "key": "establishing",
                "prompt": f"{STYLE}. Wide establishing shot of a cosy acorn-shaped workshop built into willow roots beside a stream",
            },
            {"key": "sign-text", "prompt": f"{STYLE}. A wooden sign that reads 'LANTERN GROVE' in a forest"},
        ],
        "negative_prompt": "photorealistic, text artefacts, watermark, extra limbs, deformed hands",
        "width": 1920,
        "height": 1080,
    },
    "video": {
        "seed": 7,
        "cases": [
            {"key": "gentle-push-in", "motion_prompt": "slow camera push-in, leaves sway gently, character blinks", "duration_sec": 4},
            {"key": "walk-cycle", "motion_prompt": "the character walks forward towards the camera, stable identity", "duration_sec": 4},
        ],
        "fps": 24,
        "width": 1920,
        "height": 1080,
    },
    "tts": {
        "cases": [
            {
                "key": "narration-calm",
                "text": "As the sun slipped behind the willow, Pip reached for the little brass lantern.",
                "emotion": "calm",
                "presentation": "female",
            },
            {"key": "dialogue-excited", "text": "Leaf boats! We can build leaf boats!", "emotion": "excited", "presentation": "neutral"},
            {"key": "dialogue-whisper", "text": "Shh. Did you hear that sound?", "emotion": "whispering", "presentation": "male"},
        ]
    },
    "upscale": {"cases": [{"key": "to-1080p", "target_width": 1920, "target_height": 1080, "source_width": 960, "source_height": 540}]},
}

MAX_CASES = 20
MAX_SEEDS = 5


@dataclass
class BenchmarkResult:
    model: str
    kind: str
    case: str
    seed: int | None
    status: str
    error_code: str | None = None
    error_message: str | None = None
    load_seconds: float | None = None
    run_seconds: float | None = None
    peak_vram_mb: float | None = None
    output: str | None = None
    sha256: str | None = None
    checks: dict[str, Any] = field(default_factory=dict)


def validate_suite(suite: Any, max_bytes: int) -> dict[str, Any]:
    """Validate every case by building the same request objects the production endpoints use."""
    if not isinstance(suite, dict):
        raise ValidationError([{"path": "suite", "message": "must be an object"}])
    errors: list[dict[str, str]] = []
    for kind in ("image", "video", "tts", "upscale"):
        section = suite.get(kind)
        if section is None:
            continue
        cases = section.get("cases") if isinstance(section, dict) else None
        if not isinstance(cases, list) or not cases or len(cases) > MAX_CASES:
            errors.append({"path": f"suite.{kind}.cases", "message": f"must be a list of 1..{MAX_CASES} cases"})
            continue
        seeds = section.get("seeds", [0])
        if not isinstance(seeds, list) or not seeds or len(seeds) > MAX_SEEDS:
            errors.append({"path": f"suite.{kind}.seeds", "message": f"must be a list of 1..{MAX_SEEDS} seeds"})
        for i, case in enumerate(cases):
            if not isinstance(case, dict) or not isinstance(case.get("key"), str) or not case["key"].replace("-", "").isalnum():
                errors.append({"path": f"suite.{kind}.cases[{i}].key", "message": "each case needs a key of letters, digits and '-'"})
                continue
            try:
                _request(kind, section, case, 0, b"\x89PNG\r\n\x1a\n" + b"0" * 32, max_bytes, check_only=True)
            except ValidationError as exc:
                errors.extend({"path": f"suite.{kind}.cases[{i}].{e['path']}", "message": e["message"]} for e in exc.errors)
    if errors:
        raise ValidationError(errors)
    return suite


def _request(
    kind: str, section: dict[str, Any], case: dict[str, Any], seed: int, image: bytes, max_bytes: int, check_only: bool = False
) -> Any:
    body = {k: v for k, v in case.items() if k not in {"key", "source_width", "source_height"}}
    b64 = base64.b64encode(image).decode()
    if kind == "image":
        body = {
            "negative_prompt": section.get("negative_prompt", ""),
            "width": section.get("width", 1920),
            "height": section.get("height", 1080),
            **body,
            "seed": seed,
        }
        return parse_image(body, max_bytes)
    if kind == "video":
        body = {
            "fps": section.get("fps", 24),
            "width": section.get("width", 1920),
            "height": section.get("height", 1080),
            **body,
            "seed": seed,
            "image": b64,
        }
        if check_only:
            body["image"] = base64.b64encode(_test_card(64, 36)).decode()
        return parse_video(body, max_bytes)
    if kind == "tts":
        return parse_audio({"kind": "tts", **body}, max_bytes)
    body = {**body, "source": base64.b64encode(image if not check_only else _test_card(64, 36)).decode()}
    return parse_upscale(body, max_bytes)


def _test_card(width: int, height: int) -> bytes:
    """Deterministic colour-bar still used when no source image is supplied."""
    bars = [(235, 235, 235), (235, 235, 16), (16, 235, 235), (16, 235, 16), (235, 16, 235), (235, 16, 16), (16, 16, 235)]
    return encode_png(width, height, lambda x, y: bars[min(len(bars) - 1, x * len(bars) // width)])


def audio_checks(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as w:
        rate, n, width = w.getframerate(), w.getnframes(), w.getsampwidth()
        raw = w.readframes(n)
    if width != 2 or n == 0:
        return {"duration_sec": round(n / max(1, rate), 3), "sample_rate": rate}
    samples = memoryview(raw).cast("h")
    peak = max(abs(s) for s in samples) / 32768
    silent = sum(1 for s in samples if abs(s) < 33) / n  # below about -60 dBFS
    return {
        "duration_sec": round(n / rate, 3),
        "sample_rate": rate,
        "peak": round(peak, 4),
        "clipped_samples": sum(1 for s in samples if abs(s) >= 32767),
        "silence_ratio": round(silent, 3),
    }


def summarize(results: list[BenchmarkResult]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for model in sorted({r.model for r in results}):
        rs = [r for r in results if r.model == model]
        ok = [r for r in rs if r.status == "complete"]
        times = sorted(r.run_seconds for r in ok if r.run_seconds is not None)
        repro = [r.checks["reproducible"] for r in rs if "reproducible" in r.checks]
        out[model] = {
            "kind": rs[0].kind,
            "runs": len(rs),
            "succeeded": len(ok),
            "success_rate": round(len(ok) / len(rs), 3),
            "load_seconds": next((r.load_seconds for r in rs if r.load_seconds is not None), None),
            "mean_run_seconds": round(statistics.fmean(times), 3) if times else None,
            "p95_run_seconds": times[min(len(times) - 1, int(0.95 * len(times)))] if times else None,
            "peak_vram_mb": max((r.peak_vram_mb for r in rs if r.peak_vram_mb is not None), default=None),
            "reproducible_same_seed": all(repro) if repro else None,
            "errors": sorted({r.error_code for r in rs if r.error_code}),
        }
    return out


class BenchmarkRunner:
    def __init__(self, registry: ModelRegistry, media: MediaTools, max_bytes: int) -> None:
        self.registry = registry
        self.media = media
        self.max_bytes = max_bytes

    def select(self, model_ids: list[str], include_mock: bool) -> list[Model[Any]]:
        models = []
        for info in self.registry.describe():
            if model_ids and info["id"] not in model_ids:
                continue
            if info["mock"] and not include_mock:
                continue
            if info["kind"] in ("image", "video", "tts", "upscale"):
                models.append(self.registry.resolve(info["kind"], info["id"]))
        missing = set(model_ids) - {m.info.id for m in models}
        if missing:
            raise JobError("MODEL_LOAD_FAILED", f"not registered on this worker (check catalog/licence gate): {', '.join(sorted(missing))}")
        if not models:
            raise JobError("MODEL_LOAD_FAILED", "no benchmarkable models selected (real models must be enabled in the catalog)")
        return models

    def run(self, ctx: JobContext, suite: dict[str, Any], models: list[Model[Any]], source_image: bytes | None) -> None:
        results: list[BenchmarkResult] = []
        started = time.time()
        gpu = gpu_info()
        video_source = source_image or _test_card(960, 540)
        total = sum(len(suite.get(m.info.kind, {}).get("cases", [])) for m in models) or 1
        done = 0
        for model in models:
            section = suite.get(model.info.kind)
            if not section:
                continue
            for case in section["cases"]:
                seeds = self._seeds(model.info.kind, section)
                for seed in seeds:
                    results.append(self._one(ctx, model, section, case, seed, video_source))
                if model.info.kind == "image" and section.get("repeat_seed_check"):
                    again = self._one(ctx, model, section, case, seeds[0], video_source, suffix="repeat")
                    first = next(r for r in results if r.model == model.info.id and r.case == case["key"] and r.seed == seeds[0])
                    first.checks["reproducible"] = again.status == "complete" and again.sha256 == first.sha256
                    results.append(again)
                done += 1
                ctx.progress(done / total)
            model.unload()
        report = {
            "suite": suite.get("name", "custom"),
            "started_at": started,
            "finished_at": time.time(),
            "gpu": gpu,
            "models": [
                {
                    "id": m.info.id,
                    "kind": m.info.kind,
                    "display_name": m.info.display_name,
                    "version": m.info.version,
                    "license": m.info.license,
                    "commercial_use": m.info.commercial_use,
                    "license_url": m.info.license_url,
                    "mock": m.info.mock,
                    "min_vram_gb": m.info.min_vram_gb,
                }
                for m in models
            ],
            "summary": summarize(results),
            "results": [vars(r) for r in results],
        }
        ctx.path("results.json").write_text(json.dumps(report, indent=2))
        ctx.add_output("results.json", "application/json")

    @staticmethod
    def _seeds(kind: str, section: dict[str, Any]) -> list[int]:
        if kind == "image":
            return [int(s) for s in section.get("seeds", [0])]
        if kind == "video":
            return [int(section.get("seed", 0))]
        return [0]

    def _one(
        self, ctx: JobContext, model: Model[Any], section: dict[str, Any], case: dict[str, Any], seed: int, image: bytes, suffix: str = ""
    ) -> BenchmarkResult:
        kind = model.info.kind
        key = case["key"] + (f"-{suffix}" if suffix else "")
        res = BenchmarkResult(model=model.info.id, kind=kind, case=key, seed=seed if kind in ("image", "video") else None, status="failed")
        sub = Job(id=ctx.job.id, kind=f"benchmark:{kind}")
        scratch = ctx.dir / "scratch"
        shutil.rmtree(scratch, ignore_errors=True)
        sub_ctx = ctx.child(sub, scratch)
        ctx.set_status("running", f"{model.info.id} · {key} · seed {seed}")
        try:
            source = image
            if kind == "upscale":
                source = _test_card(int(case.get("source_width", 960)), int(case.get("source_height", 540)))
            request = _request(kind, section, case, seed, source, self.max_bytes)
            if not model.loaded:
                before = time.monotonic()
                self.registry.ensure_loaded(model, sub_ctx)
                res.load_seconds = round(time.monotonic() - before, 3)
            t0 = time.monotonic()
            model.run(request, sub_ctx)
            res.run_seconds = round(time.monotonic() - t0, 3)
            res.peak_vram_mb = sub.metrics.get("peak_vram_mb")
            out = sub.outputs[0]
            name = f"{model.info.id}__{key}__{seed}{Path(out.name).suffix}".replace("/", "_")
            (scratch / out.name).replace(ctx.dir / name)
            meta = {k: v for k, v in vars(out).items() if k in ("width", "height", "duration_sec", "fps", "native_resolution")}
            ctx.add_output(name, out.mime, **meta, mock=model.info.mock)
            res.output, res.sha256, res.status = name, out.sha256, "complete"
            res.checks.update({k: v for k, v in meta.items() if v is not None})
            res.checks.update(self._technical(ctx.dir / name, out.mime))
        except JobCancelledError:
            raise
        except JobError as exc:
            res.error_code, res.error_message = exc.code, str(exc)[:500]
        except ValidationError as exc:
            res.error_code, res.error_message = "VALIDATION_FAILED", str(exc)[:500]
        except Exception as exc:  # noqa: BLE001 - one broken model must not end the benchmark
            res.error_code, res.error_message = "INTERNAL", f"{type(exc).__name__}: {exc}"[:500]
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        ctx.log(f"{model.info.id} {key} seed={seed}: {res.status}{' ' + (res.error_code or '') if res.error_code else ''}")
        return res

    def _technical(self, path: Path, mime: str) -> dict[str, Any]:
        if mime == "audio/wav":
            return audio_checks(path)
        if mime == "video/mp4" and self.media.available:
            probe = self.media.probe_file(path)
            info = video_stream_info(probe)
            return {
                "codec": info.get("codec"),
                "probed_fps": info.get("fps"),
                "probed_duration_sec": round(float(probe.get("format", {}).get("duration", 0)), 3),
            }
        return {}


def run_cli(argv: list[str] | None = None, out: Callable[[str], None] = print) -> int:
    from .api import WorkerAPI
    from .config import ConfigError, WorkerConfig

    parser = argparse.ArgumentParser(description="Benchmark enabled models on this worker")
    parser.add_argument("--models", default="", help="comma-separated model ids (default: all enabled real models)")
    parser.add_argument("--suite", type=Path, help="suite JSON (default: built-in story-studio suite)")
    parser.add_argument("--image", type=Path, help="PNG/JPEG still for image-to-video cases (default: test card)")
    parser.add_argument("--include-mock", action="store_true", help="also benchmark mock models (pipeline smoke test)")
    args = parser.parse_args(argv)
    try:
        config = WorkerConfig.from_env()
    except ConfigError as exc:
        out(f"configuration error: {exc}")
        return 2
    api = WorkerAPI(config)
    try:
        body: dict[str, Any] = {"models": [m for m in args.models.split(",") if m], "include_mock": args.include_mock}
        if args.suite:
            body["suite"] = json.loads(args.suite.read_text())
        if args.image:
            body["source_image"] = base64.b64encode(args.image.read_bytes()).decode()
        res = api.handle("POST", "/benchmarks", {"authorization": f"Bearer {config.auth_token}"}, json.dumps(body).encode())
        if res.status != 202 or res.body is None:
            out(json.dumps(res.body, indent=2))
            return 1
        job_id = res.body["id"]
        while api.jobs.get(job_id).status not in {"complete", "failed", "cancelled"}:
            time.sleep(0.5)
        job = api.jobs.get(job_id)
        if job.status != "complete":
            out(f"benchmark {job.status}: {job.error}")
            return 1
        report = json.loads(api.jobs.output_path(job_id, "results.json").read_text())
        out(f"results: {api.jobs.output_path(job_id, 'results.json')}")
        for model, s in report["summary"].items():
            timing = f"load {s['load_seconds']}s  mean {s['mean_run_seconds']}s  p95 {s['p95_run_seconds']}s"
            out(f"{model:28} {s['kind']:7} ok {s['succeeded']}/{s['runs']}  {timing}  VRAM {s['peak_vram_mb']} MB")
        return 0
    finally:
        api.close()


if __name__ == "__main__":
    sys.exit(run_cli())
