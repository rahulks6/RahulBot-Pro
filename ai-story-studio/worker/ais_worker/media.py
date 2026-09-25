"""FFmpeg / FFprobe integration.

All commands are argument lists executed without a shell through
``JobContext.run`` (cancellable, time-limited). Inputs and outputs are paths
inside the job directory only.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .jobs import JobContext, JobError


@dataclass(frozen=True)
class MediaTools:
    ffmpeg: str | None
    ffprobe: str | None

    @property
    def available(self) -> bool:
        return bool(self.ffmpeg and self.ffprobe)

    def versions(self) -> dict[str, str | None]:
        return {"ffmpeg": _version(self.ffmpeg), "ffprobe": _version(self.ffprobe)}

    def has_encoder(self, name: str) -> bool:
        if not self.ffmpeg:
            return False
        try:
            out = subprocess.run([self.ffmpeg, "-hide_banner", "-encoders"], capture_output=True, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return f" {name} " in out.stdout.decode(errors="replace")

    def _need(self) -> tuple[str, str]:
        if not self.ffmpeg or not self.ffprobe:
            raise JobError("FFMPEG_FAILED", "FFmpeg/FFprobe are not installed on this worker")
        return self.ffmpeg, self.ffprobe

    def probe(self, ctx: JobContext, path: Path) -> dict[str, Any]:
        _, ffprobe = self._need()
        res = ctx.run([ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)], timeout=60)
        data: dict[str, Any] = json.loads(res.stdout or b"{}")
        return data

    def probe_file(self, path: Path) -> dict[str, Any]:
        """Probe outside a job (diagnostics / tests)."""
        _, ffprobe = self._need()
        out = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
            capture_output=True,
            timeout=60,
            check=True,
        )
        data: dict[str, Any] = json.loads(out.stdout or b"{}")
        return data

    def still_to_clip(self, ctx: JobContext, image: Path, out: Path, *, duration: float, fps: int, width: int, height: int) -> None:
        """Animate a still with a slow push-in (Ken Burns). Used by the MOCK video model only."""
        ffmpeg, _ = self._need()
        frames = max(1, round(duration * fps))
        vf = (
            f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,crop={width * 2}:{height * 2},"
            f"zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps},"
            "format=yuv420p"
        )
        ctx.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(image),
                "-vf",
                vf,
                "-frames:v",
                str(frames),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-r",
                str(fps),
                "-movflags",
                "+faststart",
                "-metadata",
                "comment=AI Story Studio MOCK clip",
                str(out),
            ],
            timeout=max(60, duration * 30),
        )

    def scale_video(self, ctx: JobContext, src: Path, out: Path, *, width: int, height: int) -> None:
        ffmpeg, _ = self._need()
        ctx.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-vf",
                f"scale={width}:{height}:flags=lanczos,format=yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-an",
                "-movflags",
                "+faststart",
                str(out),
            ],
            timeout=600,
        )

    def tag_copy(self, ctx: JobContext, src: Path, out: Path, comment: str) -> None:
        """Stream-copy a clip with a metadata comment (mock lip sync keeps the original frames)."""
        ffmpeg, _ = self._need()
        ctx.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-c", "copy", "-metadata", f"comment={comment}", str(out)],
            timeout=300,
        )


def _version(binary: str | None) -> str | None:
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "-version"], capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    first = out.stdout.decode(errors="replace").splitlines()
    return first[0] if first else None


def video_stream_info(probe: dict[str, Any]) -> dict[str, Any]:
    for s in probe.get("streams", []):
        if s.get("codec_type") == "video":
            num, _, den = str(s.get("avg_frame_rate", "0/1")).partition("/")
            fps = float(num) / float(den or 1) if float(den or 1) else 0.0
            return {"codec": s.get("codec_name"), "width": s.get("width"), "height": s.get("height"), "fps": round(fps, 3)}
    return {}
