"""Replaceable model interfaces (spec §19–§31, §89).

A model adapter implements ``load`` (once per worker, tracked by the
registry), ``unload`` and ``run``. Phase 2 ships mock adapters; Phase 3 adds
benchmarked open-source adapters behind the same interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

from ..jobs import JobContext

ModelKind = Literal["image", "video", "tts", "music", "sfx", "lipsync", "upscale"]


@dataclass(frozen=True)
class ModelInfo:
    id: str
    kind: ModelKind
    display_name: str
    version: str
    license: str
    min_vram_gb: int
    device: Literal["cpu", "cuda"]
    mock: bool


Req = TypeVar("Req")


class Model(ABC, Generic[Req]):
    info: ModelInfo

    def __init__(self) -> None:
        self.loaded = False

    def load(self, ctx: JobContext) -> None:
        """Load weights. Override for real models; keep idempotent."""
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    @abstractmethod
    def run(self, request: Req, ctx: JobContext) -> None:
        """Write outputs into the job directory and register them with ``ctx.add_output``."""
