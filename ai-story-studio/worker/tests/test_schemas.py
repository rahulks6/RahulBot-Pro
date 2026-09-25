from __future__ import annotations

import base64

import pytest

from ais_worker.schemas import ValidationError, parse_audio, parse_image, parse_video, sniff

from .conftest import png_b64

MB = 1024 * 1024


def test_image_request_defaults_and_limits() -> None:
    req = parse_image({"prompt": "a fox", "seed": 7}, MB)
    assert (req.width, req.height, req.quality) == (1024, 576, "optimized")
    with pytest.raises(ValidationError) as e:
        parse_image({"prompt": "", "seed": -1, "width": 99999, "quality": "ultra", "surprise": 1}, MB)
    paths = {err["path"] for err in e.value.errors}
    assert paths == {"prompt", "seed", "width", "quality", "surprise"}


def test_video_request_checks_file_type_fps_and_even_dimensions() -> None:
    ok = parse_video({"image": png_b64(), "duration_sec": 2, "fps": 30, "width": 320, "height": 180}, MB)
    assert ok.fps == 30
    with pytest.raises(ValidationError) as e:
        parse_video({"image": base64.b64encode(b"MZ\x90\x00 not an image").decode(), "fps": 25, "width": 321}, MB)
    paths = {err["path"] for err in e.value.errors}
    assert {"image", "fps", "width"} <= paths
    with pytest.raises(ValidationError):
        parse_video({"image": "@@@not-base64@@@"}, MB)


def test_file_size_limit() -> None:
    big = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * (2 * MB)).decode()
    with pytest.raises(ValidationError) as e:
        parse_video({"image": big}, MB)
    assert "larger than" in e.value.errors[0]["message"]


def test_audio_request_requires_text_for_tts_and_tag_for_sfx() -> None:
    with pytest.raises(ValidationError):
        parse_audio({"kind": "tts"}, MB)
    with pytest.raises(ValidationError):
        parse_audio({"kind": "sfx"}, MB)
    amb = parse_audio({"kind": "ambience", "tag": "rain"}, MB)
    assert amb.loopable is True
    with pytest.raises(ValidationError):
        parse_audio({"kind": "tts", "text": "hi", "emotion": "furious"}, MB)


def test_sniff() -> None:
    assert sniff(base64.b64decode(png_b64())) == "png"
    assert sniff(b"RIFF\x00\x00\x00\x00WAVEfmt ") == "wav"
    assert sniff(b"\x00\x00\x00\x18ftypmp42") == "mp4"
    assert sniff(b"#!/bin/sh") is None
