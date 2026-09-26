"""Catalog / licence gate tests and adapter CONTRACT tests.

PyTorch, diffusers, kokoro and chatterbox are not installable in the build
environment, so the adapters are exercised against small fakes that mimic the
libraries' documented call signatures. These tests check our wiring
(argument filtering, seeds, size/frame planning, encoding, licence gate,
error mapping); real model behaviour is verified by the benchmark on a GPU.
"""

from __future__ import annotations

import io
import json
import struct
import sys
import time
import types
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.catalog import CatalogEntry, LicenseError, check_license, load_catalog
from ais_worker.models.mock import encode_png
from ais_worker.schemas import ValidationError

from .conftest import AUTH, has_ffmpeg, make_config, png_b64, post, wait

EXAMPLE = Path(__file__).resolve().parent.parent / "models.example.json"


def entry(**over: Any) -> dict[str, Any]:
    base = {
        "id": "test-model",
        "kind": "image",
        "adapter": "diffusers_image",
        "display_name": "Test",
        "repo": "org/test",
        "license": "Apache-2.0",
        "commercial_use": "allowed",
        "min_vram_gb": 0,
        "enabled": True,
        "default": True,
        "params": {"max_side": 512, "num_inference_steps": 3},
    }
    base.update(over)
    return base


def write_catalog(tmp_path: Path, *entries: dict[str, Any]) -> Path:
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"models": list(entries)}))
    return path


# --- catalog + licence gate ---------------------------------------------------------


def test_example_catalog_is_valid_and_everything_real_is_disabled() -> None:
    entries = load_catalog(EXAMPLE)
    assert len(entries) >= 15
    enabled = [e.id for e in entries if e.enabled]
    assert enabled == ["ffmpeg-lanczos"], "only the non-AI baseline is enabled by default"
    by_id = {e.id: e for e in entries}
    for nc in ("flux2-dev", "f5-tts", "musicgen", "wav2lip"):
        assert by_id[nc].commercial_use == "non_commercial"
    for cond in ("sdxl-base", "ltx-video", "stable-audio-open"):
        assert by_id[cond].commercial_use == "conditional" and not by_id[cond].license_acknowledged
    assert {e.kind for e in entries} == {"image", "video", "tts", "music", "sfx", "lipsync", "upscale"}


def test_catalog_validation_reports_every_problem(tmp_path: Path) -> None:
    path = write_catalog(tmp_path, entry(kind="hologram", surprise=1), entry(), entry(min_vram_gb=-1, id="bad id!"))
    with pytest.raises(ValidationError) as e:
        load_catalog(path)
    messages = " ".join(f"{x['path']} {x['message']}" for x in e.value.errors)
    for part in ["kind", "surprise", "duplicate id 'test-model'", "min_vram_gb", "models[2].id"]:
        assert part in messages


def test_licence_gate() -> None:
    def mk(c: str, ack: bool = False) -> CatalogEntry:
        return CatalogEntry(
            id="m", kind="image", adapter="none", display_name="", repo="", revision="", license="L", commercial_use=c,
            license_url="", license_notes="revenue cap", license_acknowledged=ack, min_vram_gb=0, enabled=True, default=False,
        )  # fmt: skip

    check_license(mk("allowed"), False)
    check_license(mk("conditional", ack=True), False)
    check_license(mk("non_commercial"), True)
    for bad, allow in [(mk("conditional"), False), (mk("non_commercial"), False), (mk("unknown"), True)]:
        with pytest.raises(LicenseError):
            check_license(bad, allow)


def test_registry_skips_disabled_unlicensed_and_adapterless_entries(tmp_path: Path) -> None:
    path = write_catalog(
        tmp_path,
        entry(id="ok-upscaler", kind="upscale", adapter="ffmpeg_upscale", default=False, params={}),
        entry(id="nc", commercial_use="non_commercial"),
        entry(id="cond", commercial_use="conditional"),
        entry(id="off", enabled=False),
        entry(id="no-adapter", adapter="none", kind="music"),
    )
    api = WorkerAPI(make_config(tmp_path, models_file=path))
    body = api.handle("GET", "/models", AUTH, b"").body or {}
    ids = {m["id"] for m in body["models"]}
    assert "ok-upscaler" in ids and not {"nc", "cond", "off", "no-adapter"} & ids
    reasons = {s["id"]: s["reason"] for s in body["catalog_skipped"]}
    assert "forbids commercial use" in reasons["nc"]
    assert "license_acknowledged" in reasons["cond"]
    assert reasons["off"] == "disabled in catalog"
    assert "no adapter" in reasons["no-adapter"]
    upscaler = next(m for m in body["models"] if m["id"] == "ok-upscaler")
    assert upscaler["mock"] is False and upscaler["commercial_use"] == "allowed"
    api.close()
    api2 = WorkerAPI(make_config(tmp_path, models_file=path, allow_noncommercial=True))
    assert "nc" in {m["id"] for m in api2.registry.describe()}
    api2.close()


# --- fakes --------------------------------------------------------------------------


