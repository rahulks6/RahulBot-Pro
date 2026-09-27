"""VRAM planning, quality presets, reference conditioning and OOM recovery (fakes: no GPU needed)."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.catalog import CatalogEntry
from ais_worker.vram import MemoryPolicy, estimate_vram_gb, plan_memory, resolve_params

from .conftest import make_config, png_b64, post, wait
from .test_catalog_adapters import FakeImage, entry, fake_diffusers, fake_pil, fake_torch, write_catalog

GB = 1024**3


def ce(**over: Any) -> CatalogEntry:
    base: dict[str, Any] = {
        "id": "m", "kind": "image", "adapter": "diffusers_image", "display_name": "M", "repo": "org/m",
        "revision": "main", "license": "L", "commercial_use": "allowed", "license_url": "", "license_notes": "",
        "license_acknowledged": False, "min_vram_gb": 12, "enabled": True, "default": True, "params": {},
        "offload_min_vram_gb": 4,
    }  # fmt: skip
    base.update(over)
    return CatalogEntry(**base)


def policy(**over: Any) -> MemoryPolicy:
    return MemoryPolicy.from_settings({"memory": {"max_vram_percent": 90, "cpu_offload": "auto", **over}})


# --- planning (pure) -----------------------------------------------------------------------


def test_estimate_scales_with_pixels_and_frames() -> None:
    img = ce()
    assert estimate_vram_gb(img, 1024, 1024) == 12.0
    assert estimate_vram_gb(img, 2048, 2048) > estimate_vram_gb(img, 1024, 1024)
    vid = ce(kind="video", min_vram_gb=16)
    assert estimate_vram_gb(vid, 1280, 704, 121) > estimate_vram_gb(vid, 832, 480, 49)
    assert estimate_vram_gb(ce(min_vram_gb=0), 4096, 4096) == 0.0, "CPU models need no VRAM"


def test_plan_picks_the_fastest_configuration_that_fits() -> None:
    e = ce()
    assert plan_memory(e, 12, 22, 24, policy()).offload == "none"
    model = plan_memory(e, 12, 10, 12, policy())
    assert (model.offload, model.feasible) == ("model", True)
    assert any("CPU offload: model" in a for a in model.adjustments)
    seq = plan_memory(e, 12, 5, 6, policy())
    assert (seq.offload, seq.feasible, seq.attention_slicing) == ("sequential", True, True)
    no = plan_memory(e, 12, 2, 4, policy())
    assert no.feasible is False
    assert "lower quality preset" in no.reason and "CLOUD GPU" in no.reason


def test_plan_respects_the_settings() -> None:
    e = ce()
    assert plan_memory(e, 12, 22, 24, policy(cpu_offload="sequential")).offload == "sequential"
    # Max VRAM usage caps what may be planned even when more is free.
    assert plan_memory(e, 12, 22, 24, policy(max_vram_percent=40)).offload != "none"
    video = plan_memory(e, 12, 22, 24, policy(), video=True)
    assert video.vae_tiling and video.vae_slicing, "video decodes are tiled"
    assert not plan_memory(e, 12, 22, 24, policy(vae_tiling="off"), video=True).vae_tiling
    # Requests without a policy (older app, cloud) keep the catalog behaviour.
    legacy = plan_memory(ce(params={"cpu_offload": True}), 12, 40, 48, MemoryPolicy())
    assert legacy.offload == "model"


def test_quality_presets_change_the_parameters() -> None:
    e = ce(params={"num_inference_steps": 30, "max_side": 1344}, presets={"fast_preview": {"num_inference_steps": 12, "max_side": 1024}})
    assert resolve_params(e, "fast_preview")["num_inference_steps"] == 12
    assert resolve_params(e, "optimized")["num_inference_steps"] == 30
    # Without an explicit preset: derived, never identical for FAST and QUALITY.
    d = ce(params={"num_inference_steps": 30, "max_side": 1344})
    assert resolve_params(d, "fast_preview")["num_inference_steps"] == 15
    assert resolve_params(d, "fast_preview")["max_side"] == 1024
    assert resolve_params(d, "high_quality")["num_inference_steps"] == 45


# --- adapters on a fake CUDA device ----------------------------------------------------------

CALLS: dict[str, Any] = {}


class GpuImagePipe:
    """SDXL-like pipe on a fake GPU: records memory switches, IP-Adapter use and can OOM once."""

    def __init__(self) -> None:
        self.vae = types.SimpleNamespace(enable_tiling=lambda: CALLS.setdefault("switches", []).append("vae_tiling"),
                                         enable_slicing=lambda: CALLS.setdefault("switches", []).append("vae_slicing"))  # fmt: skip

    def __call__(self, prompt: str, width: int, height: int, negative_prompt: str | None = None, num_inference_steps: int = 30,
                 guidance_scale: float = 5.0, generator: Any = None, ip_adapter_image: Any = None,
                 callback_on_step_end: Any = None) -> Any:  # fmt: skip
        if CALLS.get("oom_once"):
            CALLS["oom_once"] = False
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
        CALLS["call"] = {"width": width, "height": height, "steps": num_inference_steps, "ip": ip_adapter_image}
        return types.SimpleNamespace(images=[FakeImage(width, height)])

    def enable_model_cpu_offload(self) -> None:
        CALLS.setdefault("switches", []).append("model_offload")

    def enable_sequential_cpu_offload(self) -> None:
        CALLS.setdefault("switches", []).append("sequential_offload")

    def enable_attention_slicing(self) -> None:
        CALLS.setdefault("switches", []).append("attention_slicing")

    def to(self, device: str) -> GpuImagePipe:
        CALLS.setdefault("switches", []).append(f"to_{device}")
        return self

    def load_ip_adapter(self, repo: str, **kwargs: Any) -> None:
        CALLS["ip_adapter"] = {"repo": repo, **kwargs}

    def set_ip_adapter_scale(self, scale: float) -> None:
        CALLS["ip_scale"] = scale


@pytest.fixture
def gpu(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """A fake 12 GB CUDA GPU with `free` GB free (change CALLS['free_gb'] per test)."""
    CALLS.clear()
    CALLS["free_gb"] = 11.0
    torch = fake_torch(cuda=True)
    torch.cuda.mem_get_info = lambda: (int(CALLS["free_gb"] * GB), 12 * GB)
    diffusers = fake_diffusers()

    class Pipeline:
        @staticmethod
        def from_pretrained(repo: str, **kwargs: Any) -> Any:
            CALLS["load"] = {"repo": repo, **kwargs}
            CALLS["loads"] = CALLS.get("loads", 0) + 1
            return GpuImagePipe()

    diffusers.DiffusionPipeline = Pipeline  # type: ignore[attr-defined]
    for name, mod in {"torch": torch, "diffusers": diffusers, **fake_pil()}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    return CALLS


def sdxl(**params: Any) -> dict[str, Any]:
    return entry(
        min_vram_gb=8,
        offload_min_vram_gb=4,
        params={
            "num_inference_steps": 28,
            "max_side": 1344,
            "dim_multiple": 8,
            "reference_mode": "ip_adapter",
            "variant": "fp16",
            "ip_adapter": {
                "repo": "h94/IP-Adapter",
                "subfolder": "sdxl_models",
                "weight_name": "w.safetensors",
                "image_encoder_folder": "models/image_encoder",
                "scale": 0.6,
            },
            **params,
        },
        presets={"fast_preview": {"num_inference_steps": 14, "max_side": 1024}},
    )


def image_job(api: WorkerAPI, **body: Any) -> dict[str, Any]:
    _, job = post(api, "/generate/image", {"prompt": "Milo", "width": 1920, "height": 1080, "seed": 7, **body})
    return wait(api, job["id"])


MEM = {"max_vram_percent": 90, "cpu_offload": "auto", "vae_tiling": "auto", "attention": "auto", "auto_unload": True}


def test_image_fits_fully_on_the_gpu_and_records_the_plan(tmp_path: Path, gpu: dict[str, Any]) -> None:
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, settings={"memory": MEM})
    assert done["status"] == "complete", done
    assert "to_cuda" in gpu["switches"]
    assert gpu["load"]["variant"] == "fp16"
    mem = done["details"]["memory"]
    assert mem["offload"] == "none" and mem["estimated_vram_gb"] > 0
    assert done["details"]["effective_params"]["steps"] == 28
    assert done["metrics"]["vram_free_before_gb"] == 11.0
    api.close()


def test_low_free_vram_uses_offload_and_quality_preset_changes_steps(tmp_path: Path, gpu: dict[str, Any]) -> None:
    gpu["free_gb"] = 3.0
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, quality="fast_preview", settings={"memory": MEM})
    assert done["status"] == "complete", done
    assert "sequential_offload" in gpu["switches"] and "attention_slicing" in gpu["switches"]
    assert gpu["call"]["steps"] == 14, "FAST preset"
    assert max(gpu["call"]["width"], gpu["call"]["height"]) <= 1024
    assert any("CPU offload: sequential" in a for a in done["details"]["memory"]["adjustments"])
    api.close()


def test_not_enough_vram_fails_with_an_explanation_or_reduces_only_when_allowed(tmp_path: Path, gpu: dict[str, Any]) -> None:
    gpu["free_gb"] = 1.0
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, settings={"memory": MEM})
    assert done["error"]["code"] == "INSUFFICIENT_VRAM"
    assert "lower quality preset" in done["error"]["message"]
    assert "call" not in gpu, "nothing was generated"
    api.close()
    # With "allow lower resolution": still not enough at 1 GB (sequential needs ~4 GB) → same refusal,
    # but at 3.9 GB a smaller size fits and the reduction is recorded.
    gpu["free_gb"] = 3.2
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl(max_side=2048)), mock_models=False))
    done = image_job(api, settings={"memory": {**MEM, "allow_quality_reduction": True}})
    assert done["status"] == "complete", done
    adj = done["details"]["memory"]["adjustments"]
    assert any(a.startswith("quality reduced to fit VRAM") for a in adj), adj
    api.close()


def test_out_of_memory_is_retried_once_with_more_offload(tmp_path: Path, gpu: dict[str, Any]) -> None:
    gpu["oom_once"] = True
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, settings={"memory": MEM})
    assert done["status"] == "complete", done
    assert gpu["loads"] == 2, "reloaded with CPU offload"
    assert "model_offload" in gpu["switches"]
    assert any("out of memory" in a for a in done["details"]["memory"]["adjustments"])
    api.close()
    # Forced offload setting (not auto): no silent change, the job fails with advice.
    gpu["oom_once"] = True
    gpu["loads"] = 0
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, settings={"memory": {**MEM, "cpu_offload": "none"}})
    assert done["error"]["code"] == "OUT_OF_MEMORY"
    assert "sequential" in done["error"]["message"]
    api.close()


def test_character_references_use_the_ip_adapter(tmp_path: Path, gpu: dict[str, Any]) -> None:
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, sdxl()), mock_models=False))
    done = image_job(api, settings={"memory": MEM}, reference_images=[png_b64(64, 64), png_b64(48, 48)], reference_strength=0.7)
    assert done["status"] == "complete", done
    assert gpu["ip_adapter"]["repo"] == "h94/IP-Adapter"
    assert gpu["ip_adapter"]["subfolder"] == "sdxl_models"
    assert gpu["ip_adapter"]["image_encoder_folder"] == "models/image_encoder"
    assert gpu["ip_scale"] == 0.7
    assert isinstance(gpu["call"]["ip"], list) and len(gpu["call"]["ip"]) == 2
    assert done["details"]["reference"] == {"mode": "ip_adapter", "images": 2, "scale": 0.7}
    api.close()


def test_other_gpu_models_are_unloaded_first(tmp_path: Path, gpu: dict[str, Any]) -> None:
    cat = write_catalog(tmp_path, sdxl(), {**sdxl(), "id": "second", "default": False})
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    assert image_job(api, settings={"memory": MEM})["status"] == "complete"
    done = image_job(api, model="second", settings={"memory": MEM})
    assert done["status"] == "complete", done
    assert any("unloaded test-model" in line for line in done["logs"])
    assert not api.registry.resolve("image", "test-model").loaded
    api.close()


def test_request_validation_for_references_and_motion() -> None:
    from ais_worker.schemas import ValidationError, parse_image, parse_video

    too_many = {"prompt": "x", "reference_images": [png_b64(8, 8)] * 5}
    with pytest.raises(ValidationError):
        parse_image(too_many, 1024 * 1024)
    with pytest.raises(ValidationError):
        parse_image({"prompt": "x", "reference_images": ["not-base64!"]}, 1024 * 1024)
    ok = parse_image({"prompt": "x", "reference_images": [png_b64(8, 8)], "reference_strength": 0.5}, 1024 * 1024)
    assert len(ok.reference_images) == 1 and ok.reference_strength == 0.5
    v = parse_video({"image": png_b64(8, 8), "motion_strength": 0.2, "camera_movement": "slow push-in"}, 1024 * 1024)
    assert (v.motion_strength, v.camera_movement) == (0.2, "slow push-in")
    with pytest.raises(ValidationError):
        parse_video({"image": png_b64(8, 8), "motion_strength": 2}, 1024 * 1024)
