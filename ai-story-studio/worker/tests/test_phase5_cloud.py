"""Phase 5 worker features: pod-side dead-man switch, per-session model
selection and licence acknowledgements, cached-weights reporting, the cloud
catalog, reference-guided image-to-image and the strict image-to-video check."""

from __future__ import annotations

import io
import json
import sys
import threading
import types
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.catalog import load_catalog
from ais_worker.pod_guard import PodGuard

from .conftest import AUTH, make_config, png_b64, post, wait
from .test_catalog_adapters import CALLS, FakeImage, entry, fake_pil, fake_torch, write_catalog

CLOUD_CATALOG = Path(__file__).resolve().parent.parent / "models.cloud.json"


# --- pod guard ------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *a: Any) -> None: ...


def test_guard_only_runs_on_studio_cloud_pods() -> None:
    assert PodGuard.from_env({}) is None, "a local worker has no guard"
    g = PodGuard.from_env({"AIS_POD_IDLE_MIN": "20", "RUNPOD_POD_ID": "abc", "RUNPOD_API_KEY": "podkey"})
    assert g is not None and g.idle_s == 1200 and g.max_lifetime_s is None


def test_guard_terminates_on_idle_and_lifetime_and_activity_resets_idle() -> None:
    clock = Clock()
    calls: list[tuple[str, str, str | None]] = []

    def opener(req: Any, timeout: float) -> FakeResponse:
        calls.append((req.get_method(), req.full_url, req.get_header("Authorization")))
        return FakeResponse(204)

    g = PodGuard(max_lifetime_min=60, idle_min=20, pod_id="pod1", api_key="podkey", clock=clock, opener=opener)
    clock.t += 19 * 60
    assert g.check() is False
    g.touch()
    clock.t += 19 * 60
    assert g.reason() is None, "activity resets the idle timer"
    clock.t += 2 * 60
    assert g.reason() == "idle"
    assert g.check() is True
    assert calls == [("DELETE", "https://api.runpod.io/v2/pods/pod1", "Bearer podkey")]
    assert g.check() is True and len(calls) == 1, "terminates once"
    g2 = PodGuard(max_lifetime_min=30, idle_min=None, pod_id="p", api_key="k", clock=clock, opener=opener)
    clock.t += 31 * 60
    assert g2.reason() == "max_lifetime"


def test_guard_falls_back_to_the_action_endpoint_and_reports_failure() -> None:
    statuses = iter([405, 200])
    seen: list[str] = []

    def opener(req: Any, timeout: float) -> FakeResponse:
        seen.append(f"{req.get_method()} {req.full_url} {req.data!r}")
        status = next(statuses)
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "no", {}, io.BytesIO())  # type: ignore[arg-type]
        return FakeResponse(status)

    g = PodGuard(max_lifetime_min=1, idle_min=None, pod_id="p9", api_key="k", opener=opener)
    assert g.terminate("max_lifetime") is True
    assert seen[1] == 'POST https://api.runpod.io/v2/pods/p9/action b\'{"action": "terminate"}\''
    assert PodGuard(max_lifetime_min=1, idle_min=None, pod_id=None, api_key=None).terminate("x") is False


