"""Request validation for worker endpoints (dependency-free).

Every field is type-checked and bounded; unknown fields are rejected;
embedded files (base64) are size-limited and their magic bytes checked.
Errors are collected so a client sees every problem at once.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
from typing import Any, Literal

QUALITY_MODES = ("fast_preview", "optimized", "high_quality")
EMOTIONS = (
    "neutral",
    "happy",
    "sad",
    "excited",
    "afraid",
    "angry",
    "whispering",
    "tired",
    "surprised",
    "nervous",
    "calm",
)
AUDIO_KINDS = ("tts", "music", "sfx", "ambience")
PRESENTATIONS = ("male", "female", "neutral")
MAX_SEED = 2**32 - 1

ImageKind = Literal["png", "jpeg", "webp"]


class ValidationError(Exception):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in errors))
        self.errors = errors


@dataclass
class _V:
    """Collects errors while reading fields from a JSON object."""

    data: dict[str, Any]
    max_bytes: int
    errors: list[dict[str, str]] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)

    def err(self, path: str, message: str) -> None:
        self.errors.append({"path": path, "message": message})

    def str_(self, key: str, *, max_len: int = 8000, required: bool = False, default: str = "") -> str:
        self.seen.add(key)
        v = self.data.get(key)
        if v is None:
            if required:
                self.err(key, "is required")
            return default
        if not isinstance(v, str):
            self.err(key, "must be a string")
            return default
        if len(v) > max_len:
            self.err(key, f"must be at most {max_len} characters")
            return default
        if required and not v.strip():
            self.err(key, "is required")
        return v

    def int_(self, key: str, *, low: int, high: int, default: int | None = None) -> int:
        self.seen.add(key)
        v = self.data.get(key)
        if v is None:
            if default is None:
                self.err(key, "is required")
                return low
            return default
        if isinstance(v, bool) or not isinstance(v, int):
            self.err(key, "must be an integer")
            return default if default is not None else low
        if not low <= v <= high:
            self.err(key, f"must be between {low} and {high}")
            return default if default is not None else low
        return int(v)

    def float_(self, key: str, *, low: float, high: float, default: float | None = None) -> float:
        self.seen.add(key)
        v = self.data.get(key)
        if v is None:
            if default is None:
                self.err(key, "is required")
                return low
            return default
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            self.err(key, "must be a number")
            return default if default is not None else low
        if not low <= float(v) <= high:
            self.err(key, f"must be between {low} and {high}")
            return default if default is not None else low
        return float(v)

    def enum(self, key: str, values: tuple[str, ...], default: str | None = None) -> str:
        self.seen.add(key)
        v = self.data.get(key, default)
        if v is None:
            self.err(key, "is required")
            return values[0]
        if v not in values:
            self.err(key, f"must be one of: {', '.join(values)}")
            return values[0]
        return str(v)

    def bool_(self, key: str, default: bool = False) -> bool:
        self.seen.add(key)
        v = self.data.get(key, default)
        if not isinstance(v, bool):
            self.err(key, "must be true or false")
            return default
        return v

    def dict_(self, key: str, *, max_bytes: int = 16384) -> dict[str, Any]:
        self.seen.add(key)
        v = self.data.get(key)
        if v is None:
            return {}
        if not isinstance(v, dict):
            self.err(key, "must be an object")
            return {}
        if len(repr(v)) > max_bytes:
            self.err(key, f"must be smaller than {max_bytes} bytes")
            return {}
        return v

    def file(self, key: str, kinds: tuple[str, ...], *, required: bool = True) -> bytes | None:
        self.seen.add(key)
        v = self.data.get(key)
        if v is None:
            if required:
                self.err(key, "is required")
            return None
        if not isinstance(v, str):
            self.err(key, "must be a base64 string")
            return None
        if len(v) > self.max_bytes * 4 // 3 + 8:
            self.err(key, f"file is larger than {self.max_bytes // (1024 * 1024)} MB")
            return None
        try:
            raw = base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError):
            self.err(key, "is not valid base64")
            return None
        kind = sniff(raw)
        if kind not in kinds:
            self.err(key, f"must be one of: {', '.join(kinds)} (got {kind or 'unknown'})")
            return None
        return raw

    def done(self) -> None:
        for key in self.data:
            if key not in self.seen:
                self.err(key, "is not a recognised field")
        if self.errors:
            raise ValidationError(self.errors)


def sniff(data: bytes) -> str | None:
    """Identify a file by its magic bytes (never trust names or declared types)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[4:8] == b"ftyp":
        return "mp4"
    if data[:1] == b"{" and b'"format"' in data[:200]:
        return "mock-video"
    return None


@dataclass(frozen=True)
class ImageRequest:
    prompt: str
    negative_prompt: str
    seed: int
    width: int
    height: int
    quality: str
    model: str
    init_image: bytes | None
    settings: dict[str, Any]


@dataclass(frozen=True)
class VideoRequest:
    image: bytes
    motion_prompt: str
    negative_prompt: str
    seed: int
    duration_sec: float
    fps: int
    width: int
    height: int
    quality: str
    model: str
    settings: dict[str, Any]


