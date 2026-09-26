"""System diagnostics: GPU, VRAM, CUDA, CPU, memory, disk, FFmpeg, models, worker version."""

from __future__ import annotations

import functools
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import __version__


def gpu_info() -> dict[str, Any]:
    """Query NVIDIA GPUs via nvidia-smi (no shell). Returns available=False when none are present."""
    smi = shutil.which("nvidia-smi")
    if not smi:
        return {"available": False, "reason": "nvidia-smi not found (no NVIDIA GPU/driver on this machine)", "gpus": []}
    try:
        out = subprocess.run(
            [smi, "--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            timeout=10,
            check=True,
        ).stdout.decode()
        cuda = subprocess.run([smi], capture_output=True, timeout=10, check=False).stdout.decode()
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "reason": f"nvidia-smi failed: {exc}", "gpus": []}
    gpus = []
    for line in out.strip().splitlines():
        name, total, used, driver, util = [p.strip() for p in line.split(",")]
        gpus.append({"name": name, "vram_total_mb": int(total), "vram_used_mb": int(used), "driver": driver, "utilization_pct": int(util)})
    cuda_version = next((ln.split("CUDA Version:")[1].split()[0] for ln in cuda.splitlines() if "CUDA Version:" in ln), None)
    return {"available": bool(gpus), "cuda_version": cuda_version, "gpus": gpus}


@functools.lru_cache(maxsize=1)
def torch_info() -> dict[str, Any]:
    """Whether PyTorch can actually use CUDA (nvidia-smi alone does not prove that). Cached: importing torch is slow."""
    if importlib.util.find_spec("torch") is None:
        return {"installed": False, "version": None, "cuda_available": False, "cuda_runtime": None, "device": None}
    try:
        import torch  # type: ignore[import-not-found]

        ok = bool(torch.cuda.is_available())
        return {
            "installed": True,
            "version": str(torch.__version__),
            "cuda_available": ok,
            "cuda_runtime": str(torch.version.cuda) if torch.version.cuda else None,
            "device": str(torch.cuda.get_device_name(0)) if ok else None,
        }
    except Exception as exc:  # noqa: BLE001 - a broken CUDA install must not break /system
        return {"installed": True, "version": None, "cuda_available": False, "cuda_runtime": None, "device": None, "error": str(exc)[:200]}


def memory_info() -> dict[str, int]:
    info: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, value = line.partition(":")
            if key in {"MemTotal", "MemAvailable"}:
                info[key] = int(value.split()[0]) // 1024
    except OSError:
        pass
    return {"total_mb": info.get("MemTotal", 0), "available_mb": info.get("MemAvailable", 0)}


def disk_info(path: Path) -> dict[str, int]:
    path.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(path)
    return {"total_gb": usage.total // 1024**3, "free_gb": usage.free // 1024**3}


def system_report(
    *, data_dir: Path, media_versions: dict[str, str | None], models: list[dict[str, Any]], job_counts: dict[str, int], mock_models: bool
) -> dict[str, Any]:
    return {
        "worker_version": __version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu_count": os.cpu_count(),
        "memory": memory_info(),
        "disk": disk_info(data_dir),
        "gpu": gpu_info(),
        "torch": torch_info(),
        "ffmpeg": media_versions,
        "mock_models": mock_models,
        "models": models,
        "jobs": job_counts,
    }
