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
