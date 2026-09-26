"""Mock model adapters (Phase 2). Clearly labelled placeholders, no weights, ₹0.

When FFmpeg is available the mock video / upscale / lip-sync models produce
REAL H.264 MP4 files (a slow push-in on the approved still), which exercises
the full media path end to end. Without FFmpeg they fall back to the JSON
clip manifests used by the TypeScript mocks.

Mock controls (inside ``settings``): ``mock_fail`` = error code to raise,
``mock_delay_sec`` = interruptible simulated work time.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import struct
import wave
import zlib
from pathlib import Path
from typing import Any

from ..jobs import JobContext, JobError
from ..media import MediaTools, video_stream_info
from ..schemas import AudioRequest, ImageRequest, LipSyncRequest, TextRequest, UpscaleRequest, VideoRequest, sniff
from .base import Model, ModelInfo

SR = 22050
MOCK_VIDEO_MIME = "application/vnd.ai-story-studio.mock-video+json"
QUALITY_SCALE = {"fast_preview": 0.25, "optimized": 0.5, "high_quality": 1.0}


def _controls(settings: dict[str, Any], ctx: JobContext) -> None:
    fail = settings.get("mock_fail")
    if isinstance(fail, str) and fail:
        raise JobError(fail[:40], f"simulated failure ({fail})")
    delay = settings.get("mock_delay_sec")
    if isinstance(delay, (int, float)) and delay > 0:
        ctx.sleep(min(float(delay), 60.0))


def _even(n: float) -> int:
    return max(2, round(n / 2) * 2)


def _info(mid: str, kind: Any, name: str, vram: int, device: Any = "cuda") -> ModelInfo:
    return ModelInfo(
        id=mid,
        kind=kind,
        display_name=name,
        version="mock-2",
        license="n/a (placeholder output)",
        min_vram_gb=vram,
        device=device,
        mock=True,
    )


# --- PNG ---------------------------------------------------------------------------


def encode_png(width: int, height: int, pixel: Any) -> bytes:
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


def decode_simple_png(data: bytes) -> tuple[int, int, bytes]:
    """Decode 8-bit RGB PNGs with filter 0 (as produced by the mocks)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise JobError("UPSCALE_FAILED", "not a PNG")
    pos, width, height, idat = 8, 0, 0, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", body[:10])
            if depth != 8 or color != 2:
                raise JobError("UPSCALE_FAILED", "unsupported PNG format for the mock upscaler")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 3 + 1
    rgb = bytearray()
    for y in range(height):
        if raw[y * stride] != 0:
            raise JobError("UPSCALE_FAILED", "unsupported PNG filter for the mock upscaler")
        rgb.extend(raw[y * stride + 1 : (y + 1) * stride])
    return width, height, bytes(rgb)


def _hsl(h: float, s: float, lum: float) -> tuple[int, int, int]:
    a = s * min(lum, 1 - lum)

    def f(n: float) -> int:
        k = (n + h / 30) % 12
        return round(255 * (lum - a * max(-1, min(k - 3, 9 - k, 1))))

    return f(0), f(8), f(4)


