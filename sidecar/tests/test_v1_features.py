"""Trash-delete, filtered / file-based similar, pause, folder removal, the
unplugged-drive guard, non-UTF-8 names, the model fallback and offline loads.

Nothing here calls the real trash: `system.move_to_trash` is always replaced,
and the one test that would need a file only ever sees a path in `tmp_path`.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path, PurePosixPath

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_index import FakeEmbedder
from test_index import library as scan_library  # noqa: F401
from test_search import (  # noqa: F401
    COLORS,
    ColorEmbedder,
    app_state,
    client,
    library,
    make_image,
)

from picsearch import embed, system
from picsearch import index as index_module
from picsearch import server as server_module
from picsearch.index import Indexer, indexable_under, walk_images
from picsearch.server import AppState, create_app


def _ids_by_name(client) -> dict[str, int]:
    items = client.get("/search", params={"q": "", "limit": 100}).json()["items"]
    return {i["filename"]: i["id"] for i in items}


# -- delete = move to trash -----------------------------------------------------

@pytest.fixture()
def trash(monkeypatch):
    """A fake trash that really moves nothing: it records the call and unlinks, so
    the file is gone afterwards exactly as a real trash would leave it."""
    calls: list[Path] = []

    def fake(path):
        calls.append(Path(path))
        Path(path).unlink()

    monkeypatch.setattr(system, "move_to_trash", fake)
    return calls


def test_delete_trashes_the_file_then_drops_the_row(client, app_state, trash):
    ids = _ids_by_name(client)
    victim = ids["red_0.jpg"]
    path = Path(app_state.store.image_by_id(victim)["path"])
    before = app_state.vectors.size

    res = client.request("DELETE", "/images", json={"ids": [victim]})

    assert res.json() == {"removed": 1, "failed": []}
    assert trash == [path]
    assert not path.exists()
    assert app_state.store.image_by_id(victim) is None
    assert app_state.vectors.size == before - 1


def test_a_trash_failure_keeps_the_row_and_the_file(client, app_state, monkeypatch):
    ids = _ids_by_name(client)
    keep, ok = ids["red_0.jpg"], ids["red_1.jpg"]
    keep_path = Path(app_state.store.image_by_id(keep)["path"])

    def fake(path):
        if(Path(path) == keep_path):
            raise OSError("no trash on this mount")
        Path(path).unlink()

    monkeypatch.setattr(system, "move_to_trash", fake)
    res = client.request("DELETE", "/images", json={"ids": [keep, ok]})

    assert res.json() == {"removed": 1, "failed": [keep]}
    assert keep_path.exists()                      # never a permanent-delete fallback
    assert app_state.store.image_by_id(keep) is not None
    assert app_state.store.image_by_id(ok) is None


def test_a_file_that_is_already_gone_just_loses_its_row(client, app_state, trash):
    victim = _ids_by_name(client)["red_0.jpg"]
    Path(app_state.store.image_by_id(victim)["path"]).unlink()

    res = client.request("DELETE", "/images", json={"ids": [victim]})

    assert res.json() == {"removed": 1, "failed": []}
    assert trash == []                              # nothing left to trash
    assert app_state.store.image_by_id(victim) is None


def test_an_unknown_id_touches_nothing(client, trash):
    res = client.request("DELETE", "/images", json={"ids": [987654]})
    assert res.json() == {"removed": 0, "failed": []}
    assert trash == []


def test_the_watcher_seeing_the_same_delete_is_harmless(client, app_state, trash):
    victim = _ids_by_name(client)["red_0.jpg"]
    path = Path(app_state.store.image_by_id(victim)["path"])
    client.request("DELETE", "/images", json={"ids": [victim]})
    assert app_state.indexer.forget_paths([path]) == 0
    # And the other order: the watcher wins, then the route finds no row.
    other = _ids_by_name(client)["red_1.jpg"]
    other_path = Path(app_state.store.image_by_id(other)["path"])
    other_path.unlink()
    assert app_state.indexer.forget_paths([other_path]) == 1
    res = client.request("DELETE", "/images", json={"ids": [other]})
    assert res.json() == {"removed": 0, "failed": []}


# -- filters on similar ---------------------------------------------------------

def test_similar_is_narrowed_by_the_same_filters_as_search(client):
    blue = _ids_by_name(client)["blue_0.png"]
    plain = client.post("/search/similar", json={"image_id": blue}).json()
    assert any(i["isScreenshot"] for i in plain["items"])

    photos = client.post("/search/similar", json={"image_id": blue, "types": ["Photo"]}).json()
    assert photos["items"] and not any(i["isScreenshot"] for i in photos["items"])

    large = client.post("/search/similar", json={"imageId": blue, "dims": "large"}).json()
    assert large["items"] and all(i["filename"].startswith("green") for i in large["items"])

    nothing = client.post(
        "/search/similar", json={"image_id": blue, "dateFrom": "2999-01-01"}
    ).json()
    assert nothing["items"] == [] and nothing["total"] == 0


def test_similar_folder_filter(client, app_state, library):
    blue = _ids_by_name(client)["blue_0.png"]
    res = client.post(
        "/search/similar", json={"image_id": blue, "folders": [str(library / "shots")]}
    ).json()
    assert {i["filename"] for i in res["items"]} == {"blue_1.png", "blue_2.png"}


# -- similar to a file ----------------------------------------------------------

def test_similar_file_of_an_indexed_image_reuses_its_vector(client, app_state):
    blue = _ids_by_name(client)["blue_0.png"]
    path = app_state.store.image_by_id(blue)["path"]
    calls = []
    real = app_state.embedder.embed_pil
    app_state.embedder.embed_pil = lambda *a, **k: (calls.append(1), real(*a, **k))[1]

    res = client.post("/search/similar-file", json={"path": path})

    assert res.status_code == 200
    assert calls == []                                    # the stored vector, no decode
    assert blue not in [i["id"] for i in res.json()["items"]]
    assert "blue" in res.json()["items"][0]["filename"]


def test_similar_file_of_an_outside_image_embeds_it_and_adds_nothing(client, app_state, tmp_path):
    outside = make_image(tmp_path / "elsewhere" / "pic.jpg", COLORS["green"], seed=99)
    count = app_state.store.image_count()

    res = client.post("/search/similar-file", json={"path": str(outside)})

    assert res.status_code == 200
    assert "green" in res.json()["items"][0]["filename"]
    assert app_state.store.image_count() == count
    assert app_state.store.image_by_path(str(outside)) is None

    narrowed = client.post(
        "/search/similar-file", json={"path": str(outside), "types": ["Screenshot"]}
    ).json()
    assert narrowed["items"] and all(i["isScreenshot"] for i in narrowed["items"])


def test_similar_file_rejects_what_it_cannot_read(client, tmp_path):
    text = tmp_path / "notes.txt"
    text.write_text("hi")
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"not a jpeg at all")
    assert client.post("/search/similar-file", json={"path": str(text)}).status_code == 415
    assert client.post("/search/similar-file", json={"path": str(broken)}).status_code == 422
    assert client.post(
        "/search/similar-file", json={"path": str(tmp_path / "nope.jpg")}
    ).status_code == 404
    assert client.post("/search/similar-file", json={"path": str(tmp_path)}).status_code == 404


def test_similar_file_needs_the_token(app_state, tmp_path):
    bare = TestClient(create_app(app_state))
    assert bare.post("/search/similar-file", json={"path": "/x.jpg"}).status_code == 401
    assert bare.post("/indexing/pause", json={"paused": True}).status_code == 401


# -- pause ----------------------------------------------------------------------

def _wait(cond, timeout=10.0):
    end = time.monotonic() + timeout
    while(time.monotonic() < end):
        if(cond()):
            return True
        time.sleep(0.02)
    return False


def test_a_scan_started_while_paused_holds_and_then_resumes(store, scan_library):
    indexer = Indexer(store, FakeEmbedder())
    indexer.pause(True)
    assert indexer.start_rescan([(scan_library, True)])
    assert _wait(lambda: indexer.status.running and indexer.status.total == 20)

    # The new status object must still say paused, or the UI shows "running".
    assert indexer.status.paused is True
    time.sleep(0.4)
    assert indexer.status.current == 0
    assert store.image_count() == 0

    indexer.pause(False)
    indexer.join(30)
    assert store.image_count() == 20
    assert indexer.status.paused is False


def test_stop_cuts_a_paused_scan_short(store, scan_library):
    indexer = Indexer(store, FakeEmbedder())
    indexer.pause(True)
    indexer.start_rescan([(scan_library, True)])
    assert _wait(lambda: indexer.status.running)
    indexer.stop()
    indexer.join(5)
    assert not indexer.running


def test_the_pause_route_reports_and_health_agrees(client, app_state):
    res = client.post("/indexing/pause", json={"paused": True})
    assert res.status_code == 200 and res.json()["paused"] is True
    assert client.get("/health").json()["indexing"]["paused"] is True
    assert client.post("/indexing/pause", json={"paused": False}).json()["paused"] is False
    assert client.get("/health").json()["indexing"]["paused"] is False


# -- removing a watched folder ---------------------------------------------------

@pytest.fixture()
def nested(app_state, tmp_path):
    root = tmp_path / "nest"
    make_image(root / "top.jpg", COLORS["red"], seed=70)
    make_image(root / "sub" / "deep.jpg", COLORS["green"], seed=71)
    make_image(root / "sub" / "deeper" / "deepest.jpg", COLORS["blue"], seed=72)
    return root


def _names(state):
    return {Path(r["path"]).name for r in state.store.conn().execute("SELECT path FROM images")}


def test_removing_a_folder_drops_its_rows_and_keeps_the_files(client, app_state, nested):
    app_state.store.add_folder(str(nested), True)
    app_state.indexer.scan([(nested, True)])
    state_before = app_state.store.image_count()
    epoch = app_state.store.pixel_epoch

    res = client.request("DELETE", "/folders", params={"path": str(nested)})

    assert res.json() == {"ok": True, "removed": 3}
    assert app_state.store.image_count() == state_before - 3
    assert {"top.jpg", "deep.jpg", "deepest.jpg"}.isdisjoint(_names(app_state))
    assert (nested / "top.jpg").exists() and (nested / "sub" / "deep.jpg").exists()
    assert app_state.store.pixel_epoch > epoch
    assert app_state.vectors.size == app_state.store.image_count()


def test_a_nested_watched_folder_keeps_what_it_still_covers(client, app_state, nested):
    app_state.store.add_folder(str(nested), True)
    app_state.store.add_folder(str(nested / "sub"), True)
    app_state.indexer.scan([(nested, True)])

    # Removing the inner one: the outer, recursive folder still covers everything.
    assert client.request("DELETE", "/folders", params={"path": str(nested / "sub")}).json()[
        "removed"
    ] == 0
    # Removing the outer one now drops all of it (the inner is gone too).
    app_state.store.add_folder(str(nested / "sub"), True)
    res = client.request("DELETE", "/folders", params={"path": str(nested)})
    assert res.json()["removed"] == 1              # only top.jpg: sub/ is still watched
    assert {"deep.jpg", "deepest.jpg"} <= _names(app_state)
    assert "top.jpg" not in _names(app_state)


def test_a_non_recursive_remaining_folder_does_not_keep_the_subtree(
    client, app_state, nested
):
    app_state.store.add_folder(str(nested), False)
    app_state.store.add_folder(str(nested / "sub"), True)
    app_state.indexer.scan([(nested, False), (nested / "sub", True)])
    res = client.request("DELETE", "/folders", params={"path": str(nested / "sub")})
    assert res.json()["removed"] == 2              # `nest` is not recursive: it never covered them
    assert "top.jpg" in _names(app_state)


def test_removing_an_unwatched_path_deletes_nothing(client, app_state, nested):
    app_state.indexer.scan([(nested, True)])
    count = app_state.store.image_count()
    res = client.request("DELETE", "/folders", params={"path": str(nested)})
    assert res.json() == {"ok": True, "removed": 0}
    assert app_state.store.image_count() == count


def test_indexable_under_is_the_rule_the_cleanup_uses(nested):
    assert indexable_under(nested / "sub" / "deep.jpg", nested, True)
    assert not indexable_under(nested / "sub" / "deep.jpg", nested, False)


# -- unplugged drive guard -------------------------------------------------------

def test_an_emptied_root_keeps_its_rows_and_warns(store, scan_library):
    events: list[tuple[str, dict]] = []
    indexer = Indexer(store, FakeEmbedder(), on_event=lambda k, p: events.append((k, p)))
    indexer.scan([(scan_library, True)])
    for child in scan_library.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()

    report = indexer.scan([(scan_library, True)])

    assert report.removed == 0
    assert store.image_count() == 20
    warnings = [p["message"] for k, p in events if k == "error"]
    assert len(warnings) == 1
    assert str(scan_library) in warnings[0] and "photos were kept" in warnings[0]
    assert "Remove the folder in Settings" in warnings[0]


def test_a_root_with_some_files_gone_still_prunes(store, scan_library):
    events: list[tuple[str, dict]] = []
    indexer = Indexer(store, FakeEmbedder(), on_event=lambda k, p: events.append((k, p)))
    indexer.scan([(scan_library, True)])
    (scan_library / "photo_00.jpg").unlink()
    assert indexer.scan([(scan_library, True)]).removed == 1
    assert [k for k, _ in events if k == "error"] == []


# -- names that are not UTF-8 ------------------------------------------------------

@pytest.mark.skipif(
    sys.platform == "win32",
    reason="Windows file names are UTF-16, so a name that is not valid UTF-8 cannot exist there",
)
def test_a_non_utf8_name_is_skipped_before_any_work(store, scan_library, monkeypatch):
    bad = os.fsencode(scan_library) + b"/bad\xff.jpg"
    with open(bad, "wb") as fh:
        Image.new("RGB", (64, 64), (1, 2, 3)).save(fh, format="JPEG")
    embedder = FakeEmbedder()
    indexer = Indexer(store, embedder)

    # Recorded off the logger itself: other tests leave logging configured in
    # ways that make caplog unreliable when the whole suite runs.
    warnings: list[str] = []
    monkeypatch.setattr(index_module.log, "warning", lambda msg, *a: warnings.append(msg % a))
    walked = list(walk_images(scan_library))
    report = indexer.scan([(scan_library, True)])

    assert len(walked) == 20
    assert report.errors == [] and report.ingested == 20
    assert store.image_count() == 20
    assert sum("not valid UTF-8" in w for w in warnings) == 2   # the walk and the scan
    assert not indexable_under(Path(os.fsdecode(bad)), scan_library)
    assert indexer.forget_paths([Path(os.fsdecode(bad))]) == 0


# -- model fallback -----------------------------------------------------------------

def test_an_unknown_model_in_the_config_falls_back_to_the_default(xdg_tmp, monkeypatch):
    from picsearch import config, paths

    config.save({"modelId": "no-such-model"})
    before = paths.config_path().read_bytes()

    warnings: list[str] = []
    monkeypatch.setattr(server_module.log, "warning", lambda msg, *a: warnings.append(msg % a))
    state = AppState(embedder=ColorEmbedder())

    assert state.model_id == config.DEFAULTS["modelId"]
    assert state.spec.model_id == config.DEFAULTS["modelId"]
    assert any("no-such-model" in w for w in warnings)
    assert paths.config_path().read_bytes() == before


# -- offline model loads ---------------------------------------------------------------

class _Factory:
    def __init__(self, cached: bool):
        self.cached = cached
        self.calls: list[dict] = []

    def from_pretrained(self, hf_id, **kwargs):
        self.calls.append(kwargs)
        if(kwargs.get("local_files_only") and not self.cached):
            raise OSError("not in the cache")
        return "model"


def test_a_cached_model_loads_with_one_local_only_call():
    factory = _Factory(cached=True)
    assert embed.load_pretrained(factory, "x/y", dtype=1) == "model"
    assert factory.calls == [{"local_files_only": True, "dtype": 1}]


def test_an_uncached_model_falls_back_to_a_downloading_load():
    factory = _Factory(cached=False)
    assert embed.load_pretrained(factory, "x/y", dtype=1) == "model"
    assert factory.calls == [{"local_files_only": True, "dtype": 1}, {"dtype": 1}]


def test_the_embedder_loads_through_the_cache_first(monkeypatch):
    import transformers

    seen = []
    monkeypatch.setattr(
        embed, "load_pretrained", lambda factory, hf_id, **kw: seen.append((factory, hf_id)) or
        (_ for _ in ()).throw(RuntimeError("stop here"))
    )
    with pytest.raises(RuntimeError, match="stop here"):
        embed.Embedder("siglip2-base-patch16-224", device="cpu").load()
    assert seen == [(transformers.AutoModel, "google/siglip2-base-patch16-224")]



# -- reveal in the file manager --------------------------------------------------

def test_reveal_selects_every_file_over_dbus(monkeypatch):
    calls = []
    monkeypatch.setattr(system, "WINDOWS", False)
    monkeypatch.setattr(system.shutil, "which", lambda name: "/usr/bin/gdbus")
    def run(argv, **kw):
        calls.append(argv)
        return system.subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(system.subprocess, "run", run)
    monkeypatch.setattr(system, "_spawn", lambda argv: pytest.fail(f"fell back to {argv}"))
    # PurePosixPath: this test plays Linux; a WindowsPath("/p/..") has no drive, as_uri() raises.
    files = [PurePosixPath(p) for p in ("/p/a/it's, here.png", "/p/a/b.png", "/p/c/d.png")]
    assert system.reveal_files(files) == 2   # two folders, two windows
    uris = calls[0][-2]
    # Quote and comma are percent-encoded, so the GVariant literal stays intact.
    assert uris == "['file:///p/a/it%27s%2C%20here.png', 'file:///p/a/b.png', 'file:///p/c/d.png']"


def test_reveal_falls_back_to_opening_the_folders(monkeypatch):
    spawned = []
    monkeypatch.setattr(system, "WINDOWS", False)
    monkeypatch.setattr(system.shutil, "which", lambda name: None)
    monkeypatch.setattr(system, "_spawn", lambda argv: spawned.append(argv) or True)
    assert system.reveal_files([Path("/p/a/x.png"), Path("/p/a/y.png")]) == 1
    assert spawned == [["xdg-open", str(Path("/p/a"))]]


def test_reveal_on_windows_selects_the_first_file_per_folder(monkeypatch):
    spawned = []
    monkeypatch.setattr(system, "WINDOWS", True)
    monkeypatch.setattr(system, "_spawn", lambda argv: spawned.append(argv) or True)
    a, b, c = Path("/p/a/x.png"), Path("/p/a/y.png"), Path("/p/c/z.png")
    assert system.reveal_files([a, b, c]) == 2
    assert spawned == [f'explorer /select,"{a}"', f'explorer /select,"{c}"']
