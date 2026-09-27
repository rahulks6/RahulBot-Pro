"""Authentication, path sandboxing, input limits and log redaction."""

from __future__ import annotations

import hmac
import re
from pathlib import Path
from typing import Any

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$")
JOB_ID = re.compile(r"^job_[a-f0-9]{16}$")
ALLOWED_OUTPUT_EXTENSIONS = {".png", ".jpg", ".webp", ".wav", ".mp4", ".json"}
SECRET_KEY = re.compile(r"(pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie)", re.I)
SECRET_VALUE = re.compile(r"\b(sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+\S{8,}", re.I)


class SecurityError(Exception):
    """Request rejected for security reasons (maps to HTTP 401/403/413)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def check_bearer(header: str | None, token: str) -> None:
    """Constant-time bearer-token check. Raises SecurityError(401)."""
    if not header or not header.startswith("Bearer "):
        raise SecurityError(401, "missing bearer token")
    supplied = header[len("Bearer ") :].strip()
    if not hmac.compare_digest(supplied.encode(), token.encode()):
        raise SecurityError(401, "invalid token")


def safe_child(root: Path, *parts: str) -> Path:
    """Resolve a path strictly inside ``root``; rejects traversal, absolute parts and symlink escapes."""
    for part in parts:
        if not SAFE_NAME.match(part) or part in {".", ".."}:
            raise SecurityError(403, f"invalid path component: {part!r}")
    root_resolved = root.resolve()
    candidate = root_resolved.joinpath(*parts).resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise SecurityError(403, "path escapes the worker data directory")
    return candidate


def validate_job_id(job_id: str) -> str:
    if not JOB_ID.match(job_id):
        raise SecurityError(404, "unknown job")
    return job_id


def validate_output_name(name: str) -> str:
    if not SAFE_NAME.match(name) or Path(name).suffix.lower() not in ALLOWED_OUTPUT_EXTENSIONS:
        raise SecurityError(403, "invalid file name")
    return name


def redact(value: Any, depth: int = 0) -> Any:
    """Remove secrets from structures before they are logged or returned."""
    if depth > 6:
        return "[depth]"
    if isinstance(value, str):
        return SECRET_VALUE.sub("[REDACTED]", value)
    if isinstance(value, list):
        return [redact(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: "[REDACTED]" if SECRET_KEY.search(str(k)) else redact(v, depth + 1) for k, v in value.items()}
    return value
