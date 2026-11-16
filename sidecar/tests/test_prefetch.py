"""`picsearch.prefetch` must not outlive the app that started it.

A first run killed mid-download otherwise leaves a python fetching 1.5 GB with
nobody to read it. The watchdog itself is `system.start_parent_watchdog`, the
same one the server uses.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

from picsearch import config, ocr, prefetch, system

SIDECAR = Path(__file__).resolve().parent.parent


@pytest.fixture
def stubbed(monkeypatch):
    calls: list[int] = []
    watchdog = lambda pid=None, interval=1.0: calls.append(pid)  # noqa: E731
    monkeypatch.setattr(system, "start_parent_watchdog", watchdog)
    monkeypatch.setattr(prefetch, "fetch", lambda model_id: None)
    monkeypatch.setattr(config, "load", lambda: {})
    monkeypatch.setattr(ocr, "install_hint", lambda *a, **k: None)
    return calls


def test_parent_pid_starts_the_watchdog(stubbed):
    assert prefetch.main(["--parent-pid", "4242"]) == 0
    assert stubbed == [4242]


def test_no_parent_pid_means_no_watchdog(stubbed):
    assert prefetch.main([]) == 0
    assert stubbed == []


@pytest.mark.skipif(sys.platform == "win32", reason="uses sleep as the watched process")
def test_the_watchdog_ends_a_process_whose_parent_died():
    watched = subprocess.Popen(["sleep", "60"])
    code = (
        "import time; from picsearch import system;"
        f"system.start_parent_watchdog({watched.pid}, 0.1); time.sleep(60)"
    )
    child = subprocess.Popen([sys.executable, "-c", code], cwd=SIDECAR)
    try:
        time.sleep(0.5)
        assert child.poll() is None, "it exited while the watched process was alive"
        watched.kill()
        watched.wait()
        assert child.wait(timeout=10) == 0
    finally:
        for proc in (watched, child):
            if(proc.poll() is None):
                proc.kill()
