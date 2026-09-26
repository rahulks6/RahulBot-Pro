"""Still image + camera move (FFmpeg): an image-to-video option that is NOT AI.

For computers without a large NVIDIA GPU: the approved image gets a slow
push-in, pull-out or pan, so the episode can still be built from real
images. Every output is labelled (job.details.still_motion = true) and the
app's Quality Check reports these clips as still-image motion.
"""

from __future__ import annotations

from ..catalog import CatalogEntry
from ..jobs import JobContext
from ..media import MediaTools
from ..models.base import Model
from ..schemas import VideoRequest, sniff
from .common import info_from


def motion_filter(movement: str, strength: float, width: int, height: int, frames: int, fps: int, zoom: float = 0.08) -> str:
    """zoompan filter for a camera move; ``strength`` 0..1 scales the amount of movement."""
    m = movement.lower()
    amount = max(0.02, zoom * (0.5 + strength))
    step = amount / max(1, frames)
    cx, cy = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    if any(w in m for w in ("pull", "zoom out", "dolly out", "reveal")):
        z, x, y = f"if(eq(on,0),{1 + amount:.4f},max(zoom-{step:.6f},1.0))", cx, cy
    elif "left" in m:
        z, x, y = f"{1 + amount:.4f}", f"(iw-iw/zoom)*(1-on/{frames})", cy
    elif "right" in m:
        z, x, y = f"{1 + amount:.4f}", f"(iw-iw/zoom)*on/{frames}", cy
    elif any(w in m for w in ("tilt up", "pan up", "rise")):
        z, x, y = f"{1 + amount:.4f}", cx, f"(ih-ih/zoom)*(1-on/{frames})"
    elif any(w in m for w in ("tilt down", "pan down")):
        z, x, y = f"{1 + amount:.4f}", cx, f"(ih-ih/zoom)*on/{frames}"
    else:  # push-in (default): a gentle move towards the centre
        z, x, y = f"min(zoom+{step:.6f},{1 + amount:.4f})", cx, cy
    return (
        f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,crop={width * 2}:{height * 2},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps},format=yuv420p"
    )


class StillMotionVideo(Model[VideoRequest]):
    def __init__(self, entry: CatalogEntry, media: MediaTools) -> None:
        super().__init__()
        self.entry = entry
        self.media = media
        self.info = info_from(entry, "cpu")

    def run(self, request: VideoRequest, ctx: JobContext) -> None:
        ffmpeg, _ = self.media._need()
        ext = {"png": "png", "jpeg": "jpg", "webp": "webp"}.get(sniff(request.image) or "", "png")
        src = ctx.path(f"still.{ext}")
        src.write_bytes(request.image)
        w, h = request.width - request.width % 2, request.height - request.height % 2
        frames = max(1, round(request.duration_sec * request.fps))
        vf = motion_filter(
            request.camera_movement or "push-in",
            request.motion_strength,
            w,
            h,
            frames,
            request.fps,
            float(self.entry.params.get("zoom", 0.08)),
        )
        ctx.set_status("encoding", f"still image + camera move ({request.camera_movement or 'push-in'})")
        ctx.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", vf, "-frames:v", str(frames),
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             str(ctx.path("clip.mp4"))],
            timeout=600,
        )  # fmt: skip
        src.unlink(missing_ok=True)
        ctx.job.details["still_motion"] = True
        ctx.job.details["effective_params"] = {
            "camera_movement": request.camera_movement or "push-in",
            "motion_strength": request.motion_strength,
            "width": w,
            "height": h,
            "frames": frames,
        }
        ctx.log("still image + camera move (FFmpeg, not AI video)")
        ctx.add_output(
            "clip.mp4",
            "video/mp4",
            width=w,
            height=h,
            duration_sec=round(frames / request.fps, 3),
            fps=request.fps,
            native_resolution=False,
        )
