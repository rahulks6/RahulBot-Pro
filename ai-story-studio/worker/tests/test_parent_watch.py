from __future__ import annotations

import os
import subprocess
import sys
import threading

from ais_worker.parent_watch import process_alive, watch_parent


def test_process_alive() -> None:
    assert process_alive(os.getpid())
    assert not process_alive(0)
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert not process_alive(child.pid)


def test_watch_parent_fires_when_the_parent_exits() -> None:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.3)"])
    gone = threading.Event()
    watch_parent(child.pid, gone.set, interval_s=0.05)
    child.wait()
    assert gone.wait(3), "on_gone was called after the parent exited"