class MockImageModel(Model[ImageRequest]):
    info = _info("mock-image", "image", "Mock image model", 12)

    def run(self, request: ImageRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        scale = QUALITY_SCALE[request.quality]
        w, h = _even(request.width * scale), _even(request.height * scale)
        rng = random.Random(f"{request.prompt}|{request.seed}")
        hue = rng.random() * 360
        sky1, sky2, ground = _hsl(hue, 0.55, 0.72), _hsl((hue + 40) % 360, 0.5, 0.45), _hsl((hue + 120) % 360, 0.35, 0.35)
        horizon = h * (0.6 + rng.random() * 0.1)
        blob = (w * 0.5, h * 0.66, min(w, h) * 0.12, _hsl(rng.random() * 360, 0.65, 0.55))

        def pixel(x: int, y: int) -> tuple[int, int, int]:
            if (x - blob[0]) ** 2 + (y - blob[1]) ** 2 < blob[2] ** 2:
                return blob[3]
            if y > horizon:
                return ground
            t = y / horizon
            return (
                round(sky1[0] * (1 - t) + sky2[0] * t),
                round(sky1[1] * (1 - t) + sky2[1] * t),
                round(sky1[2] * (1 - t) + sky2[2] * t),
            )

        ctx.set_status("running", f"generating {w}x{h}")
        ctx.path("image.png").write_bytes(encode_png(w, h, pixel))
        ctx.add_output("image.png", "image/png", width=w, height=h, native_resolution=(w, h) == (request.width, request.height), mock=True)


class MockVideoModel(Model[VideoRequest]):
    info = _info("mock-video", "video", "Mock image-to-video model", 24)

    def __init__(self, media: MediaTools) -> None:
        super().__init__()
        self.media = media

    def run(self, request: VideoRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        scale = QUALITY_SCALE[request.quality]
        w, h = _even(request.width * scale), _even(request.height * scale)
        kind = sniff(request.image) or "png"
        src = ctx.path(f"source.{'jpg' if kind == 'jpeg' else kind}")
        src.write_bytes(request.image)
        native = (w, h) == (request.width, request.height)
        if self.media.available and self.media.has_encoder("libx264"):
            ctx.set_status("running", f"rendering mock clip {w}x{h} {request.duration_sec}s @{request.fps}fps with FFmpeg")
            self.media.still_to_clip(ctx, src, ctx.path("clip.mp4"), duration=request.duration_sec, fps=request.fps, width=w, height=h)
            info = video_stream_info(self.media.probe(ctx, ctx.path("clip.mp4")))
            ctx.add_output(
                "clip.mp4",
                "video/mp4",
                width=info.get("width", w),
                height=info.get("height", h),
                duration_sec=request.duration_sec,
                fps=request.fps,
                native_resolution=native,
                mock=True,
            )
            return
        manifest = {
            "format": "ai-story-studio/mock-video",
            "version": 1,
            "note": "MOCK CLIP — FFmpeg not installed on the worker; manifest only",
            "sourceSha256": hashlib.sha256(request.image).hexdigest(),
            "motionPrompt": request.motion_prompt,
            "durationSec": request.duration_sec,
            "fps": request.fps,
            "width": w,
            "height": h,
            "frames": round(request.duration_sec * request.fps),
            "seed": request.seed,
        }
        ctx.path("clip.json").write_text(json.dumps(manifest, indent=2))
        ctx.add_output(
            "clip.json",
            MOCK_VIDEO_MIME,
            width=w,
            height=h,
            duration_sec=request.duration_sec,
            fps=request.fps,
            native_resolution=native,
            mock=True,
        )


# --- audio ---------------------------------------------------------------------------

EMOTION = {
    "neutral": (0.0, 1.0, 1.0, 0.0),
    "happy": (2.0, 1.08, 1.05, 0.0),
    "excited": (3.0, 1.18, 1.15, 0.0),
    "sad": (-2.0, 0.85, 0.8, 0.05),
    "tired": (-1.5, 0.8, 0.75, 0.08),
    "afraid": (1.5, 1.12, 0.85, 0.05),
    "nervous": (1.0, 1.1, 0.85, 0.04),
    "angry": (0.5, 1.05, 1.3, 0.0),
    "whispering": (0.0, 0.95, 0.35, 0.9),
    "surprised": (3.5, 1.05, 1.1, 0.0),
    "calm": (-0.5, 0.92, 0.9, 0.0),
}


def write_wav(path: Path, samples: list[float], sample_rate: int = SR) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples))


