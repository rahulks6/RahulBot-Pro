"""Open-source text-to-speech adapters: Kokoro (Apache-2.0) and Chatterbox (MIT)."""

from __future__ import annotations

from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
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


def normalize_language(code: str) -> str:
    """App language codes → Kokoro language keys: en, en-gb, hi, hinglish (hi-Latn / hinglish)."""
    c = (code or "en").strip().lower().replace("_", "-")
    if c in ("hinglish", "hi-latn", "hi-en", "en-hi"):
        return "hinglish"
    if c.startswith("hi"):
        return "hi"
    if c in ("en-gb", "en-uk"):
        return "en-gb"
    if c.startswith("en"):
        return "en"
    return c


DEVANAGARI = (0x0900, 0x097F)


def script_runs(text: str) -> list[tuple[str, str]]:
    """Split mixed Hindi/English text into ('hi'|'en', chunk) runs; spaces and punctuation join the current run."""
    runs: list[tuple[str, str]] = []
    for ch in text:
        if DEVANAGARI[0] <= ord(ch) <= DEVANAGARI[1]:
            kind = "hi"
        elif ch.isalpha():
            kind = "en"
        else:
            kind = runs[-1][0] if runs else "en"
        if runs and runs[-1][0] == kind:
            runs[-1] = (kind, runs[-1][1] + ch)
        else:
            runs.append((kind, ch))
    return [(k, t) for k, t in runs if t.strip()]


class KokoroTts(Model[AudioRequest]):
    """Kokoro 82M via the ``kokoro`` package (24 kHz, CPU is enough).

    Languages: English (US/UK) and Hindi, with a voice per presentation; Hinglish (Hindi in Latin
    script mixed with English) is read with ONE Hindi voice: Devanagari runs use the Hindi
    phonemizer, Latin runs the English one. No emotion control: delivery uses speed only.
    """

    SAMPLE_RATE = 24_000

    def __init__(self, entry: CatalogEntry) -> None:
        super().__init__()
        self.entry = entry
        self.info = info_from(entry, "cpu")
        self.pipelines: dict[str, Any] = {}
        self.kokoro: Any = None

    @property
    def pipeline(self) -> Any:
        """The default-language pipeline (kept for older callers)."""
        return self.pipelines.get(str(self.entry.params.get("lang_code", "a")))

    def load(self, ctx: JobContext) -> None:
        self.kokoro = require("kokoro")
        self._pipeline(str(self.entry.params.get("lang_code", "a")))
        self.loaded = True

    def unload(self) -> None:
        self.pipelines = {}
        self.loaded = False

    def _pipeline(self, lang_code: str) -> Any:
        """One pipeline per phonemizer language; all share the first pipeline's model weights."""
        if lang_code not in self.pipelines:
            first = next(iter(self.pipelines.values()), None)
            kwargs: dict[str, Any] = {"lang_code": lang_code}
            if first is not None and getattr(first, "model", None) is not None:
                kwargs["model"] = first.model
            self.pipelines[lang_code] = self.kokoro.KPipeline(**supported_kwargs(self.kokoro.KPipeline, kwargs))
        return self.pipelines[lang_code]

    def languages(self) -> dict[str, dict[str, Any]]:
        langs: dict[str, dict[str, Any]] = dict(self.entry.params.get("languages") or {})
        langs.setdefault(
            "en" if str(self.entry.params.get("lang_code", "a")) == "a" else "default",
            {"lang_code": str(self.entry.params.get("lang_code", "a")), "voices": self.entry.params.get("voices", {})},
        )
        return langs

    def voice_for(self, request: AudioRequest, lang: dict[str, Any] | None = None) -> str:
        voices: dict[str, str] = (lang or {}).get("voices") or self.entry.params.get("voices", {})
        # A locked voice profile may pin an explicit Kokoro voice id ("kokoro:af_bella").
        explicit = request.voice_identity.split(":", 1)[-1]
        if explicit and explicit.replace("_", "").isalnum() and "_" in explicit:
            return explicit
        return voices.get(request.presentation) or str(self.entry.params.get("default_voice", "af_heart"))

    def _speak(self, text: str, lang_code: str, voice: str, speed: float, ctx: JobContext) -> list[float]:
        samples: list[float] = []
        for _graphemes, _phonemes, audio in self._pipeline(lang_code)(text, voice=voice, speed=speed):
            ctx.check()
            samples.extend(to_floats(audio))
        return samples

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        key = normalize_language(request.language)
        langs = self.languages()
        if key == "hinglish" or (key == "hi" and any(k == "en" for k, _ in script_runs(request.text))):
            key = "hinglish"
            hi = langs.get("hi")
            en = langs.get("en")
            if not hi or not en:
                raise JobError("TTS_FAILED", f"{self.entry.id}: Hinglish needs both Hindi and English in the catalog")
            voice = self.voice_for(request, hi)
            samples: list[float] = []
            for kind, chunk in script_runs(request.text):
                code = str((hi if kind == "hi" else en)["lang_code"])
                samples.extend(self._speak(chunk, code, voice, request.speed, ctx))
            ctx.log(f"Hinglish: {len(script_runs(request.text))} script run(s), one Hindi voice ({voice})")
        else:
            lang = langs.get(key) or (langs.get("default") if key == "en" else None)
            if lang is None:
                supported = ", ".join(sorted({*langs.keys(), "hinglish"} - {"default"}))
                raise JobError(
                    "TTS_FAILED",
                    f"{self.entry.display_name or self.entry.id} has no voice for language '{request.language}'. Supported: {supported}.",
                )
            voice = self.voice_for(request, lang)
            samples = self._speak(request.text, str(lang["lang_code"]), voice, request.speed, ctx)
        if request.voice_reference is not None:
            ctx.log("kokoro cannot clone from reference audio; the locked preset voice is used")
        ctx.job.metrics["voice_reference_used"] = False
        if request.emotion not in ("neutral", "calm"):
            ctx.log(f"kokoro has no emotion control; '{request.emotion}' delivered via speed only")
        ctx.job.details["tts"] = {"language": key, "voice": voice, "engine": "kokoro"}
        write_wav(ctx.path("audio.wav"), samples, self.SAMPLE_RATE)
        ctx.add_output("audio.wav", "audio/wav", duration_sec=round(len(samples) / self.SAMPLE_RATE, 3))


