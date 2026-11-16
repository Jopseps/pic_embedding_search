"""config.toml persistence."""

import pytest

from picsearch import config
from picsearch.paths import config_path


def test_a_failed_write_leaves_the_previous_file_intact(xdg_tmp, monkeypatch):
    """A kill mid-write truncated config.toml, which `load()` reads as defaults —
    including the default model, which can be one the library has no vectors for."""
    config.save({"modelId": "jina-clip-v2", "theme": "light"})
    before = config_path().read_text()

    def dying(*_a, **_k):
        raise OSError("killed")

    monkeypatch.setattr(config.os, "replace", dying)
    with pytest.raises(OSError):
        config.save({"theme": "dark"})
    assert config_path().read_text() == before
    assert config.load()["modelId"] == "jina-clip-v2"
