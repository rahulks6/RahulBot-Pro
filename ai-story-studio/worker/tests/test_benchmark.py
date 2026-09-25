from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.benchmark import DEFAULT_SUITE, run_cli, validate_suite

from .conftest import AUTH, TOKEN, has_ffmpeg, make_config, post, wait
from .test_catalog_adapters import entry, write_catalog

SMALL_SUITE: dict[str, Any] = {
    "name": "small",
    "image": {"seeds": [1, 2], "repeat_seed_check": True, "width": 320, "height": 180, "cases": [{"key": "a", "prompt": "a fox"}]},
    "video": {"seed": 3, "fps": 24, "width": 320, "height": 180, "cases": [{"key": "push", "motion_prompt": "push in", "duration_sec": 1}]},
    "tts": {"cases": [{"key": "line", "text": "Hello there friend", "emotion": "calm"}]},
    "upscale": {"cases": [{"key": "up", "target_width": 320, "target_height": 180, "source_width": 160, "source_height": 90}]},
}


def results(api: WorkerAPI, job_id: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(api.jobs.output_path(job_id, "results.json").read_text())
    return data


def test_default_suite_is_valid() -> None:
    validate_suite(DEFAULT_SUITE, 64 * 1024 * 1024)
    assert len(DEFAULT_SUITE["image"]["cases"]) >= 4


def test_mock_benchmark_end_to_end(api: WorkerAPI) -> None:
    status, job = post(
        api,
        "/benchmarks",
        {
            "suite": SMALL_SUITE,
            "include_mock": True,
            "models": ["mock-image", "mock-tts", "mock-upscaler"] + (["mock-video"] if has_ffmpeg() else []),
        },
    )
    assert status == 202, job
    done = wait(api, job["id"], timeout=120)
    assert done["status"] == "complete", done
    report = results(api, job["id"])
    s = report["summary"]
    assert s["mock-image"]["runs"] == 3 and s["mock-image"]["success_rate"] == 1.0
    assert s["mock-image"]["reproducible_same_seed"] is True
    assert s["mock-image"]["load_seconds"] is not None and s["mock-image"]["mean_run_seconds"] is not None
    tts = next(r for r in report["results"] if r["model"] == "mock-tts")
    assert tts["checks"]["clipped_samples"] == 0 and 0 < tts["checks"]["duration_sec"] < 5
    up = next(r for r in report["results"] if r["model"] == "mock-upscaler")
    assert up["checks"]["native_resolution"] is False
    if has_ffmpeg():
        vid = next(r for r in report["results"] if r["model"] == "mock-video")
        assert vid["checks"]["codec"] == "h264"
    for r in report["results"]:
        res = api.handle("GET", f"/jobs/{job['id']}/files/{r['output']}", AUTH, b"")
        assert res.status == 200, r["output"]
    assert "gpu" in report and all(m["mock"] for m in report["models"])


def test_benchmark_requires_real_models_unless_mock_requested(api: WorkerAPI) -> None:
    status, body = post(api, "/benchmarks", {})
    assert status == 409 and "no benchmarkable models" in body["error"]["message"]
    status, body = post(api, "/benchmarks", {"models": ["flux-nope"], "include_mock": True})
    assert status == 409 and "flux-nope" in body["error"]["message"]


def test_benchmark_validates_the_suite(api: WorkerAPI) -> None:
    bad = {"image": {"cases": [{"key": "x", "prompt": "", "width": 99999}]}, "tts": {"cases": []}}
    status, body = post(api, "/benchmarks", {"suite": bad, "include_mock": True})
    assert status == 422
    paths = {d["path"] for d in body["error"]["details"]}
    assert {"suite.image.cases[0].prompt", "suite.image.cases[0].width", "suite.tts.cases"} <= paths


def test_a_broken_model_is_recorded_as_unreliable_not_fatal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", None)
    path = write_catalog(tmp_path, entry(id="broken-image"))
    api = WorkerAPI(make_config(tmp_path, models_file=path))
    status, job = post(
        api, "/benchmarks", {"suite": {"image": SMALL_SUITE["image"]}, "models": ["broken-image", "mock-image"], "include_mock": True}
    )
    assert status == 202
    assert wait(api, job["id"], timeout=60)["status"] == "complete"
    s = results(api, job["id"])["summary"]
    assert s["broken-image"]["success_rate"] == 0.0 and s["broken-image"]["errors"] == ["MODEL_LOAD_FAILED"]
    assert s["mock-image"]["success_rate"] == 1.0
    api.close()


def test_benchmark_can_be_cancelled(api: WorkerAPI) -> None:
    suite = {
        "image": {"seeds": [1, 2, 3, 4, 5], "cases": [{"key": f"c{i}", "prompt": "p", "settings": {"mock_delay_sec": 1}} for i in range(5)]}
    }
    _, job = post(api, "/benchmarks", {"suite": suite, "include_mock": True, "models": ["mock-image"]})
    time.sleep(0.3)
    api.handle("POST", f"/jobs/{job['id']}/cancel", AUTH, b"")
    assert wait(api, job["id"], timeout=5)["status"] == "cancelled"


def test_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_AUTH_TOKEN", TOKEN)
    monkeypatch.setenv("WORKER_DATA_DIR", str(tmp_path))
    suite = tmp_path / "suite.json"
    suite.write_text(json.dumps({"tts": SMALL_SUITE["tts"]}))
    lines: list[str] = []
    assert run_cli(["--include-mock", "--models", "mock-tts", "--suite", str(suite)], out=lines.append) == 0
    assert any(line.startswith("mock-tts") and "ok 1/1" in line for line in lines)
    assert run_cli([], out=lines.append) == 1, "no real models enabled → clear failure"
