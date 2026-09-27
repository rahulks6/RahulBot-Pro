from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.server import make_handler

from .conftest import TOKEN, make_config


@pytest.fixture
def base(tmp_path: Path) -> Iterator[str]:
    api = WorkerAPI(make_config(tmp_path, max_upload_bytes=1024 * 1024))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(api))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()
    api.close()


def call(
    url: str, method: str = "GET", body: Any = None, token: str | None = TOKEN, raw: bytes | None = None
) -> tuple[int, bytes, dict[str, str]]:
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def test_end_to_end_over_http(base: str) -> None:
    assert call(f"{base}/health", token=None)[0] == 200
    assert call(f"{base}/models", token=None)[0] == 401
    status, body, _ = call(f"{base}/generate/audio", "POST", {"kind": "tts", "text": "Hello from the worker"})
    assert status == 202
    job_id = json.loads(body)["id"]
    for _ in range(200):
        job = json.loads(call(f"{base}/jobs/{job_id}")[1])
        if job["status"] == "complete":
            break
        time.sleep(0.02)
    assert job["status"] == "complete"
    status, data, headers = call(f"{base}/jobs/{job_id}/files/audio.wav")
    assert status == 200 and headers["Content-Type"] == "audio/wav"
    assert hashlib.sha256(data).hexdigest() == job["outputs"][0]["sha256"]
    assert headers["X-Content-Type-Options"] == "nosniff"
    listing = json.loads(call(f"{base}/jobs")[1])
    assert any(j["id"] == job_id for j in listing["jobs"])


def test_http_rejections(base: str) -> None:
    assert call(f"{base}/generate/image", "POST", {"prompt": "x"}, token="wrong")[0] == 401
    assert call(f"{base}/generate/image", "POST", {"prompt": "x", "rm -rf": 1})[0] == 422
    assert call(f"{base}/jobs/job_0123456789abcdef")[0] == 404
    assert call(f"{base}/jobs/job_0123456789abcdef/files/..%2Fjob.json")[0] in {403, 404}
    too_big = b'{"prompt": "' + b"x" * (3 * 1024 * 1024) + b'"}'
    try:
        status = call(f"{base}/generate/image", "POST", raw=too_big)[0]
    except urllib.error.URLError:
        status = 413  # server refused the body before reading it and closed the connection
    assert status == 413
    assert call(f"{base}/health", token=None)[0] == 200, "worker still healthy after the rejected upload"
