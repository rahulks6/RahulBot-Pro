"""Worker configuration from environment variables.

The worker refuses to start without an auth token, binds to loopback by
default, and runs mock models unless explicitly told otherwise. Real model
adapters arrive in Phase 3; until then ``WORKER_MOCK_MODELS=false`` makes the
worker report that no real models are installed rather than silently mocking.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

MIN_TOKEN_LENGTH = 24


class ConfigError(ValueError):
    """Invalid or unsafe worker configuration."""


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(value: str | None, default: int, low: int, high: int) -> int:
    if value is None or value.strip() == "":
        return default
    try:
        n = int(value)
    except ValueError as exc:
        raise ConfigError(f"expected an integer, got {value!r}") from exc
    if not low <= n <= high:
        raise ConfigError(f"value {n} outside {low}..{high}")
    return n


@dataclass(frozen=True)
class WorkerConfig:
    auth_token: str
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8765
    mock_models: bool = True
    max_upload_bytes: int = 64 * 1024 * 1024
    max_concurrent_jobs: int = 1
    job_timeout_seconds: int = 30 * 60
    max_jobs_kept: int = 500
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None
    models_file: Path | None = None
    allow_noncommercial: bool = False
    model_cache_dir: Path | None = None

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> WorkerConfig:
        e = dict(os.environ if env is None else env)
        token = e.get("WORKER_AUTH_TOKEN", "")
        if len(token) < MIN_TOKEN_LENGTH:
            raise ConfigError(f"WORKER_AUTH_TOKEN must be set to a random secret of at least {MIN_TOKEN_LENGTH} characters")
        data_dir = Path(e.get("WORKER_DATA_DIR") or "./worker-data").resolve()
        return cls(
            auth_token=token,
            data_dir=data_dir,
            host=e.get("WORKER_HOST") or "127.0.0.1",
            port=_int(e.get("WORKER_PORT"), 8765, 0, 65535),
            mock_models=_bool(e.get("WORKER_MOCK_MODELS"), True),
            max_upload_bytes=_int(e.get("WORKER_MAX_UPLOAD_MB"), 64, 1, 2048) * 1024 * 1024,
            max_concurrent_jobs=_int(e.get("WORKER_MAX_CONCURRENT_JOBS"), 1, 1, 8),
            job_timeout_seconds=_int(e.get("WORKER_JOB_TIMEOUT_SEC"), 1800, 5, 24 * 3600),
            ffmpeg_path=e.get("FFMPEG_PATH") or shutil.which("ffmpeg"),
            ffprobe_path=e.get("FFPROBE_PATH") or shutil.which("ffprobe"),
            models_file=Path(e["WORKER_MODELS_FILE"]).resolve() if e.get("WORKER_MODELS_FILE") else None,
            allow_noncommercial=_bool(e.get("WORKER_ALLOW_NONCOMMERCIAL"), False),
            model_cache_dir=Path(e["WORKER_MODEL_CACHE_DIR"]).resolve() if e.get("WORKER_MODEL_CACHE_DIR") else None,
        )
