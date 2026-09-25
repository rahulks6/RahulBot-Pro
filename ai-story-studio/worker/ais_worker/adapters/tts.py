"""Open-source text-to-speech adapters: Kokoro (Apache-2.0) and Chatterbox (MIT)."""

from __future__ import annotations

from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext
from ..models.base import Model
from ..models.mock import write_wav
from ..schemas import AudioRequest
from .common import cuda_available, info_from, require, supported_kwargs, to_floats

# Emotion → Chatterbox "exaggeration" (0.25 flat … 1.0 very expressive). Identity stays the same.
EXAGGERATION = {
    "neutral": 0.5,
    "calm": 0.35,
    "tired": 0.3,
    "whispering": 0.3,
    "sad": 0.45,
    "happy": 0.65,
    "nervous": 0.6,
    "afraid": 0.7,
    "surprised": 0.75,
    "excited": 0.85,
    "angry": 0.9,
}


class KokoroTts(Model[AudioRequest]):
    """Kokoro 82M via the ``kokoro`` package (24 kHz). No emotion control: delivery uses speed only."""

    SAMPLE_RATE = 24_000

    def __init__(self, entry: CatalogEntry) -> None:
        super().__init__()
        self.entry = entry
        self.info = info_from(entry, "cpu")
        self.pipeline: Any = None

    def load(self, ctx: JobContext) -> None:
        kokoro = require("kokoro")
        self.pipeline = kokoro.KPipeline(lang_code=str(self.entry.params.get("lang_code", "a")))
        self.loaded = True

    def unload(self) -> None:
        self.pipeline = None
        self.loaded = False

    def voice_for(self, request: AudioRequest) -> str:
        voices: dict[str, str] = self.entry.params.get("voices", {})
        # A locked voice profile may pin an explicit Kokoro voice id ("kokoro:af_bella").
        explicit = request.voice_identity.split(":", 1)[-1]
        if explicit and explicit.replace("_", "").isalnum() and "_" in explicit:
            return explicit
        return voices.get(request.presentation) or str(self.entry.params.get("default_voice", "af_heart"))

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        voice = self.voice_for(request)
        if request.voice_reference is not None:
            ctx.log("kokoro cannot clone from reference audio; the locked preset voice is used")
        ctx.job.metrics["voice_reference_used"] = False
        if request.emotion not in ("neutral", "calm"):
            ctx.log(f"kokoro has no emotion control; '{request.emotion}' delivered via speed only")
        samples: list[float] = []
        for _graphemes, _phonemes, audio in self.pipeline(request.text, voice=voice, speed=request.speed):
            ctx.check()
            samples.extend(to_floats(audio))
        write_wav(ctx.path("audio.wav"), samples, self.SAMPLE_RATE)
        ctx.add_output("audio.wav", "audio/wav", duration_sec=round(len(samples) / self.SAMPLE_RATE, 3))


class ChatterboxTts(Model[AudioRequest]):
    """Chatterbox via ``chatterbox-tts``; emotion maps to its exaggeration control."""

    def __init__(self, entry: CatalogEntry) -> None:
        super().__init__()
        self.entry = entry
        self.info = info_from(entry, "cuda")
        self.model: Any = None

    def load(self, ctx: JobContext) -> None:
        torch = require("torch")
        tts = require("chatterbox.tts")
        self.model = tts.ChatterboxTTS.from_pretrained(device="cuda" if cuda_available(torch) else "cpu")
        self.loaded = True

    def unload(self) -> None:
        self.model = None
        self.loaded = False

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        kwargs: dict[str, Any] = {
            "exaggeration": EXAGGERATION.get(request.emotion, 0.5),
            "cfg_weight": float(self.entry.params.get("cfg_weight", 0.5)),
        }
        reference = ctx.path("reference.wav")
        # Voice cloning only from a consented reference (checked by the app and again by the schema).
        if request.voice_reference is not None and request.voice_reference_consent:
            reference.write_bytes(request.voice_reference)
            kwargs["audio_prompt_path"] = str(reference)
        try:
            wav = self.model.generate(request.text, **supported_kwargs(self.model.generate, kwargs))
        finally:
            # The reference recording is personal data: never kept in the job directory.
            reference.unlink(missing_ok=True)
        ctx.job.metrics["voice_reference_used"] = "audio_prompt_path" in kwargs
        samples = to_floats(wav)
        rate = int(self.model.sr)
        write_wav(ctx.path("audio.wav"), samples, rate)
        ctx.add_output("audio.wav", "audio/wav", duration_sec=round(len(samples) / rate, 3))