def test_guard_talks_to_a_real_http_endpoint() -> None:
    hits: list[tuple[str, str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_DELETE(self) -> None:
            hits.append((self.command, self.path, self.headers.get("Authorization", "")))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a: Any) -> None: ...

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        g = PodGuard(
            max_lifetime_min=None,
            idle_min=1,
            pod_id="podX",
            api_key="podkey",
            api_base=f"http://127.0.0.1:{server.server_port}/v2",
        )
        assert g.terminate("idle") is True
        assert hits == [("DELETE", "/v2/pods/podX", "Bearer podkey")]
    finally:
        server.shutdown()
    with pytest.raises(OSError):
        PodGuard(max_lifetime_min=1, idle_min=None, pod_id="p", api_key="k", api_base="http://evil.example")._request("DELETE", "/x")


def test_authenticated_requests_feed_the_guard(tmp_path: Path) -> None:
    api = WorkerAPI(make_config(tmp_path))
    ticks: list[int] = []
    api.on_activity = lambda: ticks.append(1)
    api.handle("GET", "/health", {}, b"")
    api.handle("GET", "/models", {"authorization": "Bearer wrong"}, b"")
    assert ticks == []
    api.handle("GET", "/models", AUTH, b"")
    assert ticks == [1]
    api.close()


# --- model selection, licences, cache state, cloud catalog -------------------------------------


def test_session_selection_and_licence_acknowledgement(tmp_path: Path) -> None:
    path = write_catalog(
        tmp_path,
        entry(id="up-a", kind="upscale", adapter="ffmpeg_upscale", enabled=False, default=False, params={}),
        entry(id="up-cond", kind="upscale", adapter="ffmpeg_upscale", commercial_use="conditional", default=False, params={}),
        entry(id="up-off", kind="upscale", adapter="ffmpeg_upscale", default=False, params={}),
    )
    cfg = make_config(
        tmp_path, models_file=path, mock_models=False, enabled_models=frozenset({"up-a", "up-cond"}), license_ack=frozenset({"up-cond"})
    )
    api = WorkerAPI(cfg)
    body = api.handle("GET", "/models", AUTH, b"").body or {}
    ids = {m["id"] for m in body["models"]}
    assert ids == {"up-a", "up-cond"}, "the app's selection replaces the catalog flags; the ack unlocks the conditional one"
    reasons = {s["id"]: s["reason"] for s in body["catalog_skipped"]}
    assert reasons["up-off"] == "not selected for this session"
    m = next(x for x in body["models"] if x["id"] == "up-a")
    assert m["cached"] is True, "no downloadable weights"
    api.close()
    cfg2 = make_config(tmp_path, models_file=path, mock_models=False, enabled_models=frozenset({"up-cond"}))
    api2 = WorkerAPI(cfg2)
    skipped = (api2.handle("GET", "/models", AUTH, b"").body or {})["catalog_skipped"]
    assert "license_acknowledged" in json.dumps(skipped)
    assert not api2.registry.describe(), "conditional licence without acknowledgement is still refused"
    api2.close()


def test_worker_config_reads_selection_from_env(tmp_path: Path) -> None:
    from ais_worker.config import WorkerConfig

    c = WorkerConfig.from_env({"WORKER_AUTH_TOKEN": "t" * 32, "WORKER_ENABLED_MODELS": "a, b", "WORKER_LICENSE_ACK": "b"})
    assert c.enabled_models == frozenset({"a", "b"}) and c.license_ack == frozenset({"b"})
    assert WorkerConfig.from_env({"WORKER_AUTH_TOKEN": "t" * 32}).enabled_models is None


def test_cached_state_follows_the_hugging_face_layout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", fake_torch())
    path = write_catalog(tmp_path, entry(repo="org/test"))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False, model_cache_dir=tmp_path / "cache"))
    assert api.registry.describe()[0]["cached"] is False
    (tmp_path / "cache" / "hub" / "models--org--test").mkdir(parents=True)
    assert api.registry.describe()[0]["cached"] is True
    api.close()


def test_cloud_catalog_is_valid_and_commercially_safe() -> None:
    entries = load_catalog(CLOUD_CATALOG)
    assert all(e.commercial_use in ("allowed", "conditional") for e in entries), "no non-commercial or unknown models in the cloud image"
    defaults = {e.kind for e in entries if e.enabled and e.default}
    assert {"image", "video", "tts", "music", "sfx", "upscale"} <= defaults
    wan = next(e for e in entries if e.kind == "video" and e.enabled)
    assert wan.params["pipeline_class"] == "WanImageToVideoPipeline"
    assert all(e.recommended_vram_gb >= e.min_vram_gb and e.capabilities for e in entries)


# --- diffusers: pipeline class, image-to-image, strict image-to-video -------------------------------


