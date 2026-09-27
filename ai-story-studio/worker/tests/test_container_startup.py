"""The cloud container's start-up contract, checked without Docker or a GPU.

Reads worker/Dockerfile.cuda (ENV, EXPOSE, HEALTHCHECK, CMD) and starts the worker exactly as
that CMD would, with that environment, as a separate process. Then it checks what Story Studio
relies on after RunPod starts the pod: the worker starts by itself, listens on the configured
interface and port, answers /health with readiness only, requires the session token everywhere
else, reports capabilities and GPU/CUDA information, accepts and cancels jobs, returns job
metadata, and exits cleanly on SIGTERM. The real AI libraries are not installed here, so jobs are
expected to fail cleanly instead of producing output; nothing is downloaded.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

WORKER_DIR = Path(__file__).resolve().parents[1]
DOCKERFILE = WORKER_DIR / "Dockerfile.cuda"
TOKEN = "aisw_" + "b" * 64


def dockerfile() -> dict[str, Any]:
    text = DOCKERFILE.read_text().replace("\\\n", " ")
    env: dict[str, str] = {}
    for m in re.finditer(r"^ENV\s+(.+)$", text, re.MULTILINE):
        for part in shlex.split(m.group(1)):
            key, _, value = part.partition("=")
            env[key] = value
    cmd = json.loads(re.search(r"^CMD\s+(\[.*\])\s*$", text, re.MULTILINE).group(1))  # type: ignore[union-attr]
    expose = re.search(r"^EXPOSE\s+(\d+)", text, re.MULTILINE).group(1)  # type: ignore[union-attr]
    health = re.search(r"^HEALTHCHECK.*$", text, re.MULTILINE).group(0)  # type: ignore[union-attr]
    return {"env": env, "cmd": cmd, "expose": expose, "healthcheck": health, "text": text}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def call(url: str, method: str = "GET", body: Any = None, token: str | None = TOKEN) -> tuple[int, Any]:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def test_dockerfile_contract() -> None:
    d = dockerfile()
    env = d["env"]
    assert d["cmd"] == ["python", "-m", "ais_worker"], "the worker starts automatically as the container command"
    assert env["WORKER_HOST"] == "0.0.0.0", "reachable through RunPod's proxy (all interfaces)"
    assert env["WORKER_PORT"] == d["expose"] == "8765", "the port the app asks RunPod to expose"
    assert f"127.0.0.1:{env['WORKER_PORT']}/health" in d["healthcheck"]
    assert env["WORKER_MOCK_MODELS"] == "false"
    assert env["WORKER_ALLOW_NONCOMMERCIAL"] == "false"
    # Model weights, caches and job files live on the /workspace volume, never in the image.
    for key in ("WORKER_MODEL_CACHE_DIR", "HF_HOME", "WORKER_DATA_DIR"):
        assert env[key].startswith("/workspace/"), key
    assert "WORKER_AUTH_TOKEN" not in env, "no token is baked into the image"
    assert not re.search(r"(rpa_|hf_|ghp_|github_pat_)[A-Za-z0-9]", d["text"]), "no credential in the Dockerfile"
    assert "from_pretrained" not in d["text"] and "huggingface-cli download" not in d["text"], "no weights baked in"


@pytest.fixture
def container(tmp_path: Path) -> Iterator[tuple[str, subprocess.Popen[bytes]]]:
    d = dockerfile()
    port = free_port()
    env = {**os.environ, **d["env"]}
    env.update(
        WORKER_AUTH_TOKEN=TOKEN,  # the app passes a fresh token to every pod
        WORKER_PORT=str(port),
        WORKER_DATA_DIR=str(tmp_path / "workspace" / "worker-data"),
        WORKER_MODEL_CACHE_DIR=str(tmp_path / "workspace" / "models"),
        HF_HOME=str(tmp_path / "workspace" / "hf"),
        WORKER_MODELS_FILE=str(WORKER_DIR / "models.cloud.json"),
        WORKER_ENABLED_MODELS="flux1-schnell,wan2.2-ti2v-5b,kokoro-82m,ffmpeg-lanczos",
        HF_HUB_OFFLINE="1",  # never download anything in tests
        PYTHONPATH=str(WORKER_DIR),
    )
    cmd = [sys.executable if c == "python" else c for c in d["cmd"]]
    proc = subprocess.Popen(cmd, cwd=WORKER_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(200):
            if proc.poll() is not None:
                pytest.fail(f"worker exited during start-up: {proc.stdout.read().decode() if proc.stdout else ''}")
            try:
                if call(f"{base}/health", token=None)[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.05)
        yield base, proc
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=10)


def test_worker_starts_and_serves_the_cloud_contract(container: tuple[str, subprocess.Popen[bytes]]) -> None:
    base, _ = container
    status, health = call(f"{base}/health", token=None)
    assert status == 200
    assert health == {"status": "ok", "version": health["version"], "ready": True}, "readiness only, nothing else"

    for method, path in [
        ("GET", "/models"),
        ("GET", "/system"),
        ("GET", "/jobs"),
        ("POST", "/generate/image"),
        ("POST", "/generate/audio"),
    ]:
        assert call(f"{base}{path}", method, {} if method == "POST" else None, token=None)[0] == 401, path
        assert call(f"{base}{path}", method, {} if method == "POST" else None, token="aisw_wrong" + "0" * 60)[0] == 401, path

    status, models = call(f"{base}/models")
    assert status == 200 and models["mock_only"] is False
    by_id = {m["id"]: m for m in models["models"]}
    assert {"flux1-schnell", "wan2.2-ti2v-5b", "kokoro-82m"} <= set(by_id)
    assert "image_to_video" in by_id["wan2.2-ti2v-5b"]["capabilities"]
    assert all(not m["mock"] for m in models["models"])
    assert all("cached" in m and "storage_gb" in m for m in models["models"])

    status, system = call(f"{base}/system")
    assert status == 200
    assert {"available", "gpus"} <= set(system["gpu"]), "GPU information for the app's readiness check"
    assert {"installed", "cuda_available"} <= set(system["torch"])
    assert system["mock_models"] is False

    # A job is accepted, reports metadata, and can be cancelled. (No AI library here, so it cannot succeed.)
    status, job = call(f"{base}/generate/audio", "POST", {"kind": "tts", "text": "Hello from the cloud."})
    assert status == 202, job
    assert job["id"].startswith("job_") and job["status"] in {"queued", "running"}
    status, _ = call(f"{base}/jobs/{job['id']}/cancel", "POST")
    assert status in {200, 409}
    for _ in range(100):
        status, job = call(f"{base}/jobs/{job['id']}")
        if job["status"] in {"complete", "failed", "cancelled"}:
            break
        time.sleep(0.05)
    assert job["status"] in {"failed", "cancelled"}
    assert {"id", "kind", "status", "outputs", "metrics", "error"} <= set(job)


def test_worker_refuses_to_start_without_a_token(tmp_path: Path) -> None:
    d = dockerfile()
    env = {**os.environ, **d["env"], "WORKER_DATA_DIR": str(tmp_path), "WORKER_PORT": str(free_port()), "PYTHONPATH": str(WORKER_DIR)}
    env.pop("WORKER_AUTH_TOKEN", None)
    out = subprocess.run([sys.executable, "-m", "ais_worker"], cwd=WORKER_DIR, env=env, capture_output=True, timeout=30, check=False)
    assert out.returncode != 0
    assert b"WORKER_AUTH_TOKEN" in out.stdout + out.stderr


def test_worker_exits_cleanly_on_sigterm(container: tuple[str, subprocess.Popen[bytes]]) -> None:
    _, proc = container
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=15) == 0, "RunPod stops pods with SIGTERM; the worker must exit cleanly"