@dataclass(frozen=True)
class AudioRequest:
    kind: str
    model: str
    text: str
    language: str
    emotion: str
    speed: float
    voice_identity: str
    presentation: str
    pitch: float
    mood: str
    genre: str
    energy: str
    tag: str
    duration_sec: float
    loopable: bool
    settings: dict[str, Any]
    seed: int = 0
    # Optional reference recording for voice cloning (TTS only). The app sends it
    # only for voice profiles with recorded consent; the flag is re-checked here.
    voice_reference: bytes | None = None
    voice_reference_consent: bool = False


@dataclass(frozen=True)
class LipSyncRequest:
    video: bytes
    audio: bytes
    model: str
    settings: dict[str, Any]


@dataclass(frozen=True)
class UpscaleRequest:
    source: bytes
    target_width: int
    target_height: int
    model: str
    settings: dict[str, Any]


def _obj(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValidationError([{"path": "", "message": "request body must be a JSON object"}])
    return body


def parse_image(body: Any, max_bytes: int) -> ImageRequest:
    v = _V(_obj(body), max_bytes)
    req = ImageRequest(
        prompt=v.str_("prompt", required=True),
        negative_prompt=v.str_("negative_prompt"),
        seed=v.int_("seed", low=0, high=MAX_SEED, default=0),
        width=v.int_("width", low=64, high=4096, default=1024),
        height=v.int_("height", low=64, high=4096, default=576),
        quality=v.enum("quality", QUALITY_MODES, "optimized"),
        model=v.str_("model", max_len=120),
        init_image=v.file("init_image", ("png", "jpeg", "webp"), required=False),
        settings=v.dict_("settings"),
    )
    v.done()
    return req


def parse_video(body: Any, max_bytes: int) -> VideoRequest:
    v = _V(_obj(body), max_bytes)
    image = v.file("image", ("png", "jpeg", "webp"))
    fps = v.int_("fps", low=24, high=30, default=24)
    if fps not in (24, 30):
        v.err("fps", "must be 24 or 30")
    req = VideoRequest(
        image=image or b"",
        motion_prompt=v.str_("motion_prompt"),
        negative_prompt=v.str_("negative_prompt"),
        seed=v.int_("seed", low=0, high=MAX_SEED, default=0),
        duration_sec=v.float_("duration_sec", low=0.5, high=60, default=5),
        fps=fps,
        width=v.int_("width", low=64, high=4096, default=1920),
        height=v.int_("height", low=64, high=4096, default=1080),
        quality=v.enum("quality", QUALITY_MODES, "optimized"),
        model=v.str_("model", max_len=120),
        settings=v.dict_("settings"),
    )
    for dim in ("width", "height"):
        if getattr(req, dim) % 2:
            v.err(dim, "must be even (H.264 requirement)")
    v.done()
    return req


def parse_audio(body: Any, max_bytes: int) -> AudioRequest:
    v = _V(_obj(body), max_bytes)
    kind = v.enum("kind", AUDIO_KINDS)
    req = AudioRequest(
        kind=kind,
        model=v.str_("model", max_len=120),
        text=v.str_("text", max_len=5000, required=kind == "tts"),
        language=v.str_("language", max_len=16, default="en"),
        emotion=v.enum("emotion", EMOTIONS, "neutral"),
        speed=v.float_("speed", low=0.5, high=2, default=1),
        voice_identity=v.str_("voice_identity", max_len=200),
        presentation=v.enum("presentation", PRESENTATIONS, "neutral"),
        pitch=v.float_("pitch", low=-12, high=12, default=0),
        mood=v.str_("mood", max_len=200),
        genre=v.str_("genre", max_len=200),
        energy=v.str_("energy", max_len=20),
        tag=v.str_("tag", max_len=60, required=kind in ("sfx", "ambience")),
        duration_sec=v.float_("duration_sec", low=0.2, high=600, default=5),
        loopable=v.bool_("loopable", kind == "ambience"),
        settings=v.dict_("settings"),
        seed=v.int_("seed", low=0, high=2**31 - 1, default=0),
        voice_reference=v.file("voice_reference", ("wav",), required=False),
        voice_reference_consent=v.bool_("voice_reference_consent", False),
    )
    if req.voice_reference is not None:
        if kind != "tts":
            v.err("voice_reference", "is only accepted for tts")
        if not req.voice_reference_consent:
            v.err("voice_reference_consent", "must be true: reference audio needs the speaker's recorded consent")
    v.done()
    return req


def parse_lipsync(body: Any, max_bytes: int) -> LipSyncRequest:
    v = _V(_obj(body), max_bytes)
    req = LipSyncRequest(
        video=v.file("video", ("mp4", "mock-video")) or b"",
        audio=v.file("audio", ("wav",)) or b"",
        model=v.str_("model", max_len=120),
        settings=v.dict_("settings"),
    )
    v.done()
    return req


def parse_upscale(body: Any, max_bytes: int) -> UpscaleRequest:
    v = _V(_obj(body), max_bytes)
    req = UpscaleRequest(
        source=v.file("source", ("png", "mp4", "mock-video")) or b"",
        target_width=v.int_("target_width", low=64, high=4096, default=1920),
        target_height=v.int_("target_height", low=64, high=4096, default=1080),
        model=v.str_("model", max_len=120),
        settings=v.dict_("settings"),
    )
    v.done()
    return req