class ChatterboxTts(Model[AudioRequest]):
    """Chatterbox via ``chatterbox-tts``; emotion maps to its exaggeration control."""

    def __init__(self, entry: CatalogEntry) -> None:
        super().__init__()
        self.entry = entry
        self.info = info_from(entry, "cuda")
        self.model: Any = None
        self.torch: Any = None
        self.multilingual = False

    def load(self, ctx: JobContext) -> None:
        torch = require("torch")
        device = "cuda" if cuda_available(torch) else "cpu"
        self.torch = torch
        # The multilingual model (23 languages incl. Hindi) is used when the package provides it.
        try:
            import importlib

            mtl = importlib.import_module("chatterbox.mtl_tts")
            self.model = mtl.ChatterboxMultilingualTTS.from_pretrained(device=device)
            self.multilingual = True
        except (ImportError, AttributeError):
            tts = require("chatterbox.tts")
            self.model = tts.ChatterboxTTS.from_pretrained(device=device)
            self.multilingual = False
        self.loaded = True

    def unload(self) -> None:
        self.model = None
        self.loaded = False

    def run(self, request: AudioRequest, ctx: JobContext) -> None:
        lang = normalize_language(request.language)
        if lang != "en" and not self.multilingual:
            raise JobError(
                "TTS_FAILED",
                f"Chatterbox (English model) cannot speak '{request.language}'. Use Kokoro for Hindi / Hinglish, "
                "or install a chatterbox-tts version with the multilingual model.",
            )
        kwargs: dict[str, Any] = {
            "exaggeration": EXAGGERATION.get(request.emotion, 0.5),
            "cfg_weight": float(self.entry.params.get("cfg_weight", 0.5)),
        }
        if self.multilingual:
            kwargs["language_id"] = "hi" if lang in ("hi", "hinglish") else lang.split("-")[0]
        # Same text + same seed → the same delivery (sampling is otherwise random).
        if self.torch is not None and hasattr(self.torch, "manual_seed"):
            self.torch.manual_seed(request.seed)
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
