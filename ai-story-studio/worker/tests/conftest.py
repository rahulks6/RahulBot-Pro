from __future__ import annotations

import base64
import shutil
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.config import WorkerConfig
from ais_worker.models.mock import encode_png

TOKEN = "t" * 32
AUTH = {"authorization": f"Bearer {TOKEN}"}


def make_config(tmp_path: Path, **over: Any) -> WorkerConfig:
    import os

    cfg = WorkerConfig(
        auth_token=TOKEN,
        data_dir=tmp_path,
        ffmpeg_path=os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg"),
        ffprobe_path=os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe"),
        job_timeout_seconds=120,
    )
    return replace(cfg, **over)


@pytest.fixture
def api(tmp_path: Path) -> Iterator[WorkerAPI]:
    a = WorkerAPI(make_config(tmp_path))
    yield a
    a.close()


@pytest.fixture
def api_no_ffmpeg(tmp_path: Path) -> Iterator[WorkerAPI]:
    a = WorkerAPI(make_config(tmp_path, ffmpeg_path=None, ffprobe_path=None))
    yield a
    a.close()


def png_b64(width: int = 64, height: int = 36) -> str:
    return base64.b64encode(encode_png(width, height, lambda x, y: (x % 256, y % 256, 128))).decode()


def wait(api: WorkerAPI, job_id: str, timeout: float = 60) -> dict[str, Any]:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        job = api.jobs.get(job_id).public()
        if job["status"] in {"complete", "failed", "cancelled"}:
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def post(api: WorkerAPI, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    import json

    res = api.handle("POST", path, AUTH, json.dumps(body).encode())
    return res.status, res.body or {}


def has_ffmpeg() -> bool:
    import os

    return bool((os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")) and (os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe")))
