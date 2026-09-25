from __future__ import annotations

import json
import time
from pathlib import Path

from ais_worker.api import WorkerAPI
from ais_worker.jobs import JobContext, JobError, JobManager

from .conftest import AUTH, make_config, post, wait


def test_image_job_completes_with_verified_output(api: WorkerAPI) -> None:
    status, job = post(
        api, "/generate/image", {"prompt": "a lighthouse", "seed": 3, "width": 256, "height": 144, "quality": "high_quality"}
    )
    assert status == 202
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    out = done["outputs"][0]
    assert out["name"] == "image.png" and out["mock"] is True and out["width"] == 256
    res = api.handle("GET", f"/jobs/{job['id']}/files/image.png", AUTH, b"")
    assert res.status == 200 and res.file is not None
    import hashlib

    assert hashlib.sha256(res.file.read_bytes()).hexdigest() == out["sha256"]
    assert done["model"]["mock"] is True
    assert "run_seconds" in done["metrics"]


def test_cancel_running_and_queued_jobs(api: WorkerAPI) -> None:
    _, running = post(api, "/generate/image", {"prompt": "slow", "settings": {"mock_delay_sec": 30}})
    _, queued = post(api, "/generate/image", {"prompt": "queued"})
    time.sleep(0.2)
    assert api.handle("POST", f"/jobs/{queued['id']}/cancel", AUTH, b"").status == 200
    assert api.jobs.get(queued["id"]).status == "cancelled"
    api.handle("POST", f"/jobs/{running['id']}/cancel", AUTH, b"")
    started = time.monotonic()
    done = wait(api, running["id"], timeout=5)
    assert done["status"] == "cancelled"
    assert time.monotonic() - started < 2, "cancellation must be prompt"


def test_failures_carry_error_codes_and_do_not_kill_the_worker(api: WorkerAPI) -> None:
    _, j = post(api, "/generate/image", {"prompt": "x", "settings": {"mock_fail": "OUT_OF_MEMORY"}})
    assert wait(api, j["id"])["error"]["code"] == "OUT_OF_MEMORY"
    _, j2 = post(api, "/generate/image", {"prompt": "still works"})
    assert wait(api, j2["id"])["status"] == "complete"


def test_crashing_runner_becomes_internal_error(tmp_path: Path) -> None:
    jm = JobManager(tmp_path / "jobs")

    def boom(ctx: JobContext) -> None:
        raise RuntimeError("token=sk-live-abcdefghijklmnopq exploded")

    job = jm.submit("test", {}, boom)
    for _ in range(100):
        if jm.get(job.id).status == "failed":
            break
        time.sleep(0.02)
    err = jm.get(job.id).error or {}
    assert err["code"] == "INTERNAL"
    assert "abcdefghijklmnopq" not in err["message"]
    jm.shutdown()


def test_timeout(tmp_path: Path) -> None:
    jm = JobManager(tmp_path / "jobs", timeout_seconds=1)

    def slow(ctx: JobContext) -> None:
        ctx.sleep(10)

    job = jm.submit("test", {}, slow)
    for _ in range(200):
        if jm.get(job.id).status == "failed":
            break
        time.sleep(0.02)
    assert (jm.get(job.id).error or {})["code"] == "API_TIMEOUT"
    jm.shutdown()


def test_restart_marks_interrupted_jobs_failed_and_keeps_results(tmp_path: Path) -> None:
    jobs = tmp_path / "jobs"
    jm = JobManager(jobs)
    done = jm.submit("test", {}, lambda ctx: None)
    for _ in range(100):
        if jm.get(done.id).status == "complete":
            break
        time.sleep(0.02)
    jm.shutdown()
    # Simulate a crash mid-job.
    crashed = jobs / "job_00000000000000aa"
    crashed.mkdir()
    (crashed / "job.json").write_text(json.dumps({"id": "job_00000000000000aa", "kind": "image", "status": "running"}))
    jm2 = JobManager(jobs)
    assert jm2.get(done.id).status == "complete"
    assert (jm2.get("job_00000000000000aa").error or {})["code"] == "WORKER_UNAVAILABLE"
    jm2.shutdown()


def test_old_jobs_are_pruned(tmp_path: Path) -> None:
    api = WorkerAPI(make_config(tmp_path, max_jobs_kept=3))
    ids = []
    for i in range(5):
        _, j = post(api, "/generate/image", {"prompt": f"p{i}", "width": 64, "height": 64})
        wait(api, j["id"])
        ids.append(j["id"])
    assert len(api.jobs.list()) <= 4
    assert not (tmp_path / "jobs" / ids[0]).exists()
    api.close()


def test_job_error_type() -> None:
    e = JobError("CUDA_FAILURE", "device lost")
    assert e.code == "CUDA_FAILURE"
