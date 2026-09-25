"""Model registry: default model per kind, load-once tracking, LRU unloading."""

from __future__ import annotations

import threading
import time
from typing import Any

from ..jobs import JobContext, JobError
from .base import Model, ModelKind


class ModelRegistry:
    def __init__(self, max_loaded: int = 2) -> None:
        self._models: dict[str, Model[Any]] = {}
        self._defaults: dict[ModelKind, str] = {}
        self._last_used: dict[str, float] = {}
        self._load_counts: dict[str, int] = {}
        self._lock = threading.Lock()
        self.max_loaded = max_loaded

    def register(self, model: Model[Any], *, default: bool = False) -> None:
        self._models[model.info.id] = model
        if default or model.info.kind not in self._defaults:
            self._defaults[model.info.kind] = model.info.id

    def resolve(self, kind: ModelKind, model_id: str = "") -> Model[Any]:
        mid = model_id or self._defaults.get(kind, "")
        model = self._models.get(mid)
        if model is None or model.info.kind != kind:
            raise JobError("MODEL_LOAD_FAILED", f"no {kind} model {'named ' + repr(model_id) if model_id else 'installed'}")
        return model

    def ensure_loaded(self, model: Model[Any], ctx: JobContext) -> None:
        """Load a model once; unload least-recently-used models beyond ``max_loaded``."""
        with self._lock:
            if not model.loaded:
                ctx.set_status("loading_model", f"loading {model.info.id}")
                loaded = [m for m in self._models.values() if m.loaded]
                while len(loaded) >= self.max_loaded:
                    victim = min(loaded, key=lambda m: self._last_used.get(m.info.id, 0))
                    victim.unload()
                    loaded.remove(victim)
                started = time.monotonic()
                try:
                    model.load(ctx)
                except JobError:
                    raise
                except Exception as exc:
                    raise JobError("MODEL_LOAD_FAILED", f"{model.info.id}: {exc}") from exc
                ctx.job.metrics["load_seconds"] = round(time.monotonic() - started, 3)
                self._load_counts[model.info.id] = self._load_counts.get(model.info.id, 0) + 1
            self._last_used[model.info.id] = time.time()

    def load_count(self, model_id: str) -> int:
        return self._load_counts.get(model_id, 0)

    def describe(self) -> list[dict[str, Any]]:
        out = []
        for m in self._models.values():
            i = m.info
            out.append(
                {
                    "id": i.id,
                    "kind": i.kind,
                    "display_name": i.display_name,
                    "version": i.version,
                    "license": i.license,
                    "min_vram_gb": i.min_vram_gb,
                    "device": i.device,
                    "mock": i.mock,
                    "loaded": m.loaded,
                    "default": self._defaults.get(i.kind) == i.id,
                    "load_count": self._load_counts.get(i.id, 0),
                }
            )
        return out

    def all_mock(self) -> bool:
        return all(m.info.mock for m in self._models.values())
