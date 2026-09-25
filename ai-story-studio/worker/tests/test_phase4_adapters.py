"""Phase 4 adapter CONTRACT tests: Stable Audio (music / SFX / ambience), spandrel
AI upscaling, command-driven lip sync and consented voice references.

As in Phase 3, heavy libraries are replaced by fakes that follow their
documented call signatures; audio post-processing, tiling, FFmpeg steps and
the subprocess contract are real.
"""

from __future__ import annotations

import base64
import io
import math
import struct
import subprocess
import sys
import types
import wave
from array import array
from pathlib import Path
from typing import Any

import pytest

from ais_worker.adapters.audio_gen import build_prompt, fade_edges, limit_peak, make_loopable, tile, to_mono
from ais_worker.adapters.upscale import tile_plan
from ais_worker.api import WorkerAPI
from ais_worker.models.mock import write_wav
from ais_worker.schemas import parse_audio

from .conftest import has_ffmpeg, make_config, png_b64, post, wait
from .test_catalog_adapters import FakeImage, entry, fake_pil, fake_torch, write_catalog

SR = 8000


def wav_info(path: Path) -> tuple[int, int, float]:
    with wave.open(str(path), "rb") as w:
        return w.getnchannels(), w.getframerate(), w.getnframes() / w.getframerate()


def wav_b64(seconds: float = 0.5) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return base64.b64encode(buf.getvalue()).decode()


# --- audio post-processing (pure, real) ------------------------------------------------


def test_tile_joins_sections_to_the_exact_length_without_gaps() -> None:
    sec = array("f", [0.5] * 1000)
    out = tile([sec, sec], total=3500, overlap=100)
    assert len(out) == 3500
    # Equal-power crossfade of two equal constant signals peaks at +3 dB and never drops out.
    assert min(out) > 0.49 and max(out) < 0.5 * math.sqrt(2) + 1e-3


def test_make_loopable_crossfades_tail_into_head() -> None:
    n = 4000
    x = array("f", [math.sin(2 * math.pi * 3 * i / n) + 0.3 * (i / n) for i in range(n)])  # drifting: naive loop clicks
    loop = make_loopable(x, 400)
    assert len(loop) == n - 400
    seam = abs(loop[-1] - loop[0])
    assert seam < 0.05, f"loop seam jump {seam}"
    assert abs(x[-1] - x[0]) > 0.25, "the source itself would click"


def test_fades_peak_limit_and_mono_downmix() -> None:
    x = fade_edges(array("f", [1.0] * 100), 100, 0.1, 0.2)
    assert x[0] == 0.0 and x[-1] == 0.0 and x[50] == 1.0
    assert max(limit_peak(array("f", [2.0, -4.0]))) == pytest.approx(0.891 / 2)
    assert list(limit_peak(array("f", [0.2]))) == pytest.approx([0.2]), "never boosts"
    assert list(to_mono([[1.0, 0.0], [0.0, 1.0]])) == [0.5, 0.5]
    assert list(to_mono([[1.0, 0.0]] * 10)) == [0.5] * 10, "(samples, channels) layout"


def test_prompts_for_music_sfx_and_ambience() -> None:
    def req(**kw: Any) -> Any:
        return parse_audio({"duration_sec": 5, **kw}, 1 << 20)

    music, neg = build_prompt(req(kind="music", mood="gentle wonder", genre="orchestral", energy="low"), {})
    assert "orchestral" in music and "gentle wonder" in music and "low energy" in music and "vocals" in neg
    sfx, _ = build_prompt(req(kind="sfx", tag="door creak"), {})
    assert sfx.startswith("door creak sound effect")
    amb, neg_amb = build_prompt(req(kind="ambience", tag="rain on a tin roof"), {"ambience_negative_prompt": "thunder"})
    assert "rain on a tin roof ambience" in amb and neg_amb == "thunder"


# --- Stable Audio adapter ---------------------------------------------------------------

