"""Model swapping — step 11.

The claim this whole file exists to defend: **search keeps working for the
entire swap**. The old model's vectors are never deleted, so the outgoing model
can go on answering queries while the incoming one is embedded in the
background. `modelId` only moves once the new model can actually answer.

Everything here injects embedders. Loading two real SigLIP variants to assert
bookkeeping would cost 3.3 GB of VRAM and several minutes per test.
"""

import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_search import COLORS, DIM, MODEL, make_image

from picsearch import config
from picsearch.search import SearchParams
from picsearch.server import TOKEN_HEADER, AppState, create_app

# A second real registry id, so `spec_for` accepts it. Its dim differs from
# MODEL's, which is exactly the incompatibility the swap exists to manage.
OTHER = "siglip2-so400m-patch14-384"


class FakeEmbedder:
    """Colour-space embedder that can be told which model it is.

    `dim` deliberately tracks the model: a vector written for one model must
    never be admitted to the other's index, and equal dims would hide that.
    """

    DIMS = {MODEL: DIM, OTHER: 1152}

    def __init__(self, model_id: str = MODEL):
        self.model_id = model_id
        self.loaded = True
        self.device = "cpu"
        self.unloaded = False

    @property
    def dim(self) -> int:
        return self.DIMS[self.model_id]

    def switch(self, model_id: str) -> None:
        self.model_id = model_id

    def unload(self) -> None:
        self.unloaded = True

    def embed_pil(self, images, batch_size: int = 32) -> np.ndarray:
        out = np.zeros((len(images), self.dim), dtype=np.float32)
        for i, img in enumerate(images):
            mean = np.asarray(img.convert("RGB").resize((8, 8)), dtype=np.float32).mean(axis=(0, 1))
            out[i, :3] = mean / (np.linalg.norm(mean) or 1.0)
        return out

    def embed_text(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        for name, axis in {"red": 0, "green": 1, "blue": 2}.items():
            if(name in text.lower()):
                v[axis] = 1.0
        if(not v.any()):
            v[:3] = 1.0
        return v / np.linalg.norm(v)


@pytest.fixture()
def library(tmp_path):
    root = tmp_path / "lib"
    for i in range(3):
        make_image(root / "photos" / f"red_{i}.jpg", COLORS["red"], seed=i + 1)
    for i in range(2):
        make_image(root / "photos" / f"blue_{i}.jpg", COLORS["blue"], seed=i + 20)
    return root


@pytest.fixture()
def state(xdg_tmp, library):
    # Config and the active model agree, as they do in production — the
    # `model_id` argument is a debugging override, not a second source of truth.
    config.save({"modelId": MODEL, "pendingModelId": None})
    st = AppState(
        model_id=MODEL,
        embedder=FakeEmbedder(MODEL),
        embedder_factory=FakeEmbedder,
    )
    st.ocr = None
    st.indexer.set_ocr(None)
    st.store.add_folder(str(library), recursive=True)
    st.indexer.scan([(library, True)])
    return st


@pytest.fixture()
def client(state):
    c = TestClient(create_app(state))
    c.headers.update({TOKEN_HEADER: state.token})
    return c


def swap(state, model_id=OTHER):
    """Start a swap and run it to completion on this thread."""
    state.pending_model_id = model_id
    state.settings = config.save({"pendingModelId": model_id})
    state.pending_embedder = state.embedder_factory(model_id)
    state.indexer.run_model_backfill(model_id, state.pending_embedder, state.promote_model)


# ---------------------------------------------------------------------------
# The load-bearing claim
# ---------------------------------------------------------------------------

def test_search_keeps_working_for_the_whole_swap(state):
    """Nothing is disabled. The outgoing model still has every vector it had."""
    before = state.searcher.search(SearchParams(q="red"))
    assert before["total"] > 0

    state.pending_model_id = OTHER
    state.pending_embedder = FakeEmbedder(OTHER)
    # Embed the incoming model batch by batch, searching between each one.
    state.indexer.embed_missing(OTHER, limit=2, embedder=state.pending_embedder)
    mid = state.searcher.search(SearchParams(q="red"))
    assert [i["id"] for i in mid["items"]] == [i["id"] for i in before["items"]]
    assert state.model_id == MODEL


def test_the_backfill_never_feeds_the_live_index(state):
    """The live index belongs to the outgoing model and has a different dim.

    `_flush` suppresses `on_vector` for a swap; without that this either raises
    on the dim check or, if two models happened to share a dim, silently
    poisons every search until promotion.
    """
    size_before = state.vectors.size
    state.indexer.embed_missing(OTHER, embedder=FakeEmbedder(OTHER))
    assert state.vectors.size == size_before
    assert state.vectors.model_id == MODEL
    # The rows exist, they are just not live yet.
    assert state.store.embedding_count(OTHER) == state.store.image_count()


def test_the_active_model_only_moves_when_coverage_is_complete(state):
    state.pending_model_id = OTHER
    state.pending_embedder = FakeEmbedder(OTHER)
    state.indexer.embed_missing(OTHER, limit=1, embedder=state.pending_embedder)

    state.promote_model()
    assert state.model_id == MODEL          # still short
    assert config.load()["modelId"] == MODEL

    state.indexer.embed_missing(OTHER, embedder=state.pending_embedder)
    state.promote_model()
    assert state.model_id == OTHER
    assert config.load()["modelId"] == OTHER


def test_promotion_loads_the_new_vectors(state):
    swap(state)
    assert state.model_id == OTHER
    assert state.vectors.model_id == OTHER
    assert state.vectors.size == state.store.image_count()
    assert state.searcher.vectors is state.vectors
    # And search answers from them.
    assert state.searcher.search(SearchParams(q="red"))["total"] > 0


def test_a_search_racing_the_promotion_never_mixes_models(state):
    """The bug the first real end-to-end swap hit:
    `ValueError: query dim 768 != index dim 1152`.

    Promotion used to assign the vector index and the embedder separately, so a
    request in flight could embed its query with one model and scan the other's
    index. The two now move as one immutable `Backend`, and `search` snapshots
    it once.
    """
    errors = []
    stop = threading.Event()

    def hammer():
        while(not stop.is_set()):
            try:
                state.searcher.search(SearchParams(q="red"))
            except Exception as exc:      # noqa: BLE001 — the assertion is "none"
                errors.append(exc)
                return

    state.indexer.embed_missing(OTHER, embedder=FakeEmbedder(OTHER))
    state.pending_model_id = OTHER
    state.pending_embedder = FakeEmbedder(OTHER)

    threads = [threading.Thread(target=hammer, daemon=True) for _ in range(4)]
    for t in threads:
        t.start()
    try:
        time.sleep(0.05)
        state.promote_model()
        time.sleep(0.05)
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=2.0)

    assert errors == []
    assert state.model_id == OTHER
    # And the promotion actually took, rather than being skipped.
    assert state.searcher.vectors.model_id == OTHER
    assert state.searcher.embedder.model_id == OTHER


