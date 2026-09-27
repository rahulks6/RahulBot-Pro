"""Lip sync through a locally installed project (LatentSync, MuseTalk, …).

These projects ship as repositories with their own inference scripts and
environments rather than as pip packages, so the adapter runs a command the
operator configures in the catalog, as an argument list WITHOUT a shell:

    "params": {
      "cwd": "/opt/LatentSync",
      "argv": ["/opt/LatentSync/.venv/bin/python", "-m", "scripts.inference",
               "--unet_config_path", "configs/unet/stage2.yaml",
               "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
               "--video_path", "{video}", "--audio_path", "{audio}",
               "--video_out_path", "{output}"],
      "timeout_sec": 1800
    }

Placeholders ({video}, {audio}, {output}, {seed}) are substituted inside
arguments; paths are inside the job directory. The result is re-encoded to
H.264 at the source clip's size and frame rate, without audio (the app mixes
dialogue separately), and checked with ffprobe.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..media import MediaTools, video_stream_info
from ..models.base import Model
from ..schemas import LipSyncRequest, sniff
from .common import info_from

PLACEHOLDERS = ("{video}", "{audio}", "{output}", "{seed}")


class CommandLipSync(Model[LipSyncRequest]):
    def __init__(self, entry: CatalogEntry, media: MediaTools) -> None:
        super().__init__()
        self.entry = entry
        self.media = media
        self.info = info_from(entry, "cuda")
        argv = entry.params.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a for a in argv):
            raise ValueError(f"{entry.id}: params.argv must be a non-empty list of strings")
        if "{output}" not in " ".join(argv) or "{video}" not in " ".join(argv) or "{audio}" not in " ".join(argv):
            raise ValueError(f"{entry.id}: params.argv must use the {{video}}, {{audio}} and {{output}} placeholders")
        self.argv: list[str] = argv
        cwd = entry.params.get("cwd")
        self.cwd = Path(str(cwd)).expanduser() if cwd else None
        self.timeout = float(entry.params.get("timeout_sec", 1800))

    def load(self, ctx: JobContext) -> None:
        exe = self.argv[0]
        if not (Path(exe).is_file() or shutil.which(exe)):
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id}: executable not found: {exe}")
        if self.cwd is not None and not self.cwd.is_dir():
            raise JobError("MODEL_LOAD_FAILED", f"{self.entry.id}: working directory not found: {self.cwd}")
        self.loaded = True

    def run(self, request: LipSyncRequest, ctx: JobContext) -> None:
        if sniff(request.video) != "mp4":
            raise JobError("LIPSYNC_FAILED", "real lip sync needs an MP4 clip (mock placeholder clips cannot be lip-synced)")
        video, audio, raw = ctx.path("input.mp4"), ctx.path("input.wav"), ctx.path("lipsync_raw.mp4")
        video.write_bytes(request.video)
        audio.write_bytes(request.audio)
        values = {"{video}": str(video), "{audio}": str(audio), "{output}": str(raw), "{seed}": str(request.settings.get("seed", 0))}
        args = []
        for arg in self.argv:
            for key in PLACEHOLDERS:
                arg = arg.replace(key, values[key])
            args.append(arg)
        ctx.set_status("running", "lip sync")
        ctx.run(args, timeout=self.timeout, cwd=self.cwd, error_code="LIPSYNC_FAILED")
        if not raw.is_file() or raw.stat().st_size == 0:
            raise JobError("LIPSYNC_FAILED", f"{self.entry.id}: the command produced no output video")
        src = video_stream_info(self.media.probe(ctx, video))
        got = video_stream_info(self.media.probe(ctx, raw))
        if not got:
            raise JobError("LIPSYNC_FAILED", f"{self.entry.id}: the output has no video stream")
        w, h = int(src.get("width") or got["width"]), int(src.get("height") or got["height"])
        w, h = w - w % 2, h - h % 2
        self.media.scale_video(ctx, raw, ctx.path("lipsync.mp4"), width=w, height=h)
        dur_in = float(self.media.probe(ctx, video).get("format", {}).get("duration", 0))
        dur_out = float(self.media.probe(ctx, ctx.path("lipsync.mp4")).get("format", {}).get("duration", 0))
        if dur_in and abs(dur_in - dur_out) > 0.25:
            ctx.log(f"warning: lip-sync output is {dur_out:.2f}s, source clip {dur_in:.2f}s")
        for p in (raw, video, audio):
            p.unlink(missing_ok=True)
        ctx.add_output("lipsync.mp4", "video/mp4", width=w, height=h, duration_sec=round(dur_out, 3), fps=got.get("fps"))
