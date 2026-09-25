"""Model catalog: which real open-source models this worker may load.

Real models are declared in a JSON file (``WORKER_MODELS_FILE``); nothing is
hard-coded and every entry is disabled until a human enables it. Each entry
records its licence and whether commercial use is allowed, because our videos
are published. The licence gate:

  * ``allowed``        → may load.
  * ``conditional``    → may load only with ``"license_acknowledged": true``
                          (e.g. revenue thresholds or use restrictions you
                          have read and accept).
  * ``non_commercial`` → refused unless ``WORKER_ALLOW_NONCOMMERCIAL=true``
                          (private evaluation only; outputs are tagged).
  * ``unknown``        → always refused.

Licence facts must be re-verified on the model card at download time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .schemas import ValidationError

KINDS = ("image", "video", "tts", "music", "sfx", "lipsync", "upscale")
COMMERCIAL = ("allowed", "conditional", "non_commercial", "unknown")
ADAPTERS = (
    "diffusers_image",
    "diffusers_i2v",
    "kokoro_tts",
    "chatterbox_tts",
    "stable_audio",
    "ffmpeg_upscale",
    "spandrel_upscale",
    "command_lipsync",
    "none",
)


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    kind: str
    adapter: str
    display_name: str
    repo: str
    revision: str
    license: str
    commercial_use: str
    license_url: str
    license_notes: str
    license_acknowledged: bool
    min_vram_gb: int
    enabled: bool
    default: bool
    params: dict[str, Any] = field(default_factory=dict)
    recommended_vram_gb: int = 0
    precision: str = ""
    storage_gb: float = 0
    capabilities: tuple[str, ...] = ()


class LicenseError(Exception):
    """The licence gate refused to load a model."""


def check_license(entry: CatalogEntry, allow_noncommercial: bool) -> None:
    c = entry.commercial_use
    if c == "allowed":
        return
    if c == "conditional":
        if entry.license_acknowledged:
            return
        raise LicenseError(
            f"{entry.id}: licence '{entry.license}' has conditions ({entry.license_notes or 'see model card'}); "
            'set "license_acknowledged": true after reading them'
        )
    if c == "non_commercial":
        if allow_noncommercial:
            return
        raise LicenseError(
            f"{entry.id}: licence '{entry.license}' forbids commercial use; set WORKER_ALLOW_NONCOMMERCIAL=true only for private evaluation"
        )
    raise LicenseError(f"{entry.id}: licence unknown; record it before enabling")


def _entry(raw: Any, i: int, errors: list[dict[str, str]]) -> CatalogEntry | None:
    path = f"models[{i}]"
    if not isinstance(raw, dict):
        errors.append({"path": path, "message": "must be an object"})
        return None

    def s(key: str, default: str | None = None, *, choices: tuple[str, ...] | None = None, max_len: int = 400) -> str:
        v = raw.get(key, default)
        if not isinstance(v, str) or (default is None and not v.strip()) or len(v) > max_len:
            errors.append({"path": f"{path}.{key}", "message": "must be a non-empty string" if default is None else "must be a string"})
            return ""
        if choices and v not in choices:
            errors.append({"path": f"{path}.{key}", "message": f"must be one of: {', '.join(choices)}"})
        return v

    def b(key: str) -> bool:
        v = raw.get(key, False)
        if not isinstance(v, bool):
            errors.append({"path": f"{path}.{key}", "message": "must be true or false"})
            return False
        return v

    known = {
        "id", "kind", "adapter", "display_name", "repo", "revision", "license", "commercial_use", "license_url",
        "license_notes", "license_acknowledged", "min_vram_gb", "enabled", "default", "params", "sources",
        "recommended_vram_gb", "precision", "storage_gb", "capabilities",
    }  # fmt: skip
    for key in raw:
        if key not in known:
            errors.append({"path": f"{path}.{key}", "message": "is not a recognised field"})
    vram = raw.get("min_vram_gb", 0)
    if isinstance(vram, bool) or not isinstance(vram, int) or not 0 <= vram <= 1024:
        errors.append({"path": f"{path}.min_vram_gb", "message": "must be an integer 0..1024"})
        vram = 0
    params = raw.get("params", {})
    if not isinstance(params, dict):
        errors.append({"path": f"{path}.params", "message": "must be an object"})
        params = {}
    entry_id = s("id")
    if entry_id and not entry_id.replace("-", "").replace("_", "").replace(".", "").isalnum():
        errors.append({"path": f"{path}.id", "message": "may contain letters, digits, '-', '_' and '.' only"})
    return CatalogEntry(
        id=entry_id,
        kind=s("kind", choices=KINDS),
        adapter=s("adapter", choices=ADAPTERS),
        display_name=s("display_name", ""),
        repo=s("repo", ""),
        revision=s("revision", "main"),
        license=s("license"),
        commercial_use=s("commercial_use", choices=COMMERCIAL),
        license_url=s("license_url", ""),
        license_notes=s("license_notes", "", max_len=2000),
        license_acknowledged=b("license_acknowledged"),
        min_vram_gb=vram,
        enabled=b("enabled"),
        default=b("default"),
        params=params,
        recommended_vram_gb=_number(raw.get("recommended_vram_gb"), vram),
        precision=str(raw.get("precision", "")),
        storage_gb=_number(raw.get("storage_gb"), 0),
        capabilities=_strings(raw.get("capabilities")),
    )


def _number(value: Any, default: float) -> Any:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else default


def _strings(value: Any) -> tuple[str, ...]:
    return tuple(v for v in value if isinstance(v, str)) if isinstance(value, list) else ()


def load_catalog(path: Path) -> list[CatalogEntry]:
    """Parse and validate a catalog file; raises ValidationError listing every problem."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise ValidationError([{"path": str(path), "message": f"cannot read catalog: {exc}"}]) from exc
    models = data.get("models") if isinstance(data, dict) else None
    if not isinstance(models, list):
        raise ValidationError([{"path": "models", "message": "must be a list"}])
    errors: list[dict[str, str]] = []
    entries = [e for i, raw in enumerate(models) if (e := _entry(raw, i, errors)) is not None]
    ids = [e.id for e in entries]
    for dup in {i for i in ids if ids.count(i) > 1}:
        errors.append({"path": "models", "message": f"duplicate id {dup!r}"})
    if errors:
        raise ValidationError(errors)
    return entries