AUDIO_CALLS: list[dict[str, Any]] = []


class FakeStableAudioPipe:
    vae = types.SimpleNamespace(sampling_rate=SR)

    def __call__(self, prompt: str, audio_end_in_s: float = 10.0, num_inference_steps: int = 100, guidance_scale: float = 7.0,
                 negative_prompt: str | None = None, num_waveforms_per_prompt: int = 1, generator: Any = None,
                 callback: Any = None, callback_steps: int = 1) -> Any:  # fmt: skip
        AUDIO_CALLS.append({"prompt": prompt, "seconds": audio_end_in_s, "negative": negative_prompt, "seed": generator.seed})
        for step in range(num_inference_steps):
            if callback:
                callback(step, 0, None)
        n = int(audio_end_in_s * SR)
        left = [0.8 * math.sin(2 * math.pi * 220 * i / SR) for i in range(n)]
        return types.SimpleNamespace(audios=[[left, [v * 0.5 for v in left]]])

    def to(self, _device: str) -> FakeStableAudioPipe:
        return self


@pytest.fixture
def audio_fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    AUDIO_CALLS.clear()
    diffusers = types.ModuleType("diffusers")

    class StableAudioPipeline:
        @staticmethod
        def from_pretrained(repo: str, **kwargs: Any) -> FakeStableAudioPipe:
            AUDIO_CALLS.append({"load": repo, "dtype": kwargs.get("torch_dtype")})
            return FakeStableAudioPipe()

    diffusers.StableAudioPipeline = StableAudioPipeline  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "diffusers", diffusers)
    monkeypatch.setitem(sys.modules, "torch", fake_torch())


def stable_audio_api(tmp_path: Path) -> WorkerAPI:
    params = {"num_inference_steps": 4, "max_section_sec": 47, "max_sections": 2, "crossfade_sec": 0.5}
    path = write_catalog(
        tmp_path,
        entry(id="sao-music", kind="music", adapter="stable_audio", repo="stabilityai/stable-audio-open-1.0", params=params),
        entry(id="sao-sfx", kind="sfx", adapter="stable_audio", repo="stabilityai/stable-audio-open-1.0", params=params),
    )
    return WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))


def test_stable_audio_music_bed(tmp_path: Path, audio_fakes: None) -> None:
    api = stable_audio_api(tmp_path)
    _, job = post(api, "/generate/audio", {"kind": "music", "mood": "calm", "genre": "piano", "duration_sec": 12, "seed": 9})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert done["model"]["id"] == "sao-music"
    call = AUDIO_CALLS[-1]
    assert call["seconds"] == 12 and call["seed"] == 9 and "piano" in call["prompt"] and "vocals" in call["negative"]
    channels, rate, seconds = wav_info(api.jobs.output_path(job["id"], "audio.wav"))
    assert (channels, rate, seconds) == (1, SR, 12.0)
    assert done["outputs"][0]["duration_sec"] == 12.0
    api.close()


def test_stable_audio_tiles_long_music_with_new_seeds(tmp_path: Path, audio_fakes: None) -> None:
    api = stable_audio_api(tmp_path)
    _, job = post(api, "/generate/audio", {"kind": "music", "mood": "calm", "duration_sec": 100, "seed": 3})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    gens = [c for c in AUDIO_CALLS if "seed" in c]
    assert [c["seed"] for c in gens] == [3, 4] and all(c["seconds"] == 47 for c in gens)
    assert wav_info(api.jobs.output_path(job["id"], "audio.wav"))[2] == 100.0
    assert any("tiled 2" in line for line in done["logs"])
    api.close()