class FakeImage:
    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height

    def save(self, path: Any) -> None:
        Path(path).write_bytes(encode_png(self.width, self.height, lambda x, y: (x % 256, y % 256, 90)))

    def convert(self, _mode: str) -> FakeImage:
        return self

    def resize(self, size: tuple[int, int]) -> FakeImage:
        return FakeImage(*size)


def fake_pil() -> dict[str, types.ModuleType]:
    image_mod = types.ModuleType("PIL.Image")

    def open_(fp: io.BytesIO) -> FakeImage:
        data = fp.read()
        w, h = struct.unpack(">II", data[16:24])
        return FakeImage(w, h)

    image_mod.open = open_  # type: ignore[attr-defined]
    pil = types.ModuleType("PIL")
    pil.Image = image_mod  # type: ignore[attr-defined]
    return {"PIL": pil, "PIL.Image": image_mod}


CALLS: dict[str, Any] = {}


class FakeImagePipe:
    """Mimics a FLUX-style pipeline: no negative_prompt argument."""

    def __call__(self, prompt: str, width: int, height: int, num_inference_steps: int = 28, guidance_scale: float = 3.5,
                 generator: Any = None, callback_on_step_end: Any = None) -> Any:  # fmt: skip
        CALLS["image"] = {"prompt": prompt, "width": width, "height": height, "steps": num_inference_steps, "seed": generator.seed}
        for step in range(num_inference_steps):
            time.sleep(CALLS.get("step_delay", 0))
            if callback_on_step_end:
                callback_on_step_end(self, step, 0, {})
        return types.SimpleNamespace(images=[FakeImage(width, height)])

    def enable_model_cpu_offload(self) -> None: ...

    def to(self, _device: str) -> FakeImagePipe:
        return self


class FakeVideoPipe:
    def __call__(self, image: FakeImage, prompt: str, negative_prompt: str | None = None, width: int = 832, height: int = 480,
                 num_frames: int = 81, num_inference_steps: int = 40, guidance_scale: float = 5.0, generator: Any = None,
                 output_type: str = "np", callback_on_step_end: Any = None) -> Any:  # fmt: skip
        CALLS["video"] = {
            "frames": num_frames,
            "width": width,
            "height": height,
            "image": (image.width, image.height),
            "output_type": output_type,
        }
        return types.SimpleNamespace(frames=[[FakeImage(width, height) for _ in range(num_frames)]])

    def enable_model_cpu_offload(self) -> None: ...

    def to(self, _device: str) -> FakeVideoPipe:
        return self


def fake_torch(cuda: bool = False) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.bfloat16 = "bf16"  # type: ignore[attr-defined]
    torch.float16 = "f16"  # type: ignore[attr-defined]

    class Generator:
        def __init__(self, device: str = "cpu") -> None:
            self.seed = -1

        def manual_seed(self, seed: int) -> Generator:
            self.seed = seed
            return self

    torch.Generator = Generator  # type: ignore[attr-defined]
    torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: cuda, reset_peak_memory_stats=lambda: None, max_memory_allocated=lambda: 3 * 1024**3, empty_cache=lambda: None
    )
    return torch


def fake_diffusers() -> types.ModuleType:
    diffusers = types.ModuleType("diffusers")

    class DiffusionPipeline:
        @staticmethod
        def from_pretrained(repo: str, **kwargs: Any) -> Any:
            CALLS["load"] = {"repo": repo, **kwargs}
            return FakeVideoPipe() if "video" in repo else FakeImagePipe()

    diffusers.DiffusionPipeline = DiffusionPipeline  # type: ignore[attr-defined]
    return diffusers


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    CALLS.clear()
    for name, mod in {"torch": fake_torch(), "diffusers": fake_diffusers(), **fake_pil()}.items():
        monkeypatch.setitem(sys.modules, name, mod)


# --- adapter contract tests ------------------------------------------------------------


def test_diffusers_image_adapter(tmp_path: Path, fakes: None) -> None:
    path = write_catalog(tmp_path, entry(params={"max_side": 512, "num_inference_steps": 3, "dtype": "bfloat16", "dim_multiple": 16}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "a fox", "negative_prompt": "blurry", "seed": 42, "width": 1920, "height": 1080})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert CALLS["load"]["repo"] == "org/test" and CALLS["load"]["torch_dtype"] == "bf16"
    assert CALLS["image"] == {"prompt": "a fox", "width": 512, "height": 288, "steps": 3, "seed": 42}, (
        "negative_prompt filtered for FLUX-like pipes"
    )
    out = done["outputs"][0]
    assert (out["width"], out["height"], out["native_resolution"], out["mock"]) == (512, 288, False, False)
    assert done["model"]["mock"] is False
    api.close()


