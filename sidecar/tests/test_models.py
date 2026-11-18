"""Model files on disk: status, deleting, and the download-before-switch flow."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient
from test_search import MODEL, ColorEmbedder

from picsearch import config, models
from picsearch.server import TOKEN_HEADER, AppState, create_app

REAL_HAS_WEIGHTS = models.has_weights  # captured before the autouse fixture replaces it
SMALL = "siglip2-base-patch16-224"
BIG = "siglip2-so400m-patch14-384"
# The fixtures serve MODEL; these are the two registry ids that are not it.
NOT_ACTIVE = BIG if MODEL == SMALL else SMALL


def cache_model(tmp_path, hf_id: str, nbytes: int = 1000) -> None:
    repo = tmp_path / ("models--" + hf_id.replace("/", "--"))
    (repo / "blobs").mkdir(parents=True)
    (repo / "snapshots" / "abc").mkdir(parents=True)
    (repo / "blobs" / "deadbeef").write_bytes(b"x" * nbytes)
    link = repo / "snapshots" / "abc" / "model.safetensors"
    try:
        link.symlink_to(repo / "blobs" / "deadbeef")
    except OSError:
        link.write_bytes(b"x" * nbytes)


@pytest.fixture()
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr(models, "has_weights", REAL_HAS_WEIGHTS)
    return tmp_path


def test_a_symlinked_snapshot_is_not_counted_twice(hub):
    cache_model(hub, "google/siglip2-base-patch16-224", 1000)
    assert models.status(SMALL) == {"id": SMALL, "downloaded": True, "sizeBytes": 1000}


def test_nothing_cached_means_not_downloaded(hub):
    assert models.status(SMALL) == {"id": SMALL, "downloaded": False, "sizeBytes": 0}


def test_an_empty_snapshot_is_an_interrupted_download_not_a_hit(hub):
    (hub / "models--google--siglip2-base-patch16-224" / "snapshots" / "abc").mkdir(parents=True)
    assert models.status(SMALL)["downloaded"] is False


def test_delete_removes_the_files_and_reports_the_bytes(hub):
    cache_model(hub, "google/siglip2-base-patch16-224", 1234)
    (hub / ".locks" / "models--google--siglip2-base-patch16-224").mkdir(parents=True)
    assert models.delete(SMALL) == 1234
    assert models.status(SMALL)["downloaded"] is False
    assert not (hub / ".locks" / "models--google--siglip2-base-patch16-224").exists()


def test_delete_of_a_model_that_was_never_downloaded_is_not_an_error(hub):
    assert models.delete(SMALL) == 0


# -- HTTP ------------------------------------------------------------------

@pytest.fixture()
def api(xdg_tmp):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
    client = TestClient(create_app(state), headers={TOKEN_HEADER: state.token})
    return state, client


def test_the_model_list_marks_the_active_one(api, hub):
    state, client = api
    from picsearch.embed import spec_for

    cache_model(hub, spec_for(NOT_ACTIVE).hf_id, 10)
    body = client.get("/models").json()
    rows = {m["id"]: m for m in body["models"]}
    assert rows[MODEL]["active"] is True
    assert rows[NOT_ACTIVE]["downloaded"] is True and rows[NOT_ACTIVE]["active"] is False
    assert body["download"] is None


def test_the_active_model_cannot_be_deleted(api, hub):
    state, client = api
    from picsearch.embed import spec_for

    cache_model(hub, spec_for(MODEL).hf_id, 10)
    assert client.delete(f"/models/{MODEL}").status_code == 409
    assert models.status(MODEL)["downloaded"] is True  # nothing was touched


def test_the_model_being_switched_to_cannot_be_deleted(api, hub):
    state, client = api
    state.pending_model_id = NOT_ACTIVE
    assert client.delete(f"/models/{NOT_ACTIVE}").status_code == 409


def test_deleting_an_unused_model_frees_it_and_leaves_the_active_one(api, hub):
    state, client = api
    from picsearch.embed import spec_for

    cache_model(hub, spec_for(NOT_ACTIVE).hf_id, 500)
    res = client.delete(f"/models/{NOT_ACTIVE}")
    assert res.status_code == 200 and res.json() == {"freed": 500}
    assert models.status(NOT_ACTIVE)["downloaded"] is False


def test_an_unknown_model_is_a_404(api, hub):
    state, client = api
    assert client.delete("/models/nope").status_code == 404
    assert client.post("/models/nope/download").status_code == 404


# -- download-before-switch --------------------------------------------------

def test_switching_to_a_missing_model_downloads_first_then_swaps(xdg_tmp, monkeypatch):
    state = AppState(
        model_id=MODEL, embedder=ColorEmbedder(), weights_present=lambda _m: False
    )
    fetched = threading.Event()

    def fake_snapshot_download(hf_id, allow_patterns=None):
        fetched.set()

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download)
    monkeypatch.setattr(models, "expected_bytes", lambda hf_id: 0)
    continued = threading.Event()
    monkeypatch.setattr(state, "_continue_swap", lambda model_id: continued.set() or False)

    assert state.begin_model_swap(NOT_ACTIVE) is True
    assert state.pending_model_id == NOT_ACTIVE
    assert continued.wait(5), "the swap never continued after the download"
    assert fetched.is_set()
    assert state.downloads.current is None


def test_a_failed_download_abandons_the_swap(xdg_tmp, monkeypatch):
    state = AppState(
        model_id=MODEL, embedder=ColorEmbedder(), weights_present=lambda _m: False
    )

    def boom(hf_id, allow_patterns=None):
        raise OSError("network down")

    monkeypatch.setattr("huggingface_hub.snapshot_download", boom)
    monkeypatch.setattr(models, "expected_bytes", lambda hf_id: 0)
    state.begin_model_swap(NOT_ACTIVE)
    for _ in range(50):
        if(state.pending_model_id is None):
            break
        time.sleep(0.1)
    assert state.pending_model_id is None
    assert config.load()["pendingModelId"] is None


def test_only_one_download_at_a_time(xdg_tmp, monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda hf_id, allow_patterns=None: gate.wait(5)
    )
    monkeypatch.setattr(models, "expected_bytes", lambda hf_id: 0)
    downloads = models.Downloads(lambda kind, payload: None)
    assert downloads.start(SMALL) is True
    assert downloads.start(BIG) is False
    assert downloads.active(SMALL) and not downloads.active(BIG)
    gate.set()