def test_stable_audio_serves_sfx_and_loopable_ambience(tmp_path: Path, audio_fakes: None) -> None:
    api = stable_audio_api(tmp_path)
    _, sfx = post(api, "/generate/audio", {"kind": "sfx", "tag": "door creak", "duration_sec": 2})
    _, amb = post(api, "/generate/audio", {"kind": "ambience", "tag": "forest wind", "duration_sec": 6})
    assert wait(api, sfx["id"])["status"] == "complete"
    done = wait(api, amb["id"])
    assert done["status"] == "complete" and done["model"]["id"] == "sao-sfx"
    call = AUDIO_CALLS[-1]
    assert "forest wind ambience" in call["prompt"] and call["seconds"] == pytest.approx(6.5), "extra material for the loop crossfade"
    assert wav_info(api.jobs.output_path(amb["id"], "audio.wav"))[2] == 6.0
    api.close()


# --- consented voice reference -------------------------------------------------------------


def test_voice_reference_requires_consent_and_tts() -> None:
    with pytest.raises(Exception) as e:
        parse_audio({"kind": "tts", "text": "hi", "voice_reference": wav_b64()}, 1 << 20)
    assert "consent" in str(getattr(e.value, "errors", e.value))
    with pytest.raises(Exception):
        parse_audio({"kind": "music", "voice_reference": wav_b64(), "voice_reference_consent": True}, 1 << 20)
    req = parse_audio({"kind": "tts", "text": "hi", "voice_reference": wav_b64(), "voice_reference_consent": True}, 1 << 20)
    assert req.voice_reference is not None and req.voice_reference[:4] == b"RIFF"


