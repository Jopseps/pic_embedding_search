"""End-to-end tests against a real uvicorn process.

These exist because two behaviours cannot be tested in-process:

* the **stdout handshake** — one JSON line with `{port, token}` before serving,
  which is the entire contract with the Rust shell;
* the **parent watchdog** — the thing that stops an orphaned sidecar from
  holding 2 GB of VRAM after Tauri is `pkill -9`'d.

They also cover `/events`, which starlette's TestClient buffers.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SPAWN_TIMEOUT = 60.0


def read_handshake(proc: subprocess.Popen, timeout: float = SPAWN_TIMEOUT) -> dict:
    """Exactly what src-tauri/src/sidecar.rs will do: read one line, parse it."""
    deadline = time.monotonic() + timeout
    while(time.monotonic() < deadline):
        line = proc.stdout.readline()
        if(line):
            return json.loads(line)
        if(proc.poll() is not None):
            raise RuntimeError(f"sidecar exited early: {proc.stderr.read()}")
        time.sleep(0.05)
    raise TimeoutError("no handshake line on stdout")


def get(url: str, token: str | None = None, timeout: float = 10.0):
    req = urllib.request.Request(url)
    if(token is not None):
        req.add_header("X-PicSearch-Token", token)
    return urllib.request.urlopen(req, timeout=timeout)


@pytest.fixture()
def sidecar(tmp_path):
    env = {
        **os.environ,
        "PICSEARCH_DATA_DIR": str(tmp_path / "data"),
        "PICSEARCH_CONFIG_DIR": str(tmp_path / "config"),
        "PICSEARCH_CACHE_DIR": str(tmp_path / "cache"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "picsearch.server", "--port", "0", "--log-level", "warning"],
        cwd=str(Path(__file__).resolve().parents[1]),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        handshake = read_handshake(proc)
        yield proc, handshake
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_handshake_is_one_json_line_with_a_port_and_token(sidecar):
    _proc, hs = sidecar
    assert set(hs) == {"port", "token"}
    assert isinstance(hs["port"], int) and hs["port"] > 0
    assert len(hs["token"]) >= 32


def test_the_port_is_ephemeral_and_bound_to_loopback(sidecar):
    _proc, hs = sidecar
    with socket.create_connection(("127.0.0.1", hs["port"]), timeout=5) as s:
        assert s.getpeername()[0] == "127.0.0.1"


def test_health_requires_the_token_over_real_http(sidecar):
    _proc, hs = sidecar
    base = f"http://127.0.0.1:{hs['port']}"

    with pytest.raises(urllib.error.HTTPError) as err:
        get(f"{base}/health")
    assert err.value.code == 401

    body = json.load(get(f"{base}/health", hs["token"]))
    assert body["ok"] is True
    assert body["images"] == 0


def test_search_over_real_http(sidecar):
    _proc, hs = sidecar
    base = f"http://127.0.0.1:{hs['port']}"
    body = json.load(get(f"{base}/search?q=&limit=5", hs["token"]))
    assert body == {"items": [], "total": 0, "tookMs": body["tookMs"], "cursor": None}


def test_events_streams_a_snapshot(sidecar):
    _proc, hs = sidecar
    base = f"http://127.0.0.1:{hs['port']}"
    res = get(f"{base}/events", hs["token"], timeout=15.0)
    assert res.headers["content-type"].startswith("text/event-stream")

    line = res.readline().decode()
    assert line.startswith("data: ")
    payload = json.loads(line[len("data: "):])
    assert payload["type"] == "index"
    assert payload["running"] is False
    res.close()


PARENT_SCRIPT = """
import json, subprocess, sys, time
proc = subprocess.Popen(
    [sys.executable, "-m", "picsearch.server", "--port", "0", "--log-level", "warning"],
    stdout=subprocess.PIPE, text=True,
)
line = proc.stdout.readline()
print(json.dumps({"child": proc.pid, "handshake": json.loads(line)}), flush=True)
time.sleep(600)
"""


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def test_the_sidecar_dies_with_its_parent(tmp_path):
    """`pkill -9` on the shell must not leave a process holding VRAM.

    Rust also kills the child on window-destroy and on panic; this is the half
    that survives a parent that never got to run any cleanup at all.
    """
    env = {
        **os.environ,
        "PICSEARCH_DATA_DIR": str(tmp_path / "data"),
        "PICSEARCH_CONFIG_DIR": str(tmp_path / "config"),
        "PICSEARCH_CACHE_DIR": str(tmp_path / "cache"),
    }
    parent = subprocess.Popen(
        [sys.executable, "-c", PARENT_SCRIPT],
        cwd=str(Path(__file__).resolve().parents[1]),
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        info = json.loads(parent.stdout.readline())
        child_pid = info["child"]
        assert alive(child_pid)

        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=10)

        deadline = time.monotonic() + 15.0
        while(time.monotonic() < deadline and alive(child_pid)):
            time.sleep(0.2)
        assert not alive(child_pid), "orphaned sidecar survived its parent"
    finally:
        if(parent.poll() is None):
            parent.kill()