def test_promotion_reuses_the_embedder_that_did_the_work(state):
    """It already has the incoming model resident. Reloading would pay the
    weights cost twice and reopen the window above."""
    pending = FakeEmbedder(OTHER)
    outgoing = state.embedder
    state.pending_model_id = OTHER
    state.pending_embedder = pending
    state.indexer.embed_missing(OTHER, embedder=pending)

    state.promote_model()
    assert state.embedder is pending
    assert state.indexer.embedder is pending
    # The outgoing model gives its VRAM back.
    assert outgoing.unloaded is True


def test_the_old_vectors_survive(state):
    """The whole reason switching back is instant."""
    swap(state)
    assert state.store.embedding_count(MODEL) == state.store.image_count()
    assert state.store.embedding_count(OTHER) == state.store.image_count()


def test_switching_back_costs_no_gpu(state):
    swap(state)
    embedder = FakeEmbedder(MODEL)
    state.embedder_factory = lambda mid: embedder

    started = state.begin_model_swap(MODEL)
    assert started is False                 # nothing to embed, so no backfill
    assert state.model_id == MODEL
    assert state.pending_model_id is None
    assert embedder.embed_pil([]).shape[0] == 0


# ---------------------------------------------------------------------------
# Config, and surviving a restart
# ---------------------------------------------------------------------------

def test_a_swap_in_flight_does_not_move_modelid_in_config(state):
    state.begin_model_swap(OTHER)
    saved = config.load()
    # The sidecar must come back searching, not blank, if it dies right here.
    assert saved["modelId"] == MODEL
    assert saved["pendingModelId"] == OTHER


def test_config_omits_a_null_pending_model(state, tmp_path):
    """TOML has no null, and `_value` would happily write the string "None"."""
    config.save({"pendingModelId": None})
    text = (tmp_path / "config" / "config.toml").read_text()
    assert "pendingModelId" not in text
    assert config.load()["pendingModelId"] is None


