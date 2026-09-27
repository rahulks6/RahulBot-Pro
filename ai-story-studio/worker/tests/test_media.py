from __future__ import annotations

import base64
import json
import time

import pytest

from ais_worker.api import WorkerAPI

from .conftest import AUTH, has_ffmpeg, png_b64, post, wait

needs_ffmpeg = pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg/FFprobe not installed")


@needs_ffmpeg
def test_image_to_video_renders_a_real_h264_mp4(api: WorkerAPI) -> None:
    _, j = post(
        api,
        "/generate/image-to-video",
        {"image": png_b64(128, 72), "duration_sec": 1, "fps": 24, "width": 320, "height": 180, "quality": "high_quality"},
    )
    done = wait(api, j["id"])
    assert done["status"] == "complete", done
    out = done["outputs"][0]
    assert out["mime"] == "video/mp4" and out["mock"] is True
    assert (out["width"], out["height"]) == (320, 180)
    assert out["native_resolution"] is True
    path = api.jobs.output_path(j["id"], "clip.mp4")
    probe = api.media.probe_file(path)
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert video["codec_name"] == "h264"
    assert abs(float(probe["format"]["duration"]) - 1.0) < 0.2


@needs_ffmpeg
def test_optimized_clip_is_upscaled_without_touching_the_original(api: WorkerAPI) -> None:
    _, j = post(
        api, "/generate/image-to-video", {"image": png_b64(), "duration_sec": 1, "width": 320, "height": 180, "quality": "optimized"}
    )
    done = wait(api, j["id"])
    assert (done["outputs"][0]["width"], done["outputs"][0]["native_resolution"]) == (160, False)
    clip = api.jobs.output_path(j["id"], "clip.mp4").read_bytes()
    _, u = post(api, "/process/upscale", {"source": base64.b64encode(clip).decode(), "target_width": 320, "target_height": 180})
    up = wait(api, u["id"])
    assert up["status"] == "complete", up
    assert (up["outputs"][0]["width"], up["outputs"][0]["native_resolution"]) == (320, False)
    assert api.jobs.output_path(j["id"], "clip.mp4").read_bytes() == clip


@needs_ffmpeg
def test_lipsync_keeps_original_and_tags_output(api: WorkerAPI) -> None:
    _, j = post(
        api, "/generate/image-to-video", {"image": png_b64(), "duration_sec": 1, "width": 160, "height": 90, "quality": "high_quality"}
    )
    wait(api, j["id"])
    clip = api.jobs.output_path(j["id"], "clip.mp4").read_bytes()
    _, a = post(api, "/generate/audio", {"kind": "tts", "text": "Hello there"})
    wait(api, a["id"])
    wav = api.jobs.output_path(a["id"], "audio.wav").read_bytes()
    _, ls = post(api, "/process/lipsync", {"video": base64.b64encode(clip).decode(), "audio": base64.b64encode(wav).decode()})
    done = wait(api, ls["id"])
    assert done["status"] == "complete", done
    probe = api.media.probe_file(api.jobs.output_path(ls["id"], "lipsync.mp4"))
    assert "MOCK lip sync" in probe["format"]["tags"]["comment"]


@needs_ffmpeg
def test_cancelling_kills_ffmpeg_promptly(api: WorkerAPI) -> None:
    _, j = post(
        api,
        "/generate/image-to-video",
        {"image": png_b64(), "duration_sec": 60, "fps": 30, "width": 1920, "height": 1080, "quality": "high_quality"},
    )
    for _ in range(200):
        if api.jobs.get(j["id"]).status == "running":
            break
        time.sleep(0.02)
    time.sleep(0.3)
    api.handle("POST", f"/jobs/{j['id']}/cancel", AUTH, b"")
    started = time.monotonic()
    assert wait(api, j["id"], timeout=10)["status"] == "cancelled"
    assert time.monotonic() - started < 3


def test_without_ffmpeg_the_mock_video_falls_back_to_a_manifest(api_no_ffmpeg: WorkerAPI) -> None:
    _, j = post(api_no_ffmpeg, "/generate/image-to-video", {"image": png_b64(), "duration_sec": 2, "width": 320, "height": 180})
    done = wait(api_no_ffmpeg, j["id"])
    assert done["outputs"][0]["mime"] == "application/vnd.ai-story-studio.mock-video+json"
    manifest = json.loads(api_no_ffmpeg.jobs.output_path(j["id"], "clip.json").read_text())
    assert manifest["frames"] == 48
    sysinfo = api_no_ffmpeg.system()
    assert sysinfo["ffmpeg"] == {"ffmpeg": None, "ffprobe": None}