class MockAudioModel(Model[AudioRequest]):
    """One mock adapter per audio kind (TTS, music, SFX/ambience)."""

    def __init__(self, kind: str) -> None:
        super().__init__()
        names = {"tts": "Mock text-to-speech", "music": "Mock music generator", "sfx": "Mock SFX / ambience generator"}
        self.info = _info(f"mock-{kind}", kind, names[kind], 0 if kind == "tts" else 8, "cpu" if kind == "tts" else "cuda")

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        ctx.set_status("running", f"synthesising {request.kind}")
        if request.voice_reference is not None:
            ctx.log("mock TTS: reference audio received (consent confirmed) but not used; the output is a placeholder voice")
            ctx.job.metrics["voice_reference_used"] = False
        if request.kind == "tts":
            samples = self._speech(request)
        elif request.kind == "music":
            samples = self._music(request)
        else:
            samples = self._noise(request)
        write_wav(ctx.path("audio.wav"), samples)
        ctx.add_output("audio.wav", "audio/wav", duration_sec=round(len(samples) / SR, 3), mock=True)

    @staticmethod
    def _speech(r: AudioRequest) -> list[float]:
        pitch, rate, gain, breath = EMOTION.get(r.emotion, EMOTION["neutral"])
        words = max(1, len(r.text.split()))
        duration = words / (2.6 * r.speed * rate) + 0.35
        base = {"male": 118, "female": 205, "neutral": 162}[r.presentation]
        freq = base * 2 ** ((r.pitch + pitch) / 12)
        timbre = random.Random(r.voice_identity or "voice")
        h2 = 0.2 + timbre.random() * 0.4
        syllables = max(
            1, sum(1 for i, c in enumerate(r.text.lower()) if c in "aeiouy" and (i == 0 or r.text.lower()[i - 1] not in "aeiouy"))
        )
        n = int(duration * SR)
        syl = max(1, int((n - 0.2 * SR) / syllables))
        noise = random.Random(r.text)
        out, phase = [], 0.0
        for i in range(n):
            k, within = divmod(i, syl)
            w = within / syl
            env = math.sin(math.pi * w / 0.82) if k < syllables and w < 0.82 else 0.0
            phase += 2 * math.pi * freq * (1 + 0.06 * math.sin(2 * math.pi * (k * 0.37 + w * 0.5))) / SR
            voiced = math.sin(phase) + h2 * math.sin(2 * phase)
            out.append(0.32 * gain * env * ((1 - min(breath, 0.9)) * voiced * 0.6 + (noise.random() * 2 - 1) * breath))
        return out

    @staticmethod
    def _music(r: AudioRequest) -> list[float]:
        minor = any(m in r.mood.lower() for m in ("sad", "suspense", "mysterious", "bedtime"))
        scale = [0, 3, 7, 10] if minor else [0, 4, 7, 12]
        tempo = {"high": 132, "low": 72}.get(r.energy, 100)
        beat = 60 / tempo * SR
        root = 196.0
        n = int(r.duration_sec * SR)
        out = []
        for i in range(n):
            t = i / SR
            note = scale[int(i / beat) % len(scale)]
            pluck = math.exp(-((i % beat) / beat) * 5) * math.sin(2 * math.pi * root * 2 ** (note / 12) * t)
            pad = sum(math.sin(2 * math.pi * root * 0.5 * 2 ** (iv / 12) * t) for iv in scale[:3]) / 3
            fade = min(1.0, t / 0.5, (r.duration_sec - t) / 0.8)
            out.append(0.16 * fade * (0.35 * pad + 0.65 * pluck))
        return out

    @staticmethod
    def _noise(r: AudioRequest) -> list[float]:
        rng = random.Random(r.tag)
        crossfade = min(0.5, r.duration_sec / 4) if r.loopable else 0.0
        n = int((r.duration_sec + crossfade) * SR)
        tag = r.tag.lower()
        out = []
        for i in range(n):
            t = i / SR
            if "thunder" in tag:
                s = (rng.random() * 2 - 1) * 0.9 * math.exp(-t * 1.2)
            elif "foot" in tag or "step" in tag:
                s = (rng.random() * 2 - 1) * 0.7 if t % 0.5 < 0.06 else 0.0
            elif "bird" in tag:
                s = 0.4 * math.sin(2 * math.pi * (2400 + 9000 * (t % 0.9)) * (t % 0.9)) if t % 0.9 < 0.12 else 0.0
            else:
                s = (rng.random() * 2 - 1) * 0.25 * (0.6 + 0.4 * math.sin(t * 0.9))
            out.append(s)
        if crossfade:
            xf = int(crossfade * SR)
            head = out[: n - xf]
            for i in range(xf):
                a = i / xf
                head[i] = head[i] * a + out[n - xf + i] * (1 - a)
            return head
        return out


