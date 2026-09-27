"""AI Story Studio pod bootstrap: no custom image, no registry, no GitHub needed.

A RunPod pod is started from a public PyTorch + CUDA image. This standard-library script is passed
to it (base64 in ``AIS_BOOTSTRAP``) and started as the container command. It:

1. listens on the worker port and waits for the app to upload its own bundled worker code
   (``POST /bootstrap/code``, authenticated with the per-session ``WORKER_AUTH_TOKEN``; the
   archive must match ``AIS_CODE_SHA256``, which the app fixed when it created the pod);
2. installs FFmpeg / espeak-ng if missing, and the worker's pinned Python libraries (kept on
   ``/workspace`` and reused when that is a network volume) without replacing the image's PyTorch;
3. stops listening and replaces itself with the worker (``python -m ais_worker``) on the same port.

``GET /health`` (no token) reports ``bootstrapping``; ``GET /bootstrap/status`` (token) reports the
stage and, on failure, the reason. If no code arrives in time, or setup fails and nobody collects
the failure, the pod terminates itself with its pod-scoped RunPod credentials (the app's own
timers terminate it too; this is the backup).
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "1"
MAX_CODE_BYTES = 32 * 1024 * 1024


class State:
    def __init__(self) -> None:
        self.stage = "waiting_for_code"
        self.detail = "waiting for AI Story Studio to send the worker code"
        self.error: str | None = None
        self.started = time.monotonic()
        self.lock = threading.Lock()

    def set(self, stage: str, detail: str, error: str | None = None) -> None:
        with self.lock:
            self.stage, self.detail, self.error = stage, detail, error
        print(f"[ais-bootstrap] {stage}: {detail}{' | ' + error if error else ''}", flush=True)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "stage": self.stage,
                "detail": self.detail,
                "error": self.error,
                "seconds": round(time.monotonic() - self.started),
                "bootstrap_version": VERSION,
            }


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def safe_extract(data: bytes, dest: Path) -> list[str]:
    """Extract a tar.gz into dest; refuses absolute paths, '..' and links."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    names: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            target = (root / m.name).resolve()
            if m.name.startswith("/") or ".." in Path(m.name).parts or not str(target).startswith(str(root)):
                raise ValueError(f"unsafe path in archive: {m.name}")
            if not (m.isfile() or m.isdir()):
                raise ValueError(f"unsupported archive entry: {m.name}")
            names.append(m.name)
        tar.extractall(root, filter="data") if sys.version_info >= (3, 12) else tar.extractall(root)  # noqa: S202 - checked above
    return names


def run(cmd: list[str], state: State, what: str, extra_env: dict[str, str] | None = None) -> None:
    state.set("installing", what)
    proc = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, **(extra_env or {})}, check=False)
    if proc.returncode != 0:
        tail = (proc.stdout + proc.stderr)[-1500:]
        raise RuntimeError(f"{what} failed (exit {proc.returncode}): {tail}")


def torch_constraints(path: Path) -> str:
    """Pin the image's own torch packages so pip cannot replace them."""
    import importlib.metadata as md
    import importlib.util as iu

    lines = [f"{p}=={md.version(p)}" for p in ("torch", "torchvision", "torchaudio") if iu.find_spec(p)]
    path.write_text("\n".join(lines) + "\n")
    return ";".join(lines)


def install(app: Path, state: State) -> dict[str, str]:
    """Install system and Python dependencies; returns extra environment for the worker."""
    if env("AIS_BOOTSTRAP_SKIP_SYSTEM") != "1":
        missing = [p for p in ("ffmpeg", "espeak-ng") if subprocess.run(["which", p], capture_output=True).returncode != 0]
        if missing:
            run(["apt-get", "update"], state, "updating the package list")
            run(["apt-get", "install", "-y", "--no-install-recommends", *missing], state, f"installing {', '.join(missing)}")
    req = app / "requirements-cloud.txt"
    constraints = app / "torch-constraints.txt"
    pins = torch_constraints(constraints)
    key = hashlib.sha256(req.read_bytes() + pins.encode() + sys.version.encode()).hexdigest()[:16]
    pyenv = Path(env("AIS_PYENV_ROOT", "/workspace/ais-pyenv")) / key
    marker = pyenv / ".complete"
    if env("AIS_BOOTSTRAP_SKIP_PIP") == "1":  # automated tests only (offline); the app never sets it
        state.set("installing", "library installation skipped (test mode)")
    elif marker.exists():
        state.set("installing", f"reusing the libraries installed earlier ({pyenv})")
    else:
        pyenv.mkdir(parents=True, exist_ok=True)
        args = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--target", str(pyenv), "-r", str(req)]
        if pins:
            args += ["-c", str(constraints)]
        run(args, state, "installing the AI libraries (first time on this volume: a few minutes)")
        marker.write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    # Record exactly what was resolved (direct pins + their dependencies + the image's torch), so a
    # real run documents its library versions and they can be committed as a lock.
    installed = pyenv / "installed-packages.txt"
    if not installed.exists() and pyenv.exists():
        listing = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--disable-pip-version-check", "--format=freeze", "--path", str(pyenv)],
            capture_output=True,
            text=True,
        )
        installed.write_text(listing.stdout + ("\n" + pins.replace(";", "\n") if pins else "") + "\n")
    paths = [str(app), str(pyenv), env("PYTHONPATH")]
    return {
        "PYTHONPATH": os.pathsep.join(p for p in paths if p),
        "WORKER_MODELS_FILE": str(app / "models.cloud.json"),
        "AIS_INSTALLED_FILE": str(installed),
    }