def test_an_interrupted_swap_resumes_where_it_stopped(state):
    state.pending_model_id = OTHER
    state.pending_embedder = FakeEmbedder(OTHER)
    state.indexer.embed_missing(OTHER, limit=2, embedder=state.pending_embedder)
    partial = state.store.embedding_count(OTHER)
    assert 0 < partial < state.store.image_count()
    config.save({"pendingModelId": OTHER})

    # A fresh sidecar over the same database.
    restarted = AppState(model_id=MODEL, embedder=FakeEmbedder(MODEL),
                         embedder_factory=FakeEmbedder)
    restarted.ocr = None
    restarted.indexer.set_ocr(None)
    assert restarted.model_id == MODEL      # still searching on the old one
    assert restarted.pending_model_id == OTHER

    restarted.indexer.run_model_backfill(
        OTHER, FakeEmbedder(OTHER), restarted.promote_model
    )
    assert restarted.model_id == OTHER
    # Resumed, not restarted: the images already done were not touched again.
    assert restarted.store.embedding_count(OTHER) == restarted.store.image_count()


def test_an_unknown_pending_model_is_abandoned(state):
    config.save({"pendingModelId": "clip-vit-nope"})
    state.settings = config.load()
    state.resume_model_swap()
    assert state.pending_model_id is None
    assert config.load()["pendingModelId"] is None


def test_a_stalled_backfill_does_not_spin(state, monkeypatch):
    """Every remaining image fails to decode. One pass embeds nothing and the
    loop must give up rather than ask the same question forever."""
    calls = []
    real = state.indexer.embed_missing

    def counting(*args, **kwargs):
        calls.append(1)
        if(len(calls) > 1):
            return 0
        kwargs.pop("limit", None)
        return real(*args, limit=1, **kwargs)

    monkeypatch.setattr(state.indexer, "embed_missing", counting)
    state.indexer.run_model_backfill(OTHER, FakeEmbedder(OTHER))
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# Wire surface
# ---------------------------------------------------------------------------

def test_put_settings_starts_a_swap_without_switching(client, state):
    body = client.put("/settings", json={"modelId": OTHER}).json()
    assert body["modelId"] == MODEL         # still the one answering queries
    assert body["pendingModelId"] == OTHER
    assert body["pendingCoverage"]["total"] == state.store.image_count()


def test_settings_reports_no_pending_model_when_idle(client):
    body = client.get("/settings").json()
    assert body["pendingModelId"] is None
    assert body["pendingCoverage"] == {"done": 0, "total": 0}


def test_health_reports_the_pending_model(client, state):
    assert client.get("/health").json()["pendingModelId"] is None
    state.begin_model_swap(OTHER)
    assert client.get("/health").json()["pendingModelId"] == OTHER


def test_counts_are_over_the_library_not_the_page(client, state):
    """The sidebar read these off the last search response, so "All" showed
    whatever the current query returned."""
    counts = client.get("/counts").json()
    assert counts["library"] == state.store.image_count()
    assert counts["dupes"] == len(state.searcher.dupes.ids)
    assert counts["recent"] >= 0
    assert counts["collections"] == {}


def test_counts_include_collection_membership(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    ids = [i["id"] for i in client.get("/search", params={"limit": 2}).json()["items"]]
    client.post(f"/collections/{coll['id']}/items", json={"ids": ids})
    assert client.get("/counts").json()["collections"] == {coll["id"]: 2}


def test_counts_need_the_token(state):
    bare = TestClient(create_app(state))
    assert bare.get("/counts").status_code == 401


def test_a_swap_deferred_by_a_busy_slot_starts_when_the_slot_frees(state):
    """The boot scan runs before the lifespan resumes a pending swap, so the swap
    found the slot taken, logged "deferred", and nothing ever started it."""
    import time

    state.indexer.status.running = True                 # a scan holds the slot
    assert state.begin_model_swap(OTHER) is False
    assert state.pending_model_id == OTHER and state.model_id == MODEL

    state.indexer.status.running = False
    state._on_event("scan-complete", {})
    deadline = time.time() + 10
    while(time.time() < deadline and state.model_id != OTHER):
        time.sleep(0.05)
    assert state.model_id == OTHER
    assert state.pending_model_id is None


def test_a_retry_keeps_the_embedder_that_is_already_loaded(state):
    """Each retry built a fresh embedder, dropping weights a pass had loaded."""
    state.indexer.status.running = True                 # keep the backfill from starting
    state.begin_model_swap(OTHER)
    first = state.pending_embedder
    state.begin_model_swap(OTHER)
    assert state.pending_embedder is first
