"""Job processing: queue, execution, cancellation, timeouts and results.

Jobs run on a small thread pool (default: one at a time, since one GPU runs
one model well). Every state change is persisted to ``jobs/<id>/job.json`` so
results survive a worker restart; jobs that were running when the worker
stopped are marked failed on start-up. Outputs are written only inside the
job's own directory. Cancellation is cooperative for Python code and forced
for subprocesses (FFmpeg is killed).
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .security import SecurityError, redact, safe_child, validate_job_id

log = logging.getLogger("ais_worker.jobs")

TERMINAL = {"complete", "failed", "cancelled"}


class JobCancelledError(Exception):
    """Raised inside a job when cancellation was requested."""


class JobError(Exception):
    """A failure with a stable error code (e.g. OUT_OF_MEMORY, MODEL_LOAD_FAILED)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class OutputFile:
    name: str
    mime: str
    size: int
    sha256: str
    width: int | None = None
    height: int | None = None
    duration_sec: float | None = None
    fps: float | None = None
    native_resolution: bool = True
    mock: bool = False


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    progress: float = 0.0
    message: str = ""
    model: dict[str, Any] = field(default_factory=dict)
    request: dict[str, Any] = field(default_factory=dict)
    outputs: list[OutputFile] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)
    error: dict[str, str] | None = None
    logs: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data["logs"] = data["logs"][-50:]
        return data


