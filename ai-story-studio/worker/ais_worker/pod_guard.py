"""Pod-side dead-man switch for cloud GPUs (Phase 5).

The Windows app is the primary authority: it terminates the GPU when work is
done, on idle timeout, at the maximum lifetime, on budget, on Stop GPU and on
emergency stop. This guard is the BACKUP for when that PC is off, asleep or the
app crashed: if no authenticated request arrives for ``AIS_POD_IDLE_MIN``
minutes, or the pod has lived ``AIS_POD_MAX_LIFETIME_MIN`` minutes, the worker
asks RunPod to terminate its own pod.

It uses ``RUNPOD_POD_ID`` and the pod-scoped ``RUNPOD_API_KEY`` that RunPod
injects into every pod. The studio never sends its own account key to the
pod. If those variables are missing, the guard only logs a warning.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

log = logging.getLogger("ais_worker.pod_guard")

Opener = Callable[..., Any]


class PodGuard:
    def __init__(
        self,
        *,
        max_lifetime_min: float | None,
        idle_min: float | None,
        pod_id: str | None,
        api_key: str | None,
        api_base: str = "https://api.runpod.io/v2",
        clock: Callable[[], float] = time.monotonic,
        opener: Opener = urllib.request.urlopen,
    ) -> None:
        self.max_lifetime_s = max_lifetime_min * 60 if max_lifetime_min else None
        self.idle_s = idle_min * 60 if idle_min else None
        self.pod_id = pod_id
        self.api_key = api_key
        self.api_base = api_base.rstrip("/")
        self.clock = clock
        self.opener = opener
        self.started = clock()
        self.last_activity = self.started
        self.terminated = False
        self._stop = threading.Event()

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> PodGuard | None:
        def minutes(name: str) -> float | None:
            try:
                v = float(env.get(name, "") or 0)
            except ValueError:
                return None
            return v if v > 0 else None

        life, idle = minutes("AIS_POD_MAX_LIFETIME_MIN"), minutes("AIS_POD_IDLE_MIN")
        if life is None and idle is None:
            return None  # not a studio cloud pod (local worker): no guard
        guard = cls(
            max_lifetime_min=life,
            idle_min=idle,
            pod_id=env.get("RUNPOD_POD_ID") or None,
            api_key=env.get("RUNPOD_API_KEY") or None,
        )
        if not guard.pod_id or not guard.api_key:
            log.warning(
                "pod guard: RUNPOD_POD_ID / RUNPOD_API_KEY not present; self-termination unavailable (the app's timers still apply)"
            )
        return guard

    def touch(self) -> None:
        """Record authenticated activity from the studio."""
        self.last_activity = self.clock()

    def reason(self) -> str | None:
        now = self.clock()
        if self.max_lifetime_s is not None and now - self.started >= self.max_lifetime_s:
            return "max_lifetime"
        if self.idle_s is not None and now - self.last_activity >= self.idle_s:
            return "idle"
        return None

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> int:
        if not self.api_base.startswith("https://") and not self.api_base.startswith("http://127.0.0.1"):
            raise OSError("pod guard only talks to an https API")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(  # noqa: S310 - scheme checked above
            self.api_base + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with self.opener(req, timeout=20) as res:
                return int(res.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)

    def terminate(self, reason: str) -> bool:
        """Ask RunPod to terminate this pod. Returns True when it is gone."""
        if not self.pod_id or not self.api_key:
            log.error("pod guard wants to terminate (%s) but has no pod credentials", reason)
            return False
        log.warning("pod guard: terminating pod %s (%s)", self.pod_id, reason)
        try:
            status = self._request("DELETE", f"/pods/{self.pod_id}")
            if status in (200, 202, 204, 404):
                self.terminated = True
                return True
            status = self._request("POST", f"/pods/{self.pod_id}/action", {"action": "terminate"})
            self.terminated = status in (200, 202, 204, 404)
            if not self.terminated:
                log.error("pod guard: RunPod refused termination (HTTP %s)", status)
            return self.terminated
        except OSError as exc:
            log.error("pod guard: RunPod unreachable (%s)", exc)
            return False

    def check(self) -> bool:
        """One tick: terminate when a limit is reached. Returns True when termination succeeded."""
        if self.terminated:
            return True
        why = self.reason()
        return self.terminate(why) if why else False

    def start(self, interval_s: float = 30) -> threading.Thread:
        def loop() -> None:
            while not self._stop.wait(interval_s):
                if self.check():
                    return

        t = threading.Thread(target=loop, name="pod-guard", daemon=True)
        t.start()
        return t

    def stop(self) -> None:
        self._stop.set()