class FakeImg2Img:
    def __call__(self, prompt: str, image: FakeImage, strength: float = 0.6, num_inference_steps: int = 4, generator: Any = None,
                 callback_on_step_end: Any = None) -> Any:  # fmt: skip
        CALLS["img2img"] = {"strength": strength, "image": (image.width, image.height), "prompt": prompt}
        return types.SimpleNamespace(images=[FakeImage(image.width, image.height)])


class FakeT2VOnly:
    """A text-to-video pipeline: no `image` argument."""

    def __call__(self, prompt: str, num_frames: int = 33, generator: Any = None, output_type: str = "pil") -> Any:
        raise AssertionError("must never be called for image-to-video")

    def to(self, _d: str) -> FakeT2VOnly:
        return self


@pytest.fixture
def img_fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    CALLS.clear()
    from .test_catalog_adapters import FakeImagePipe

    diffusers = types.ModuleType("diffusers")

    class DiffusionPipeline:
        @staticmethod
        def from_pretrained(repo: str, **kw: Any) -> Any:
            CALLS["loader"] = "DiffusionPipeline"
            return FakeT2VOnly() if "t2v" in repo else FakeImagePipe()

    class FluxPipeline:
        @staticmethod
        def from_pretrained(repo: str, **kw: Any) -> Any:
            CALLS["loader"] = "FluxPipeline"
            return FakeImagePipe()

    class AutoPipelineForImage2Image:
        @staticmethod
        def from_pipe(pipe: Any) -> FakeImg2Img:
            return FakeImg2Img()

    diffusers.DiffusionPipeline = DiffusionPipeline  # type: ignore[attr-defined]
    diffusers.FluxPipeline = FluxPipeline  # type: ignore[attr-defined]
    diffusers.AutoPipelineForImage2Image = AutoPipelineForImage2Image  # type: ignore[attr-defined]
    for name, mod in {"torch": fake_torch(), "diffusers": diffusers, **fake_pil()}.items():
        monkeypatch.setitem(sys.modules, name, mod)


def test_reference_guided_image_to_image(tmp_path: Path, img_fakes: None) -> None:
    params = {"max_side": 512, "num_inference_steps": 4, "pipeline_class": "FluxPipeline", "img2img_strength": 0.8}
    api = WorkerAPI(make_config(tmp_path, models_file=write_catalog(tmp_path, entry(params=params)), mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "the fox in a forest", "init_image": png_b64(64, 64), "width": 512, "height": 512})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert CALLS["loader"] == "FluxPipeline", "explicit pipeline class used"
    assert CALLS["img2img"] == {"strength": 0.8, "image": (512, 512), "prompt": "the fox in a forest"}
    assert any("reference-guided" in line for line in done["logs"])
    _, job2 = post(api, "/generate/image", {"prompt": "p", "init_image": png_b64(), "strength": 0.3})
    wait(api, job2["id"])
    assert CALLS["img2img"]["strength"] == 0.3, "per-request strength wins"
    status, _ = post(api, "/generate/image", {"prompt": "p", "strength": 3})
    assert status == 422
    api.close()


def test_image_to_video_never_falls_back_to_text_to_video(tmp_path: Path, img_fakes: None) -> None:
    path = write_catalog(tmp_path, entry(id="vid", kind="video", adapter="diffusers_i2v", repo="org/t2v-model", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image-to-video", {"image": png_b64(64, 36), "duration_sec": 1, "fps": 24})
    done = wait(api, job["id"])
    assert done["error"]["code"] == "VIDEO_GENERATION_FAILED"
    assert "no image input" in done["error"]["message"] and "Refusing" in done["error"]["message"]
    api.close()


def test_unknown_pipeline_class_is_a_clear_load_error(tmp_path: Path, img_fakes: None) -> None:
    path = write_catalog(tmp_path, entry(params={"pipeline_class": "NoSuchPipeline"}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/generate/image", {"prompt": "x"})
    done = wait(api, job["id"])
    assert done["error"]["code"] == "MODEL_LOAD_FAILED" and "NoSuchPipeline" in done["error"]["message"]
    api.close()