class JobContext:
    """Handed to model code: job directory, logging, progress, cancellation and safe subprocesses."""

    def __init__(self, job: Job, directory: Path, cancel: threading.Event, deadline: float, save: Callable[[Job], None]) -> None:
        self.job = job
        self.dir = directory
        self._cancel = cancel
        self._deadline = deadline
        self._save = save

    def child(self, job: Job, directory: Path) -> JobContext:
        """Context for a sub-run (benchmarks): same cancellation and deadline, not persisted as a job."""
        directory.mkdir(parents=True, exist_ok=True)
        return JobContext(job, directory, self._cancel, self._deadline, lambda _job: None)

    def check(self) -> None:
        if self._cancel.is_set():
            raise JobCancelledError()
        if time.monotonic() > self._deadline:
            raise JobError("API_TIMEOUT", "job exceeded the worker timeout")

    def log(self, message: str) -> None:
        self.job.logs.append(f"{time.strftime('%H:%M:%S')} {redact(message)}")
        self._save(self.job)

    def set_status(self, status: str, message: str = "") -> None:
        self.job.status = status
        if message:
            self.job.message = message
        self._save(self.job)

    def progress(self, value: float) -> None:
        self.job.progress = max(0.0, min(1.0, value))
        self._save(self.job)

    def sleep(self, seconds: float) -> None:
        """Interruptible sleep (used by mock models to simulate work)."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.check()
            time.sleep(min(0.05, max(0.0, end - time.monotonic())))

    def path(self, name: str) -> Path:
        return safe_child(self.dir, name)

    def run(
        self, args: list[str], timeout: float = 600, *, cwd: Path | None = None, error_code: str = "FFMPEG_FAILED"
    ) -> subprocess.CompletedProcess[bytes]:
        """Run a subprocess WITHOUT a shell; killed on cancellation or timeout."""
        self.check()
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd or self.dir)
        end = time.monotonic() + timeout
        try:
            while proc.poll() is None:
                if self._cancel.is_set():
                    proc.kill()
                    raise JobCancelledError()
                if time.monotonic() > min(end, self._deadline):
                    proc.kill()
                    raise JobError("API_TIMEOUT", f"{Path(args[0]).name} timed out")
                time.sleep(0.05)
            out, err = proc.communicate()
        finally:
            if proc.poll() is None:
                proc.kill()
        if proc.returncode != 0:
            tail = err.decode(errors="replace")[-400:]
            raise JobError(error_code, f"{Path(args[0]).name} exited with {proc.returncode}: {tail}")
        return subprocess.CompletedProcess(args, proc.returncode, out, err)

    def add_output(self, name: str, mime: str, **meta: Any) -> OutputFile:
        path = self.path(name)
        data = path.read_bytes()
        out = OutputFile(name=name, mime=mime, size=len(data), sha256=hashlib.sha256(data).hexdigest(), **meta)
        self.job.outputs.append(out)
        self._save(self.job)
        return out


Runner = Callable[[JobContext], None]


class JobManager:
    def __init__(self, jobs_dir: Path, max_workers: int = 1, timeout_seconds: int = 1800, max_jobs_kept: int = 500) -> None:
        self.dir = jobs_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.timeout_seconds = timeout_seconds
        self.max_jobs_kept = max_jobs_kept
        self._jobs: dict[str, Job] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self._recover()

    # --- persistence -------------------------------------------------------------

    def _job_dir(self, job_id: str) -> Path:
        return safe_child(self.dir, job_id)

    def save(self, job: Job) -> None:
        with self._lock:
            d = self._job_dir(job.id)
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / "job.json.tmp"
            tmp.write_text(json.dumps(job.public(), indent=2))
            tmp.replace(d / "job.json")

    def _recover(self) -> None:
        for path in sorted(self.dir.glob("job_*/job.json")):
            try:
                data = json.loads(path.read_text())
                outputs = [OutputFile(**o) for o in data.pop("outputs", [])]
                job = Job(**data, outputs=outputs)
            except (ValueError, TypeError) as exc:
                log.warning("skipping unreadable job record %s: %s", path, exc)
                continue
            if job.status not in TERMINAL:
                job.status = "failed"
                job.error = {"code": "WORKER_UNAVAILABLE", "message": "worker restarted while the job was running"}
                job.finished_at = time.time()
                self.save(job)
            self._jobs[job.id] = job

    # --- API ---------------------------------------------------------------------

    def submit(self, kind: str, request_summary: dict[str, Any], runner: Runner) -> Job:
        job = Job(id=f"job_{secrets.token_hex(8)}", kind=kind, request=redact(request_summary))
        with self._lock:
            self._jobs[job.id] = job
            self._cancel[job.id] = threading.Event()
            self.save(job)
            self._prune()
        self._pool.submit(self._execute, job, runner)
        log.info("job queued", extra={"job": job.id, "kind": kind})
        return job

    def get(self, job_id: str) -> Job:
        validate_job_id(job_id)
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise SecurityError(404, "unknown job")
        return job

    def list(self, limit: int = 50) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        with self._lock:
            if job.status in TERMINAL:
                return job
            event = self._cancel.get(job_id)
            if event:
                event.set()
            if job.status == "queued":
                self._finish(job, "cancelled", None)
        return job

    def output_path(self, job_id: str, name: str) -> Path:
        job = self.get(job_id)
        if not any(o.name == name for o in job.outputs):
            raise SecurityError(404, "unknown output")
        return safe_child(self.dir, job_id, name)

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        with self._lock:
            for j in self._jobs.values():
                out[j.status] = out.get(j.status, 0) + 1
        return out

    def shutdown(self) -> None:
        with self._lock:
            for event in self._cancel.values():
                event.set()
        self._pool.shutdown(wait=True, cancel_futures=True)

    # --- execution ---------------------------------------------------------------

    def _finish(self, job: Job, status: str, error: dict[str, str] | None) -> None:
        job.status = status
        job.error = error
        job.finished_at = time.time()
        if job.started_at:
            job.metrics["total_seconds"] = round(job.finished_at - job.started_at, 3)
        self.save(job)

    def _execute(self, job: Job, runner: Runner) -> None:
        event = self._cancel[job.id]
        if event.is_set() or job.status == "cancelled":
            if job.status != "cancelled":
                self._finish(job, "cancelled", None)
            return
        job.started_at = time.time()
        job.status = "running"
        self.save(job)
        ctx = JobContext(job, self._job_dir(job.id), event, time.monotonic() + self.timeout_seconds, self.save)
        try:
            runner(ctx)
            self._finish(job, "complete", None)
            log.info("job complete", extra={"job": job.id})
        except JobCancelledError:
            self._finish(job, "cancelled", {"code": "CANCELLED", "message": "cancelled"})
        except JobError as exc:
            self._finish(job, "failed", {"code": exc.code, "message": str(redact(str(exc)))})
        except MemoryError:
            self._finish(job, "failed", {"code": "OUT_OF_MEMORY", "message": "out of memory"})
        except Exception as exc:
            log.exception("job crashed", extra={"job": job.id})
            self._finish(job, "failed", {"code": "INTERNAL", "message": str(redact(f"{type(exc).__name__}: {exc}"))})
        finally:
            with self._lock:
                self._cancel.pop(job.id, None)

    def _prune(self) -> None:
        done = [j for j in sorted(self._jobs.values(), key=lambda j: j.created_at) if j.status in TERMINAL]
        excess = len(self._jobs) - self.max_jobs_kept
        for job in done[: max(0, excess)]:
            shutil.rmtree(self._job_dir(job.id), ignore_errors=True)
            del self._jobs[job.id]