def test_diffusers_cancellation_between_steps(tmp_path: Path, fakes: None) -> None:
    CALLS["step_delay"] = 0.05
    path = write_catalog(tmp_path, entry(params={"num_inference_steps": 200}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "slow", "width": 256, "height": 256})
    time.sleep(0.3)
    api.handle("POST", f"/jobs/{job['id']}/cancel", AUTH, b"")
    assert wait(api, job["id"], timeout=5)["status"] == "cancelled"
    api.close()


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_diffusers_i2v_adapter_plans_frames_and_encodes(tmp_path: Path, fakes: None) -> None:
    params = {"native_fps": 16, "frame_multiple": 4, "dim_multiple": 16, "max_side": 320, "num_inference_steps": 2}
    path = write_catalog(tmp_path, entry(id="vid", kind="video", adapter="diffusers_i2v", repo="org/video-model", params=params))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image-to-video", {"image": png_b64(64, 36), "duration_sec": 2, "fps": 24, "width": 1920, "height": 1080})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert CALLS["video"]["frames"] == 33, "2 s × 16 fps = 32 → snapped to 4k+1 = 33"
    assert (CALLS["video"]["width"], CALLS["video"]["height"]) == (320, 176)
    assert CALLS["video"]["image"] == (320, 176) and CALLS["video"]["output_type"] == "pil"
    probe = api.media.probe_file(api.jobs.output_path(job["id"], "clip.mp4"))
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert video["codec_name"] == "h264" and video["avg_frame_rate"] == "24/1"
    assert abs(float(probe["format"]["duration"]) - 33 / 16) < 0.1
    assert not (tmp_path / "jobs" / job["id"] / "frames").exists(), "intermediate frames are cleaned up"
    api.close()


def test_kokoro_adapter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    kokoro = types.ModuleType("kokoro")
    seen: dict[str, Any] = {}

    class KPipeline:
        def __init__(self, lang_code: str) -> None:
            seen["lang"] = lang_code

        def __call__(self, text: str, voice: str, speed: float) -> Any:
            seen.update(voice=voice, speed=speed)
            yield ("g", "p", [0.1] * 12000)
            yield ("g", "p", [[-0.1] * 12000])

    kokoro.KPipeline = KPipeline  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro", kokoro)
    path = write_catalog(
        tmp_path, entry(id="kokoro", kind="tts", adapter="kokoro_tts", params={"lang_code": "b", "voices": {"male": "bm_george"}})
    )
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/audio", {"kind": "tts", "text": "Hello", "presentation": "male", "speed": 1.2, "emotion": "excited"})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert seen == {"lang": "b", "voice": "bm_george", "speed": 1.2}
    assert done["outputs"][0]["duration_sec"] == 1.0, "24 000 samples at 24 kHz"
    assert any("no emotion control" in line for line in done["logs"])
    _, job2 = post(api, "/generate/audio", {"kind": "tts", "text": "Hi", "voice_identity": "kokoro:af_bella"})
    wait(api, job2["id"])
    assert seen["voice"] == "af_bella", "a locked voice can pin an explicit Kokoro voice"
    api.close()


def test_chatterbox_adapter_maps_emotion_to_exaggeration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[float] = []
    tts_mod = types.ModuleType("chatterbox.tts")

    class ChatterboxTTS:
        sr = 24000

        @classmethod
        def from_pretrained(cls, device: str) -> ChatterboxTTS:
            return cls()

        def generate(self, text: str, exaggeration: float, cfg_weight: float) -> list[list[float]]:
            seen.append(exaggeration)
            return [[0.0] * 2400]

    tts_mod.ChatterboxTTS = ChatterboxTTS  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "chatterbox", types.ModuleType("chatterbox"))
    monkeypatch.setitem(sys.modules, "chatterbox.tts", tts_mod)
    monkeypatch.setitem(sys.modules, "torch", fake_torch())
    path = write_catalog(tmp_path, entry(id="cb", kind="tts", adapter="chatterbox_tts", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    for emotion in ("whispering", "excited"):
        _, job = post(api, "/generate/audio", {"kind": "tts", "text": "Hi", "emotion": emotion})
        assert wait(api, job["id"])["status"] == "complete"
    assert seen == [0.3, 0.85]
    api.close()


def test_missing_dependency_gives_an_actionable_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)  # simulate "not installed"
    path = write_catalog(tmp_path, entry())
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "x"})
    done = wait(api, job["id"])
    assert done["error"]["code"] == "MODEL_LOAD_FAILED"
    assert "pip install torch" in done["error"]["message"]
    api.close()


def test_gpu_models_refuse_to_run_without_cuda(tmp_path: Path, fakes: None) -> None:
    path = write_catalog(tmp_path, entry(min_vram_gb=24))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "x"})
    error = wait(api, job["id"])["error"]
    assert error["code"] == "CUDA_UNAVAILABLE"
    assert "Install the GPU runtime" in error["message"] and "CLOUD GPU" in error["message"]
    api.close()


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_ffmpeg_upscaler_is_real_and_never_native(tmp_path: Path) -> None:
    path = write_catalog(tmp_path, entry(id="lanczos", kind="upscale", adapter="ffmpeg_upscale", params={"flags": "lanczos"}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/process/upscale", {"source": png_b64(64, 36), "target_width": 256, "target_height": 144})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    data = api.jobs.output_path(job["id"], "upscaled.png").read_bytes()
    assert struct.unpack(">II", data[16:24]) == (256, 144)
    assert done["outputs"][0]["native_resolution"] is False and done["outputs"][0]["mock"] is False
    api.close()