def test_chatterbox_clones_from_a_consented_reference_and_deletes_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    tts_mod = types.ModuleType("chatterbox.tts")

    class ChatterboxTTS:
        sr = 24000

        @classmethod
        def from_pretrained(cls, device: str) -> ChatterboxTTS:
            return cls()

        def generate(self, text: str, exaggeration: float = 0.5, cfg_weight: float = 0.5, audio_prompt_path: str | None = None) -> Any:
            seen["path"] = audio_prompt_path
            seen["existed"] = bool(audio_prompt_path) and Path(audio_prompt_path or "").read_bytes()[:4] == b"RIFF"
            return [[0.0] * 2400]

    tts_mod.ChatterboxTTS = ChatterboxTTS  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "chatterbox", types.ModuleType("chatterbox"))
    monkeypatch.setitem(sys.modules, "chatterbox.tts", tts_mod)
    monkeypatch.setitem(sys.modules, "torch", fake_torch())
    path = write_catalog(tmp_path, entry(id="cb", kind="tts", adapter="chatterbox_tts", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    body = {"kind": "tts", "text": "Hello", "voice_reference": wav_b64(), "voice_reference_consent": True}
    _, job = post(api, "/generate/audio", body)
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert seen["existed"] is True
    assert not Path(seen["path"]).exists(), "reference recording removed after synthesis"
    assert done["metrics"]["voice_reference_used"] is True
    status, err = post(api, "/generate/audio", {"kind": "tts", "text": "Hello", "voice_reference": wav_b64()})
    assert status == 422 and "consent" in str(err)
    api.close()


# --- spandrel AI upscaler ---------------------------------------------------------------------

UPSCALE_CALLS: list[tuple[int, int]] = []


class FakeTensor:
    """Just enough of torch.Tensor for the adapter's data path; tracks the shape."""

    def __init__(self, shape: tuple[int, ...]) -> None:
        self.shape = shape
        self.dtype = "f32"

    def __getattr__(self, name: str) -> Any:
        if name in {"permute", "unsqueeze", "to", "float", "div", "half", "clamp", "mul", "round", "byte", "contiguous", "cpu"}:
            return lambda *a, **k: self
        raise AttributeError(name)

    def reshape(self, *shape: int) -> FakeTensor:
        return FakeTensor(tuple(shape))

    def squeeze(self, _dim: int) -> FakeTensor:
        return self

    def __getitem__(self, key: Any) -> FakeTensor:
        if isinstance(key, tuple) and len(key) == 4:
            ys, xs = key[2], key[3]
            return FakeTensor((1, 3, ys.stop - ys.start, xs.stop - xs.start))
        return self

    def __setitem__(self, key: Any, value: Any) -> None:
        pass

    def numpy(self) -> Any:
        _, _, h, w = self.shape
        return types.SimpleNamespace(tobytes=lambda: bytes(h * w * 3))


class FakeDescriptor:
    scale = 4
    purpose = "SR"
    supports_half = True

    def to(self, _device: str) -> FakeDescriptor:
        return self

    def eval(self) -> FakeDescriptor:
        return self

    def half(self) -> FakeDescriptor:
        return self

    def __call__(self, t: FakeTensor) -> FakeTensor:
        _, _, h, w = t.shape
        UPSCALE_CALLS.append((w, h))
        return FakeTensor((1, 3, h * 4, w * 4))


@pytest.fixture
def upscale_fakes(monkeypatch: pytest.MonkeyPatch) -> None:
    UPSCALE_CALLS.clear()
    torch = fake_torch()

    class InferenceMode:
        def __enter__(self) -> None: ...
        def __exit__(self, *a: Any) -> None: ...

    torch.uint8 = "u8"  # type: ignore[attr-defined]
    torch.inference_mode = InferenceMode  # type: ignore[attr-defined]
    torch.frombuffer = lambda buf, dtype: FakeTensor((len(buf),))  # type: ignore[attr-defined]
    torch.zeros = lambda shape, **kw: FakeTensor(tuple(shape))  # type: ignore[attr-defined]
    spandrel = types.ModuleType("spandrel")
    spandrel.ImageModelDescriptor = FakeDescriptor  # type: ignore[attr-defined]
    spandrel.ModelLoader = lambda: types.SimpleNamespace(load_from_file=lambda p: FakeDescriptor())  # type: ignore[attr-defined]
    pil = fake_pil()
    FakeImage.size = property(lambda self: (self.width, self.height))  # type: ignore[attr-defined]
    FakeImage.tobytes = lambda self: bytes(self.width * self.height * 3)  # type: ignore[attr-defined]
    pil["PIL.Image"].frombytes = lambda mode, size, data: FakeImage(*size)  # type: ignore[attr-defined]
    for name, mod in {"torch": torch, "spandrel": spandrel, **pil}.items():
        monkeypatch.setitem(sys.modules, name, mod)


def test_tile_plan_covers_every_pixel_exactly_once() -> None:
    plan = tile_plan(130, 70, 64, 8)
    covered = [[0] * 130 for _ in range(70)]
    for (y0, y1, x0, x1), (iy0, iy1, ix0, ix1) in plan:
        assert y0 <= iy0 and y1 >= iy1 and x0 <= ix0 and x1 >= ix1 and y0 >= 0 and x1 <= 130
        for y in range(iy0, iy1):
            for x in range(ix0, ix1):
                covered[y][x] += 1
    assert all(c == 1 for row in covered for c in row)
    assert len(plan) == 3 * 2


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_spandrel_upscaler_tiles_and_resizes_to_target(tmp_path: Path, upscale_fakes: None) -> None:
    weights = tmp_path / "RealESRGAN_x4plus.pth"
    weights.write_bytes(b"fake")
    params = {"weights_file": str(weights), "tile": 48, "tile_pad": 4}
    path = write_catalog(tmp_path, entry(id="esrgan", kind="upscale", adapter="spandrel_upscale", params=params))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/process/upscale", {"source": png_b64(64, 36), "target_width": 320, "target_height": 180})
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert UPSCALE_CALLS == [(52, 36), (20, 36)], "two padded tiles"
    data = api.jobs.output_path(job["id"], "upscaled.png").read_bytes()
    assert struct.unpack(">II", data[16:24]) == (320, 180)
    assert done["outputs"][0]["native_resolution"] is False
    api.close()


def test_spandrel_upscaler_needs_weights(tmp_path: Path, upscale_fakes: None) -> None:
    path = write_catalog(tmp_path, entry(id="esrgan", kind="upscale", adapter="spandrel_upscale", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    _, job = post(api, "/process/upscale", {"source": png_b64(64, 36)})
    done = wait(api, job["id"])
    assert done["error"]["code"] == "MODEL_LOAD_FAILED" and "weights_file" in done["error"]["message"]
    api.close()


# --- command lip sync -------------------------------------------------------------------------


FAKE_LIPSYNC = """
import shutil, sys
video, audio, out = sys.argv[1:4]
assert open(audio, "rb").read(4) == b"RIFF"
shutil.copyfile(video, out)
"""


def lipsync_api(tmp_path: Path, **params: Any) -> WorkerAPI:
    script = tmp_path / "fake_lipsync.py"
    script.write_text(FAKE_LIPSYNC)
    argv = [sys.executable, str(script), "{video}", "{audio}", "{output}"]
    path = write_catalog(
        tmp_path,
        entry(id="latentsync", kind="lipsync", adapter="command_lipsync", params={"argv": argv, "cwd": str(tmp_path), **params}),
        entry(id="broken", kind="lipsync", adapter="command_lipsync", default=False, params={"argv": ["python", "x.py"]}),
    )
    return WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_command_lipsync_runs_without_a_shell_and_normalises_output(tmp_path: Path) -> None:
    import os
    import shutil

    ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"
    clip = tmp_path / "clip.mp4"
    subprocess.run(
        [ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1", "-pix_fmt", "yuv420p", str(clip)],
        check=True,
    )
    audio = tmp_path / "line.wav"
    write_wav(audio, [0.0] * 8000, 8000)
    api = lipsync_api(tmp_path)
    skipped = {s["id"]: s["reason"] for s in api.catalog_skipped}
    assert "placeholders" in skipped["broken"]
    body = {"video": base64.b64encode(clip.read_bytes()).decode(), "audio": base64.b64encode(audio.read_bytes()).decode()}
    _, job = post(api, "/process/lipsync", body)
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    out = done["outputs"][0]
    assert (out["width"], out["height"], out["mock"]) == (320, 180, False)
    assert abs(out["duration_sec"] - 1.0) < 0.1
    names = {p.name for p in (tmp_path / "jobs" / job["id"]).iterdir()}
    assert "input.wav" not in names and "lipsync_raw.mp4" not in names, "intermediates removed"
    mock_clip = base64.b64encode(b'{"format": "ai-story-studio/mock-video"}').decode()
    _, job2 = post(api, "/process/lipsync", {"video": mock_clip, "audio": body["audio"]})
    assert wait(api, job2["id"])["error"]["code"] == "LIPSYNC_FAILED"
    api.close()


def test_command_lipsync_reports_a_missing_executable(tmp_path: Path) -> None:
    argv = ["/nonexistent/python", "infer.py", "{video}", "{audio}", "{output}"]
    path = write_catalog(tmp_path, entry(id="ls", kind="lipsync", adapter="command_lipsync", params={"argv": argv}))
    api = WorkerAPI(make_config(tmp_path, models_file=path, mock_models=False))
    mp4 = base64.b64encode(b"\x00\x00\x00\x18ftypmp42" + bytes(64)).decode()
    _, job = post(api, "/process/lipsync", {"video": mp4, "audio": wav_b64()})
    done = wait(api, job["id"])
    assert done["error"]["code"] == "MODEL_LOAD_FAILED" and "executable not found" in done["error"]["message"]
    api.close()


def test_default_benchmark_suite_has_music_and_sfx_sections() -> None:
    from ais_worker.benchmark import DEFAULT_SUITE, validate_suite

    validate_suite(DEFAULT_SUITE, 1 << 26)
    assert {c["key"] for c in DEFAULT_SUITE["sfx"]["cases"]} >= {"forest-ambience"}
    assert any(c["duration_sec"] > 47 for c in DEFAULT_SUITE["music"]["cases"]), "long bed exercises tiling"
