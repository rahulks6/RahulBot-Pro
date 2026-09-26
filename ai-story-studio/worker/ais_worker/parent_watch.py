"""Stop the worker when the app that started it is gone (a crashed app must not leave the GPU busy)."""

from __future__ import annotations

import logging
import os
import sys
import threading
from collections.abc import Callable

log = logging.getLogger("ais_worker.parent")


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined,unused-ignore]
        handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            return bool(kernel32.WaitForSingleObject(handle, 0) == 0x102)  # WAIT_TIMEOUT = still running
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)  # signal 0 only checks existence (POSIX)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(pid: int, on_gone: Callable[[], None], interval_s: float = 5.0) -> threading.Thread:
    """Poll ``pid``; call ``on_gone`` once when it has exited."""
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(interval_s):
            if not process_alive(pid):
                log.warning("the app (pid %s) has exited; stopping the worker", pid)
                on_gone()
                return

    thread = threading.Thread(target=loop, name="parent-watch", daemon=True)
    thread.start()
    return thread