def self_terminate(reason: str) -> None:
    """Backup only: ask RunPod to remove this pod (pod-scoped credentials RunPod injects)."""
    pod, key = env("RUNPOD_POD_ID"), env("RUNPOD_API_KEY")
    print(f"[ais-bootstrap] terminating this pod: {reason}", flush=True)
    if not pod or not key:
        return
    base = env("AIS_RUNPOD_API", "https://api.runpod.io/v2").rstrip("/")
    if not base.startswith("https://") and not base.startswith("http://127.0.0.1"):
        return
    req = urllib.request.Request(  # noqa: S310 - scheme checked above
        f"{base}/pods/{pod}", method="DELETE", headers={"Authorization": f"Bearer {key}"}
    )
    try:
        urllib.request.urlopen(req, timeout=20).close()  # noqa: S310
    except (urllib.error.URLError, OSError) as exc:
        print(f"[ais-bootstrap] self-termination failed: {exc}", flush=True)


def make_handler(state: State, token: str, expected_sha: str, on_code: Any) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:  # quiet: no request lines with paths/headers
            return

        def _json(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            got = self.headers.get("Authorization", "")
            return bool(token) and hmac.compare_digest(got, f"Bearer {token}")

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, {"status": "bootstrapping", "stage": state.snapshot()["stage"]})
            elif self.path == "/bootstrap/status":
                if not self._authorized():
                    self._json(401, {"error": "unauthorized"})
                else:
                    self._json(200, state.snapshot())
            else:
                self._json(503, {"error": "the AI worker is still being set up", "stage": state.snapshot()["stage"]})

        def do_POST(self) -> None:
            if self.path != "/bootstrap/code":
                self._json(503, {"error": "the AI worker is still being set up"})
                return
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if state.snapshot()["stage"] != "waiting_for_code":
                self._json(409, {"error": "code already received", **state.snapshot()})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_CODE_BYTES:
                self._json(413, {"error": "missing or too large"})
                return
            data = self.rfile.read(length)
            digest = hashlib.sha256(data).hexdigest()
            if not hmac.compare_digest(digest, expected_sha):
                self._json(400, {"error": "the worker code does not match the checksum fixed when the pod was created"})
                return
            self._json(202, {"accepted": True, "sha256": digest})
            on_code(data)

    return Handler


def main() -> int:
    token = env("WORKER_AUTH_TOKEN")
    expected = env("AIS_CODE_SHA256").lower()
    if len(token) < 16 or len(expected) != 64:
        print("[ais-bootstrap] WORKER_AUTH_TOKEN and AIS_CODE_SHA256 are required", flush=True)
        return 2
    app = Path(env("AIS_APP_DIR", "/app"))
    port = int(env("WORKER_PORT", "8765"))
    wait_s = float(env("AIS_BOOTSTRAP_WAIT_MIN", "20")) * 60
    state = State()
    done = threading.Event()
    result: dict[str, Any] = {}
    server: ThreadingHTTPServer | None = None

    def on_code(data: bytes) -> None:
        def work() -> None:
            try:
                state.set("installing", "unpacking the worker code")
                files = safe_extract(data, app)
                state.set("installing", f"{len(files)} files unpacked")
                result["env"] = install(app, state)
                state.set("starting", "starting the AI worker")
            except Exception as exc:  # noqa: BLE001 - reported to the app, then the pod stops
                state.set("failed", "worker setup failed", str(exc)[-1500:])
                result["failed"] = True
            done.set()

        threading.Thread(target=work, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(state, token, expected, on_code))  # noqa: S104
    threading.Thread(target=server.serve_forever, daemon=True).start()
    state.set("waiting_for_code", f"listening on port {port}")
    if not done.wait(wait_s):
        server.shutdown()
        server.server_close()
        self_terminate("no worker code arrived in time")
        return 3
    if result.get("failed"):
        # Keep reporting the failure so the app can show why, then stop the pod.
        time.sleep(float(env("AIS_BOOTSTRAP_FAIL_LINGER_S", "300")))
        server.shutdown()
        server.server_close()
        self_terminate("worker setup failed")
        return 4
    server.shutdown()
    server.server_close()
    worker_env = {**os.environ, **result["env"]}
    worker_env.pop("AIS_BOOTSTRAP", None)
    print("[ais-bootstrap] handing over to the AI worker", flush=True)
    os.execve(sys.executable, [sys.executable, "-m", "ais_worker"], worker_env)  # noqa: S606
    return 0  # not reached


if __name__ == "__main__":
    raise SystemExit(main())
