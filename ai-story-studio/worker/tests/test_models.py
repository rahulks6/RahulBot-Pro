from __future__ import annotations

from pathlib import Path
from typing import Any

from ais_worker.api import WorkerAPI

from .conftest import AUTH, make_config, post, wait


def test_models_endpoint_lists_mock_models(api: WorkerAPI) -> None:
    body = api.handle("GET", "/models", AUTH, b"").body or {}
    kinds = {m["kind"] for m in body["models"]}
    assert kinds == {"image", "video", "tts", "music", "sfx", "lipsync", "upscale"}
    assert body["mock_only"] is True


def test_model_is_loaded_once_across_jobs(api: WorkerAPI) -> None:
    for i in range(3):
        _, j = post(api, "/generate/image", {"prompt": f"p{i}", "width": 64, "height": 64})
        assert wait(api, j["id"])["status"] == "complete"
    assert api.registry.load_count("mock-image") == 1


def test_lru_unloading_keeps_at_most_two_models_loaded(api: WorkerAPI) -> None:
    bodies: list[dict[str, Any]] = [
        {"kind": "tts", "text": "hello"},
        {"kind": "music", "mood": "happy", "duration_sec": 1},
        {"kind": "sfx", "tag": "rain", "duration_sec": 1},
    ]
    for body in bodies:
        _, j = post(api, "/generate/audio", body)
        assert wait(api, j["id"])["status"] == "complete"
    loaded = [m for m in api.registry.describe() if m["loaded"]]
    assert len(loaded) <= 2


def test_audio_kinds_produce_wav(api: WorkerAPI) -> None:
    bodies: list[dict[str, Any]] = [
        {"kind": "tts", "text": "The rain grew stronger.", "emotion": "whispering", "voice_identity": "narrator-1"},
        {"kind": "music", "mood": "gentle suspense", "energy": "low", "duration_sec": 2},
        {"kind": "ambience", "tag": "forest", "duration_sec": 2},
        {"kind": "sfx", "tag": "thunder", "duration_sec": 1},
    ]
    for body in bodies:
        _, j = post(api, "/generate/audio", body)
        done = wait(api, j["id"])
        assert done["status"] == "complete", done
        assert done["outputs"][0]["mime"] == "audio/wav"
        assert done["outputs"][0]["duration_sec"] > 0.5


def test_unknown_model_and_real_models_disabled(tmp_path: Path) -> None:
    api = WorkerAPI(make_config(tmp_path, mock_models=False))
    res = api.handle("POST", "/generate/image", AUTH, b'{"prompt": "x"}')
    assert res.status == 409
    assert (res.body or {})["error"]["code"] == "MODEL_LOAD_FAILED"
    assert (api.handle("GET", "/models", AUTH, b"").body or {})["models"] == []
    api.close()


def test_diagnostics(api: WorkerAPI) -> None:
    sysinfo = api.handle("GET", "/system", AUTH, b"").body or {}
    for key in ["worker_version", "python", "cpu_count", "memory", "disk", "gpu", "ffmpeg", "models", "jobs", "mock_models"]:
        assert key in sysinfo
    assert "available" in sysinfo["gpu"]
