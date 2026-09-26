from __future__ import annotations

from pathlib import Path

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.config import ConfigError, WorkerConfig
from ais_worker.security import SecurityError, check_bearer, redact, safe_child, validate_job_id, validate_output_name

from .conftest import AUTH, TOKEN


def test_config_requires_a_strong_token(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        WorkerConfig.from_env({"WORKER_DATA_DIR": str(tmp_path)})
    with pytest.raises(ConfigError):
        WorkerConfig.from_env({"WORKER_AUTH_TOKEN": "short", "WORKER_DATA_DIR": str(tmp_path)})
    cfg = WorkerConfig.from_env({"WORKER_AUTH_TOKEN": TOKEN, "WORKER_DATA_DIR": str(tmp_path)})
    assert cfg.host == "127.0.0.1"
    assert cfg.mock_models is True
    with pytest.raises(ConfigError):
        WorkerConfig.from_env({"WORKER_AUTH_TOKEN": TOKEN, "WORKER_PORT": "99999"})


def test_bearer_check() -> None:
    check_bearer(f"Bearer {TOKEN}", TOKEN)
    for bad in [None, "", TOKEN, "Bearer wrong", f"Basic {TOKEN}"]:
        with pytest.raises(SecurityError) as e:
            check_bearer(bad, TOKEN)
        assert e.value.status == 401


def test_every_endpoint_but_health_requires_auth(api: WorkerAPI) -> None:
    assert api.handle("GET", "/health", {}, b"").status == 200
    for method, path in [
        ("GET", "/models"),
        ("GET", "/system"),
        ("GET", "/jobs"),
        ("POST", "/generate/image"),
        ("POST", "/jobs/job_0123456789abcdef/cancel"),
    ]:
        assert api.handle(method, path, {}, b"{}").status == 401, path
        assert api.handle(method, path, {"authorization": "Bearer nope"}, b"{}").status == 401, path
    health = api.handle("GET", "/health", {}, b"").body or {}
    assert set(health) == {"status", "version", "ready"}
    assert health["ready"] is True


def test_path_sandbox(tmp_path: Path) -> None:
    assert safe_child(tmp_path, "job_0123456789abcdef", "image.png") == (tmp_path / "job_0123456789abcdef" / "image.png").resolve()
    for parts in [("..",), ("a", ".."), ("../etc",), ("/etc",), ("a/b",), (".hidden",), ("a\\b",)]:
        with pytest.raises(SecurityError):
            safe_child(tmp_path, *parts)
    (tmp_path / "link").symlink_to("/etc")
    with pytest.raises(SecurityError):
        safe_child(tmp_path, "link", "passwd.png")


def test_ids_and_output_names() -> None:
    validate_job_id("job_0123456789abcdef")
    for bad in ["job_../x", "../../etc", "job_XYZ"]:
        with pytest.raises(SecurityError):
            validate_job_id(bad)
    validate_output_name("clip.mp4")
    for bad in ["../job.json", "run.sh", "x.exe", ".env"]:
        with pytest.raises(SecurityError):
            validate_output_name(bad)


def test_file_downloads_cannot_escape(api: WorkerAPI) -> None:
    for path in [
        "/jobs/job_0123456789abcdef/files/..%2F..%2Fjob.json",
        "/jobs/../../etc/files/passwd.png",
        "/jobs/job_0123456789abcdef/files/job.json",
    ]:
        assert api.handle("GET", path, AUTH, b"").status in {403, 404}, path


def test_redaction() -> None:
    out = redact({"api_key": "sk-live-abcdefghijklmnop", "note": "Bearer abcdefghijkl123", "ok": 1, "nested": [{"password": "x"}]})
    assert out == {"api_key": "[REDACTED]", "note": "[REDACTED]", "ok": 1, "nested": [{"password": "[REDACTED]"}]}


def test_errors_never_leak_internals(api: WorkerAPI) -> None:
    res = api.handle("POST", "/generate/image", AUTH, b"not json")
    assert res.status == 422
    res = api.handle("GET", "/nope", AUTH, b"")
    assert res.status == 404
    assert TOKEN not in str(api.system())