class MockLipSyncModel(Model[LipSyncRequest]):
    info = _info("mock-lipsync", "lipsync", "Mock lip-sync", 16)

    def __init__(self, media: MediaTools) -> None:
        super().__init__()
        self.media = media

    def run(self, request: LipSyncRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        ctx.set_status("running", "mock lip sync")
        audio_sha = hashlib.sha256(request.audio).hexdigest()
        if sniff(request.video) == "mp4":
            src = ctx.path("original.mp4")
            src.write_bytes(request.video)
            self.media.tag_copy(ctx, src, ctx.path("lipsync.mp4"), f"AI Story Studio MOCK lip sync audio={audio_sha[:16]}")
            ctx.add_output("lipsync.mp4", "video/mp4", mock=True)
            return
        manifest = json.loads(request.video.decode("utf-8"))
        manifest["note"] = "MOCK LIP-SYNC CLIP — placeholder manifest"
        manifest["lipSync"] = {"audioChecksum": audio_sha}
        ctx.path("lipsync.json").write_text(json.dumps(manifest, indent=2))
        ctx.add_output("lipsync.json", MOCK_VIDEO_MIME, width=manifest.get("width"), height=manifest.get("height"), mock=True)


class MockUpscaler(Model[UpscaleRequest]):
    info = _info("mock-upscaler", "upscale", "Mock upscaler", 8)

    def __init__(self, media: MediaTools) -> None:
        super().__init__()
        self.media = media

    def run(self, request: UpscaleRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        tw, th = _even(request.target_width), _even(request.target_height)
        kind = sniff(request.source)
        ctx.set_status("running", f"upscaling to {tw}x{th}")
        if kind == "png":
            w, h, rgb = decode_simple_png(request.source)

            def pixel(x: int, y: int) -> bytes:
                o = (min(h - 1, y * h // th) * w + min(w - 1, x * w // tw)) * 3
                return rgb[o : o + 3]

            ctx.path("upscaled.png").write_bytes(encode_png(tw, th, pixel))
            ctx.add_output("upscaled.png", "image/png", width=tw, height=th, native_resolution=False, mock=True)
        elif kind == "mp4":
            src = ctx.path("source.mp4")
            src.write_bytes(request.source)
            self.media.scale_video(ctx, src, ctx.path("upscaled.mp4"), width=tw, height=th)
            ctx.add_output("upscaled.mp4", "video/mp4", width=tw, height=th, native_resolution=False, mock=True)
        else:
            manifest = json.loads(request.source.decode("utf-8"))
            manifest.update({"upscaledFrom": f"{manifest.get('width')}x{manifest.get('height')}", "width": tw, "height": th})
            ctx.path("upscaled.json").write_text(json.dumps(manifest, indent=2))
            ctx.add_output("upscaled.json", MOCK_VIDEO_MIME, width=tw, height=th, native_resolution=False, mock=True)


class MockTextModel(Model[TextRequest]):
    """Placeholder text model: echoes a labelled, deterministic answer (never a real story)."""

    def __init__(self) -> None:
        super().__init__()
        self.info = _info("mock-text", "text", "Mock text generator", 0, "cpu")

    def run(self, request: TextRequest, ctx: JobContext) -> None:
        _controls(request.settings, ctx)
        ctx.set_status("running", "writing (mock)")
        digest = hashlib.sha256(f"{request.seed}:{request.prompt}".encode()).hexdigest()[:12]
        text = json.dumps({"mock": True, "note": "placeholder text, not AI", "digest": digest}) if request.json else f"MOCK TEXT {digest}"
        ctx.path("text.json").write_text(json.dumps({"text": text, "tokens": len(text.split()), "mock": True}))
        ctx.add_output("text.json", "application/json", mock=True)
