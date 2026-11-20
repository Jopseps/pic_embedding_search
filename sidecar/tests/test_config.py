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


def test_recent_searches_survive_quotes_and_an_empty_list(xdg_tmp):
    """The panel's list is user text: a quote or backslash must not break the file."""
    searches = ['say "cheese"', "C:\\temp", "masa"]
    config.save({"recentSearches": searches})
    assert config.load()["recentSearches"] == searches
    config.save({"recentSearches": []})
    assert config.load()["recentSearches"] == []


def test_a_config_from_before_match_mode_gets_smart(xdg_tmp):
    # Existing users: their file has a strictness but no mode, and must land on Smart.
    config_path().parent.mkdir(parents=True, exist_ok=True)
    config_path().write_text("[settings]\nmatchStrictness = 0\n")
    assert config.load()["matchMode"] == "smart"


def test_the_startup_update_check_is_off_until_chosen(xdg_tmp):
    assert config.load()["checkUpdatesOnStartup"] is False
    config.save({"checkUpdatesOnStartup": True})
    assert config.load()["checkUpdatesOnStartup"] is True
