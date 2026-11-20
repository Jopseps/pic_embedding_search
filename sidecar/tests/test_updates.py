"""The update check: version order, every failure becoming `ok: false`, and the
fixed URL the open endpoint is allowed to launch. No network, no browser."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from test_search import MODEL, ColorEmbedder

from picsearch import __version__, updates
from picsearch.server import TOKEN_HEADER, AppState, create_app


def serve(monkeypatch, body):
    monkeypatch.setattr(updates, "fetch", lambda: body)


@pytest.mark.parametrize("latest,current,newer", [
    ("1.0.7", "1.0.6", True),
    ("1.0.10", "1.0.9", True),    # numeric, not alphabetical
    ("1.0.6", "1.0.6", False),
    ("1.0.5", "1.0.6", False),
    ("v2.0.0", "1.9.9", True),
    ("1.1", "1.1.0", False),      # same release spelled shorter
    ("1.1.1", "1.1", True),
])
def test_version_order(latest, current, newer):
    assert updates.is_newer(latest, current) is newer


@pytest.mark.parametrize("tag", ["", "latest", "1.0.x", "1.1.0-beta", "1..2"])
def test_an_unparseable_tag_is_refused(tag):
    with pytest.raises(ValueError):
        updates.parse_version(tag)


def test_a_newer_release_is_available(monkeypatch):
    serve(monkeypatch, {"tag_name": "v999.0.0"})
    assert updates.check() == {
        "current": __version__, "latest": "999.0.0", "available": True, "ok": True,
    }


def test_the_same_release_is_not_available(monkeypatch):
    serve(monkeypatch, {"tag_name": f"v{__version__}"})
    res = updates.check()
    assert res["ok"] is True and res["available"] is False and res["latest"] == __version__


def test_an_older_release_is_not_available(monkeypatch):
    serve(monkeypatch, {"tag_name": "v0.0.1"})
    res = updates.check()
    assert res["ok"] is True and res["available"] is False


def raising(exc):
    def fetch():
        raise exc

    return fetch


@pytest.mark.parametrize("failure", [
    raising(OSError("offline")),
    raising(TimeoutError()),
    raising(ValueError("not json")),
])
def test_a_failed_request_is_ok_false(monkeypatch, failure):
    monkeypatch.setattr(updates, "fetch", failure)
    assert updates.check() == {
        "current": __version__, "latest": None, "available": False, "ok": False,
    }


@pytest.mark.parametrize("body", [{}, [], None, {"tag_name": None}, {"tag_name": "nightly"}])
def test_a_body_without_a_usable_tag_is_ok_false(monkeypatch, body):
    serve(monkeypatch, body)
    assert updates.check()["ok"] is False


def test_a_non_200_from_the_real_fetch_is_ok_false(monkeypatch):
    import httpx

    def forbidden(url, **kw):
        return httpx.Response(403, json={}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", forbidden)
    assert updates.check()["ok"] is False


# -- HTTP ------------------------------------------------------------------

@pytest.fixture()
def api(xdg_tmp):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
    return TestClient(create_app(state), headers={TOKEN_HEADER: state.token})


def test_check_over_http_never_500s(api, monkeypatch):
    monkeypatch.setattr(updates, "fetch", raising(OSError("offline")))
    res = api.get("/updates/check")
    assert res.status_code == 200 and res.json()["ok"] is False


def test_open_launches_only_the_fixed_page(api, monkeypatch):
    opened = []
    monkeypatch.setattr(updates.webbrowser, "open", lambda url: opened.append(url) or True)
    res = api.post("/updates/open", params={"url": "https://evil.example"}, json={"url": "https://evil.example"})
    assert res.json() == {"opened": True}
    assert opened == [updates.RELEASES_PAGE]


def test_the_endpoints_need_the_token(api):
    bare = TestClient(api.app)
    assert bare.get("/updates/check").status_code == 401
    assert bare.post("/updates/open").status_code == 401
