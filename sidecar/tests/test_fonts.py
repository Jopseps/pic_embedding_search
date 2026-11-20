"""The font Install button: download, checksum, ownership, remove, and the
Windows registry layer with a fake winreg."""

from __future__ import annotations

import ctypes
import hashlib
import sys
import time
import types

import pytest
from fastapi.testclient import TestClient
from test_search import MODEL, ColorEmbedder

from picsearch import fonts, system
from picsearch.server import TOKEN_HEADER, AppState, create_app

DATA = b"not really a font, but bytes with a known hash" * 2000


@pytest.fixture()
def fake_font(monkeypatch):
    """One registry entry whose bytes the test serves from memory."""
    digest = hashlib.sha256(DATA).hexdigest()
    entry = fonts.FontFile("Test[wght].ttf", "test/Test.ttf", digest, len(DATA))
    monkeypatch.setattr(fonts, "REGISTRY", {"test-mono": [entry]})
    monkeypatch.setattr(
        fonts, "fetch", lambda url: (DATA[i:i + 1000] for i in range(0, len(DATA), 1000))
    )
    return entry


def test_install_lands_a_prefixed_file_and_reports_progress(fake_font):
    seen = []
    fonts.install("test-mono", progress=seen.append)
    path = system.user_fonts_dir() / "PicSearch-Test[wght].ttf"
    assert path.read_bytes() == DATA
    assert seen[-1] == len(DATA) and seen == sorted(seen)
    assert fonts.status() == [{"id": "test-mono", "installed": True, "sizeBytes": len(DATA)}]


def test_a_checksum_mismatch_leaves_nothing_behind(fake_font, monkeypatch):
    monkeypatch.setattr(fonts, "fetch", lambda url: iter([b"x" * len(DATA)]))
    with pytest.raises(ValueError):
        fonts.install("test-mono")
    assert list(system.user_fonts_dir().iterdir()) == []
    assert fonts.installed("test-mono") is False


def test_an_oversized_download_is_refused(fake_font, monkeypatch):
    monkeypatch.setattr(fonts, "fetch", lambda url: iter([DATA, b"extra"]))
    with pytest.raises(ValueError):
        fonts.install("test-mono")
    assert list(system.user_fonts_dir().iterdir()) == []


def test_a_failed_registration_leaves_no_files(fake_font, monkeypatch):
    def fail(files):
        raise OSError("registry refused")

    monkeypatch.setattr(system, "register_fonts", fail)
    with pytest.raises(OSError):
        fonts.install("test-mono")
    assert fonts.installed("test-mono") is False
    assert list(system.user_fonts_dir().iterdir()) == []


def test_remove_deletes_only_our_own_files(fake_font):
    folder = system.user_fonts_dir()
    folder.mkdir(parents=True)
    # What the user installed themselves under the same name: never ours.
    (folder / "Test[wght].ttf").write_bytes(b"theirs")
    assert fonts.installed("test-mono") is False
    fonts.install("test-mono")
    fonts.remove("test-mono")
    assert sorted(p.name for p in folder.iterdir()) == ["Test[wght].ttf"]


def test_windows_registers_and_unregisters_in_hkcu(monkeypatch, tmp_path):
    values: dict[str, str] = {}
    calls: list[tuple[str, str]] = []

    class Key:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def delete_value(key, name):
        if(name not in values):
            raise FileNotFoundError(name)
        del values[name]

    winreg = types.SimpleNamespace(
        HKEY_CURRENT_USER="HKCU", KEY_SET_VALUE=2,
        CreateKeyEx=lambda root, sub, res, access: Key(),
        SetValueEx=lambda key, name, res, kind, value: values.__setitem__(name, value),
        DeleteValue=delete_value, REG_SZ=1,
    )
    windll = types.SimpleNamespace(
        gdi32=types.SimpleNamespace(
            AddFontResourceW=lambda p: calls.append(("add", p)),
            RemoveFontResourceW=lambda p: calls.append(("remove", p)),
        ),
        user32=types.SimpleNamespace(
            SendMessageTimeoutW=lambda *a: calls.append(("broadcast", ""))
        ),
    )
    monkeypatch.setitem(sys.modules, "winreg", winreg)
    monkeypatch.setattr(ctypes, "windll", windll, raising=False)

    font = tmp_path / "PicSearch-Test[wght].ttf"
    system._windows_fonts([font], add=True)
    assert values == {"PicSearch-Test[wght] (TrueType)": str(font)}
    system._windows_fonts([font], add=False)
    system._windows_fonts([font], add=False)  # already gone: not an error
    assert values == {}
    assert ("add", str(font)) in calls and ("remove", str(font)) in calls


# -- HTTP ------------------------------------------------------------------

@pytest.fixture()
def api(xdg_tmp):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
    return TestClient(create_app(state), headers={TOKEN_HEADER: state.token})


def test_unknown_fonts_are_404(api):
    assert api.post("/fonts/comic-sans/install").status_code == 404
    assert api.delete("/fonts/comic-sans").status_code == 404


def test_install_over_http_runs_in_the_background(api, fake_font):
    assert api.get("/fonts").json()["fonts"][0]["installed"] is False
    assert api.post("/fonts/test-mono/install").json() == {"started": True}
    deadline = time.monotonic() + 5
    while(api.get("/fonts").json()["download"] is not None and time.monotonic() < deadline):
        time.sleep(0.02)
    assert api.get("/fonts").json()["fonts"][0]["installed"] is True
    assert api.post("/fonts/test-mono/install").json() == {"started": False}
    assert api.delete("/fonts/test-mono").json() == {"removed": True}
    assert api.get("/fonts").json()["fonts"][0]["installed"] is False


def test_the_real_registry_is_pinned_and_hashed():
    # Every real entry must be checkable; an empty hash would accept anything.
    for files in fonts.REGISTRY.values():
        for f in files:
            assert len(f.sha256) == 64 and f.size > 0
    assert fonts.COMMIT in fonts.BASE_URL
