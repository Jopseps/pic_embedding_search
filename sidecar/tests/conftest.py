import os

import pytest


@pytest.fixture()
def xdg_tmp(tmp_path, monkeypatch):
    """Point every XDG root at a tmpdir. Nothing touches the real home."""
    for name, sub in (
        ("PICSEARCH_DATA_DIR", "data"),
        ("PICSEARCH_CONFIG_DIR", "config"),
        ("PICSEARCH_CACHE_DIR", "cache"),
    ):
        target = tmp_path / sub
        target.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv(name, str(target))
    yield tmp_path
    for name in ("PICSEARCH_DATA_DIR", "PICSEARCH_CONFIG_DIR", "PICSEARCH_CACHE_DIR"):
        os.environ.pop(name, None)


@pytest.fixture()
def store(xdg_tmp):
    from picsearch.store import Store

    s = Store()
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _no_real_trash(monkeypatch):
    """No test may reach the user's trash. A test that needs the move to work
    replaces `system.move_to_trash` itself."""
    from picsearch import system

    def refuse(path):
        raise AssertionError(f"a test tried to trash {path} for real")

    monkeypatch.setattr(system, "move_to_trash", refuse)


@pytest.fixture(autouse=True)
def _weights_are_present(monkeypatch):
    """Tests have no HuggingFace cache. Without this a model switch would start
    a real multi-gigabyte download. A test of the download path itself replaces
    `models.has_weights` and `snapshot_download` on its own."""
    from picsearch import models

    monkeypatch.setattr(models, "has_weights", lambda model_id: True)
