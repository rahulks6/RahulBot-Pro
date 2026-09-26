from __future__ import annotations

import errno
import json
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from ais_worker import download


class GatedRepoError(Exception):
    pass


class RepositoryNotFoundError(Exception):
    pass


def fake_hub(monkeypatch: pytest.MonkeyPatch, behaviour: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    mod = types.ModuleType("huggingface_hub")

    def snapshot_download(**kwargs: Any) -> str:
        calls.append(kwargs)
        if isinstance(behaviour, BaseException):
            raise behaviour
        return str(Path(kwargs["cache_dir"]) / "snap")

    class HfApi:
        def model_info(self, repo: str, revision: str) -> Any:
            return types.SimpleNamespace(sha="remote123")

    mod.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    mod.HfApi = HfApi  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", mod)
    return calls


def last_json(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    return dict(json.loads(capsys.readouterr().out.strip().splitlines()[-1]))


def test_downloads_with_patterns_and_network_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    calls = fake_hub(monkeypatch, None)
    code = download.main(
        ["--repo", "org/model", "--cache", str(tmp_path), "--allow", "*.json", "--allow", "unet/*", "--ignore", "big.safetensors"]
    )
    assert code == 0
    assert last_json(capsys)["ok"] is True
    assert calls[0]["allow_patterns"] == ["*.json", "unet/*"]
    assert calls[0]["ignore_patterns"] == ["big.safetensors"]
    assert calls[0]["revision"] == "main"
    import os

    assert os.environ["HF_HUB_OFFLINE"] == "0"


@pytest.mark.parametrize(
    ("exc", "kind", "code"),
    [
        (GatedRepoError("401 Client Error: gated repo"), "gated", 3),
        (RepositoryNotFoundError("404"), "not_found", 4),
        (OSError(errno.ENOSPC, "No space left on device"), "disk_full", 6),
        (ConnectionError("connection refused"), "network", 5),
        (ValueError("weird"), "error", 1),
    ],
)
def test_failures_are_explained(
    exc: BaseException, kind: str, code: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_hub(monkeypatch, exc)
    assert download.main(["--repo", "org/model", "--cache", str(tmp_path)]) == code
    out = last_json(capsys)
    assert out["kind"] == kind and out["ok"] is False and out["message"]


def test_check_reports_update(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    fake_hub(monkeypatch, None)
    ref = tmp_path / "models--org--model" / "refs"
    ref.mkdir(parents=True)
    (ref / "main").write_text("local999")
    assert download.main(["--repo", "org/model", "--cache", str(tmp_path), "--check"]) == 0
    assert last_json(capsys) == {"ok": True, "remote": "remote123", "local": "local999", "update_available": True}


def test_rejects_bad_repo_ids(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    for bad in ["noslash", "/abs/path", "org/../x"]:
        assert download.main(["--repo", bad, "--cache", str(tmp_path)]) == 2


def test_missing_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)
    assert download.main(["--repo", "org/model", "--cache", str(tmp_path)]) == 7
    assert "huggingface_hub" in last_json(capsys)["message"]
