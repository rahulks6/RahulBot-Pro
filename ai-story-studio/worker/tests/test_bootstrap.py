"""The pod bootstrap (worker/bootstrap/ais_bootstrap.py), run exactly as a RunPod pod runs it.

The script is started through the same `python -c` entrypoint the app gives RunPod, with the
script in AIS_BOOTSTRAP, from an empty folder (no worker code on the "pod"). The test uploads the
worker code archive like the app does and checks: /health says bootstrapping, the status and
upload endpoints need the session token, a wrong checksum and unsafe archives are refused, and
after a good upload the process replaces itself with the real worker on the same port. Library
installation is skipped (offline test machine); everything else is the production path.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tests.test_container_startup import free_port

WORKER_DIR = Path(__file__).resolve().parents[1]
SCRIPT = WORKER_DIR / "bootstrap" / "ais_bootstrap.py"
TOKEN = "aisw_" + "c" * 64
ENTRYPOINT = [
    sys.executable,
    "-c",
    "import base64,os;exec(compile(base64.b64decode(os.environ['AIS_BOOTSTRAP']),'ais_bootstrap','exec'))",
]


def bundle(extra: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:

        def add(name: str, data: bytes) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))

        for path in sorted((WORKER_DIR / "ais_worker").rglob("*.py")):
            add(str(path.relative_to(WORKER_DIR)), path.read_bytes())
        add("models.cloud.json", (WORKER_DIR / "models.cloud.json").read_bytes())
        add("requirements-cloud.txt", (WORKER_DIR / "requirements-cloud.txt").read_bytes())
        for name, data in (extra or {}).items():
            add(name, data)
    return buf.getvalue()


def call(url: str, method: str = "GET", data: bytes | None = None, token: str | None = TOKEN) -> tuple[int, Any]:
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def start(tmp_path: Path, code: bytes) -> tuple[subprocess.Popen[bytes], str]:
    port = free_port()
    pod = tmp_path / "pod"
    pod.mkdir()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "AIS_BOOTSTRAP": base64.b64encode(SCRIPT.read_bytes()).decode(),
        "AIS_CODE_SHA256": hashlib.sha256(code).hexdigest(),
        "AIS_APP_DIR": str(pod / "app"),
        "AIS_PYENV_ROOT": str(pod / "ais-pyenv"),
        "AIS_BOOTSTRAP_SKIP_SYSTEM": "1",
        "AIS_BOOTSTRAP_SKIP_PIP": "1",
        "AIS_BOOTSTRAP_FAIL_LINGER_S": "1",
        "WORKER_AUTH_TOKEN": TOKEN,
        "WORKER_HOST": "127.0.0.1",
        "WORKER_PORT": str(port),
        "WORKER_DATA_DIR": str(pod / "worker-data"),
        "WORKER_MODEL_CACHE_DIR": str(pod / "models"),
        "HF_HOME": str(pod / "hf"),
        "HF_HUB_OFFLINE": "1",
        "WORKER_MOCK_MODELS": "false",
    }
    proc = subprocess.Popen(ENTRYPOINT, cwd=pod, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try:
            if call(f"{base}/health", token=None)[0] == 200:
                return proc, base
        except OSError:
            time.sleep(0.05)
    proc.kill()
    raise AssertionError("bootstrap did not start listening")


@pytest.fixture
def stop() -> Iterator[list[subprocess.Popen[bytes]]]:
    procs: list[subprocess.Popen[bytes]] = []
    yield procs
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait(timeout=10)


def test_bootstrap_hands_over_to_the_real_worker(tmp_path: Path, stop: list[subprocess.Popen[bytes]]) -> None:
    code = bundle()
    proc, base = start(tmp_path, code)
    stop.append(proc)
    assert call(f"{base}/health", token=None) == (200, {"status": "bootstrapping", "stage": "waiting_for_code"})
    assert call(f"{base}/bootstrap/status", token=None)[0] == 401
    assert call(f"{base}/bootstrap/status", token="wrong-token-0000000000")[0] == 401
    assert call(f"{base}/bootstrap/code", "POST", code, token=None)[0] == 401
    status, body = call(f"{base}/bootstrap/code", "POST", code + b"x")
    assert status == 400 and "checksum" in body["error"]
    assert call(f"{base}/bootstrap/status")[1]["stage"] == "waiting_for_code", "a refused upload changes nothing"
    status, body = call(f"{base}/bootstrap/code", "POST", code)
    assert status == 202 and body["sha256"] == hashlib.sha256(code).hexdigest()
    # The same process becomes the worker, on the same port.
    health: Any = None
    for _ in range(300):
        try:
            health = call(f"{base}/health", token=None)[1]
            if health.get("status") == "ok":
                break
        except OSError:
            pass
        time.sleep(0.05)
    assert health and health["status"] == "ok", health
    assert proc.poll() is None, "exec keeps the pod's main process"
    code_, system = call(f"{base}/system")
    assert code_ == 200 and "gpu" in system, system
    assert system["installed_packages"] == [], "no libraries installed in test mode, so none are reported"
    assert call(f"{base}/system", token=None)[0] == 401
    assert (tmp_path / "pod" / "app" / "ais_worker" / "server.py").exists()


def test_bootstrap_refuses_unsafe_archives(tmp_path: Path, stop: list[subprocess.Popen[bytes]]) -> None:
    code = bundle({"../escape.txt": b"no"})
    proc, base = start(tmp_path, code)
    stop.append(proc)
    assert call(f"{base}/bootstrap/code", "POST", code)[0] == 202
    for _ in range(200):
        st = call(f"{base}/bootstrap/status")[1]
        if st["stage"] == "failed":
            break
        time.sleep(0.05)
    assert st["stage"] == "failed" and "unsafe path" in st["error"], st
    assert not (tmp_path / "escape.txt").exists()
    proc.wait(timeout=30)
    assert proc.returncode == 4


def test_bootstrap_requires_token_and_checksum(tmp_path: Path) -> None:
    env = {"PATH": os.environ.get("PATH", ""), "AIS_BOOTSTRAP": base64.b64encode(SCRIPT.read_bytes()).decode()}
    proc = subprocess.run(ENTRYPOINT, env=env, capture_output=True, timeout=30, cwd=tmp_path, check=False)
    assert proc.returncode == 2
    assert b"WORKER_AUTH_TOKEN and AIS_CODE_SHA256 are required" in proc.stdout


def test_worker_reports_the_libraries_the_bootstrap_installed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from ais_worker.diagnostics import installed_packages

    listing = tmp_path / "installed-packages.txt"
    listing.write_text("diffusers==0.35.1\nkokoro==0.9.4\n\nnot a pin\ntorch==2.7.1\n")
    monkeypatch.setenv("AIS_INSTALLED_FILE", str(listing))
    assert installed_packages() == ["diffusers==0.35.1", "kokoro==0.9.4", "torch==2.7.1"]
    monkeypatch.setenv("AIS_INSTALLED_FILE", str(tmp_path / "missing.txt"))
    assert installed_packages() == []


def test_worker_reports_the_model_commits_in_the_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from ais_worker.diagnostics import model_revisions

    refs = tmp_path / "models--black-forest-labs--FLUX.1-schnell" / "refs"
    refs.mkdir(parents=True)
    (refs / "main").write_text("741f7c3ce8b383c54771c7003378a50191e9efe9\n")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    assert model_revisions() == {"black-forest-labs/FLUX.1-schnell@main": "741f7c3ce8b383c54771c7003378a50191e9efe9"}
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "none"))
    assert model_revisions() == {}
