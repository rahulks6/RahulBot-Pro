"""TTS languages (English, Hindi, Hinglish), Chatterbox multilingual + seed, and still-image motion."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, ClassVar

import pytest

from ais_worker.adapters.still_motion import motion_filter
from ais_worker.adapters.tts import normalize_language, script_runs
from ais_worker.api import WorkerAPI

from .conftest import has_ffmpeg, make_config, png_b64, post, wait
from .test_catalog_adapters import entry, write_catalog

LANGS = {
    "en": {"lang_code": "a", "voices": {"female": "af_heart", "male": "am_michael"}},
    "en-gb": {"lang_code": "b", "voices": {"female": "bf_emma"}},
    "hi": {"lang_code": "h", "voices": {"female": "hf_alpha", "male": "hm_omega"}},
}


def test_language_codes_are_normalized() -> None:
    assert [normalize_language(c) for c in ["en", "en-US", "EN_gb", "hi", "hi-IN", "hi-Latn", "Hinglish", "fr"]] == [
        "en",
        "en",
        "en-gb",
        "hi",
        "hi",
        "hinglish",
        "hinglish",
        "fr",
    ]


def test_script_runs_split_devanagari_and_latin() -> None:
    runs = script_runs("Milo ne kaha, नमस्ते दोस्त! Let's go.")
    assert [k for k, _ in runs] == ["en", "hi", "en"]
    assert runs[1][1].strip() == "नमस्ते दोस्त!"
    assert "".join(t for _, t in runs) == "Milo ne kaha, नमस्ते दोस्त! Let's go."


@pytest.fixture
def kokoro(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    mod = types.ModuleType("kokoro")

    class KPipeline:
        created: ClassVar[list[dict[str, Any]]] = []

        def __init__(self, lang_code: str, model: Any = True) -> None:
            self.lang_code = lang_code
            self.model = model if model is not True else object()
            KPipeline.created.append({"lang": lang_code, "shared": model is not True})

        def __call__(self, text: str, voice: str, speed: float) -> Any:
            calls.append({"lang": self.lang_code, "voice": voice, "text": text})
            yield ("g", "p", [0.1] * 2400)

    mod.KPipeline = KPipeline  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro", mod)
    calls.append({"created": KPipeline.created})
    return calls


def tts_api(tmp_path: Path) -> WorkerAPI:
    cat = write_catalog(
        tmp_path,
        entry(
            id="kokoro", kind="tts", adapter="kokoro_tts", params={"lang_code": "a", "voices": LANGS["en"]["voices"], "languages": LANGS}
        ),
    )
    return WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))


def speak(api: WorkerAPI, text: str, language: str, presentation: str = "female") -> dict[str, Any]:
    _, job = post(api, "/generate/audio", {"kind": "tts", "text": text, "language": language, "presentation": presentation})
    return wait(api, job["id"])


def test_kokoro_speaks_english_uk_english_and_hindi(tmp_path: Path, kokoro: list[dict[str, Any]]) -> None:
    api = tts_api(tmp_path)
    assert speak(api, "Hello Milo", "en")["details"]["tts"] == {"language": "en", "voice": "af_heart", "engine": "kokoro"}
    assert speak(api, "Hello Milo", "en-GB")["details"]["tts"]["voice"] == "bf_emma"
    hindi = speak(api, "नमस्ते मिलो", "hi-IN", "male")
    assert hindi["status"] == "complete"
    assert hindi["details"]["tts"] == {"language": "hi", "voice": "hm_omega", "engine": "kokoro"}
    spoken = [c for c in kokoro if "lang" in c]
    assert [c["lang"] for c in spoken] == ["a", "b", "h"]
    created = kokoro[0]["created"]
    assert created[0]["shared"] is False and all(c["shared"] for c in created[1:]), "one set of model weights"
    api.close()


def test_hinglish_uses_one_hindi_voice_across_scripts(tmp_path: Path, kokoro: list[dict[str, Any]]) -> None:
    api = tts_api(tmp_path)
    done = speak(api, "Milo ne kaha नमस्ते friend", "hi-Latn")
    assert done["status"] == "complete", done
    spoken = [c for c in kokoro if "lang" in c]
    assert [c["lang"] for c in spoken] == ["a", "h", "a"], "English and Hindi phonemizers per script run"
    assert {c["voice"] for c in spoken} == {"hf_alpha"}, "one Hindi voice for the whole line"
    assert done["details"]["tts"]["language"] == "hinglish"
    api.close()


def test_unsupported_language_is_refused_with_the_supported_list(tmp_path: Path, kokoro: list[dict[str, Any]]) -> None:
    api = tts_api(tmp_path)
    done = speak(api, "Bonjour", "fr")
    assert done["error"]["code"] == "TTS_FAILED"
    assert "no voice for language 'fr'" in done["error"]["message"] and "hinglish" in done["error"]["message"]
    api.close()


def test_chatterbox_multilingual_and_seed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    torch.manual_seed = lambda s: seen.setdefault("seeds", []).append(s)  # type: ignore[attr-defined]

    class Model:
        sr = 24000

        def generate(self, text: str, exaggeration: float = 0.5, cfg_weight: float = 0.5, language_id: str = "en") -> Any:
            seen["language_id"] = language_id
            return [0.0] * 2400

    mtl = types.ModuleType("chatterbox.mtl_tts")
    mtl.ChatterboxMultilingualTTS = types.SimpleNamespace(from_pretrained=lambda device: Model())  # type: ignore[attr-defined]
    for name, mod in {"torch": torch, "chatterbox": types.ModuleType("chatterbox"), "chatterbox.mtl_tts": mtl}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    cat = write_catalog(tmp_path, entry(id="cb", kind="tts", adapter="chatterbox_tts", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    _, job = post(api, "/generate/audio", {"kind": "tts", "text": "नमस्ते", "language": "hi", "seed": 42})
    assert wait(api, job["id"])["status"] == "complete"
    assert seen["language_id"] == "hi" and seen["seeds"] == [42]
    api.close()


def test_english_only_chatterbox_refuses_hindi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    tts = types.ModuleType("chatterbox.tts")
    tts.ChatterboxTTS = types.SimpleNamespace(from_pretrained=lambda device: object())  # type: ignore[attr-defined]
    for name, mod in {"torch": torch, "chatterbox": types.ModuleType("chatterbox"), "chatterbox.tts": tts}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setitem(sys.modules, "chatterbox.mtl_tts", None)
    cat = write_catalog(tmp_path, entry(id="cb", kind="tts", adapter="chatterbox_tts", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    _, job = post(api, "/generate/audio", {"kind": "tts", "text": "नमस्ते", "language": "hi"})
    err = wait(api, job["id"])["error"]
    assert err["code"] == "TTS_FAILED" and "Use Kokoro" in err["message"]
    api.close()


# --- still image + camera move -----------------------------------------------------------------


def test_motion_filters_follow_the_camera_movement() -> None:
    push = motion_filter("slow push-in", 0.5, 1920, 1080, 120, 30)
    assert "min(zoom+" in push and "s=1920x1080" in push and "fps=30" in push
    assert "max(zoom-" in motion_filter("pull out to reveal the forest", 0.5, 1920, 1080, 120, 30)
    assert "(1-on/120)" in motion_filter("pan left", 0.5, 1920, 1080, 120, 30)
    assert "on/120" in motion_filter("pan right", 0.5, 1920, 1080, 120, 30)
    strong = motion_filter("push-in", 1.0, 1920, 1080, 120, 30)
    gentle = motion_filter("push-in", 0.0, 1920, 1080, 120, 30)
    assert strong != gentle, "motion strength changes the amount of movement"


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_still_motion_makes_a_real_h264_clip_and_labels_it(tmp_path: Path) -> None:
    cat = write_catalog(tmp_path, entry(id="still", kind="video", adapter="ffmpeg_still_motion", repo="", params={"zoom": 0.08}))
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    _, job = post(
        api,
        "/generate/image-to-video",
        {"image": png_b64(320, 180), "duration_sec": 2, "fps": 30, "width": 640, "height": 360, "camera_movement": "pan right"},
    )
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert done["details"]["still_motion"] is True
    assert done["model"]["mock"] is False
    probe = api.media.probe_file(api.jobs.output_path(job["id"], "clip.mp4"))
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert (video["codec_name"], video["width"], video["height"], video["avg_frame_rate"]) == ("h264", 640, 360, "30/1")
    assert abs(float(probe["format"]["duration"]) - 2.0) < 0.1
    api.close()
