"""Search and HTTP contract tests.

Nothing here loads a model: a fake embedder maps images to a colour axis and
queries to the same axis, so ranking is exact and the tests run in milliseconds.

The contract test that matters is `test_item_keys_match_types_ts` — the wire
shape is frozen against src/lib/types.ts, and drifting from it breaks the app
across two languages.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from picsearch import system
from picsearch.index import Indexer
from picsearch.search import (
    Searcher,
    SearchParams,
    VectorIndex,
    build_filter_sql,
    candidate_ids,
    fts_match_query,
    fts_search,
    leg_weights,
    rrf_merge,
)
from picsearch.server import TOKEN_HEADER, AppState, create_app
from picsearch.store import Store

MODEL = "siglip2-base-patch16-224"
DIM = 768
TYPES_TS = Path(__file__).resolve().parents[2] / "src" / "lib" / "types.ts"

COLORS = {
    "red": (220, 30, 30),
    "green": (30, 200, 60),
    "blue": (30, 50, 220),
}
AXIS = {"red": 0, "green": 1, "blue": 2}


class ColorEmbedder:
    """Images and text both land on a 3-axis colour space padded out to DIM."""

    model_id = MODEL
    dim = DIM
    loaded = True
    device = "cpu"

    def embed_pil(self, images, batch_size: int = 32) -> np.ndarray:
        out = np.zeros((len(images), DIM), dtype=np.float32)
        for i, img in enumerate(images):
            mean = np.asarray(img.convert("RGB").resize((8, 8)), dtype=np.float32).mean(axis=(0, 1))
            out[i, :3] = mean / (np.linalg.norm(mean) or 1.0)
        return out

    def embed_text(self, text: str) -> np.ndarray:
        v = np.zeros(DIM, dtype=np.float32)
        for name, axis in AXIS.items():
            if(name in text.lower()):
                v[axis] = 1.0
        if(not v.any()):
            v[:3] = 1.0
        return v / np.linalg.norm(v)


def make_image(path: Path, color, size=(800, 600), seed=0):
    """`seed` paints a small corner block so fixtures are not byte-identical.

    It has to be a block, not a pixel: JPEG quantization erases a single-pixel
    difference and every same-coloured fixture would hash identically and read
    as an exact duplicate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, color)
    img.paste((seed * 5 % 256, 255 - color[1], seed * 3 % 256), (0, 0, 32, 8 + seed))
    img.save(path)
    return path


@pytest.fixture()
def library(tmp_path):
    root = tmp_path / "lib"
    for i in range(4):
        make_image(root / "photos" / f"red_{i}.jpg", COLORS["red"], seed=i + 1)
    for i in range(3):
        make_image(
            root / "photos" / f"green_{i}.jpg", COLORS["green"], size=(3000, 2000), seed=i + 20
        )
    for i in range(3):
        make_image(
            root / "shots" / f"blue_{i}.png", COLORS["blue"], size=(1920, 1080), seed=i + 40
        )
    return root


@pytest.fixture()
def app_state(xdg_tmp, library):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
    # OCR is driven by explicit put_ocr() rows below, never by shelling out to
    # a real engine — whether this machine has tesseract must not change what
    # any of these assertions mean.
    state.ocr = None
    state.indexer.set_ocr(None)
    state.store.add_folder(str(library), recursive=True)
    state.indexer.scan([(library, True)])
    return state


@pytest.fixture()
def client(app_state):
    c = TestClient(create_app(app_state))
    c.headers.update({TOKEN_HEADER: app_state.token})
    return c


# ---------------------------------------------------------------------------
# RRF
# ---------------------------------------------------------------------------

def test_rrf_merge():
    """score(id) = Σ 1/(60 + rank). Never a weighted sum of the raw scores."""
    vector = [10, 20, 30]
    text = [30, 10, 40]
    merged = rrf_merge([vector, text])

    expected = {
        10: 1 / 61 + 1 / 62,   # rank 1 in one list, rank 2 in the other
        20: 1 / 62,
        30: 1 / 63 + 1 / 61,
        40: 1 / 63,
    }
    assert [i for i, _ in merged] == [10, 30, 20, 40]
    for image_id, score in merged:
        assert score == pytest.approx(expected[image_id])


def test_balanced_weighting_is_the_unweighted_fusion():
    """The default has to be bit-for-bit what it was before weights existed —
    every score in the API response is otherwise renumbered by a setting nobody
    touched."""
    assert leg_weights(50) == (1.0, 1.0)
    lists = [[10, 20, 30], [30, 10, 40]]
    assert rrf_merge(lists, weights=leg_weights(50)) == rrf_merge(lists)


def test_weighting_moves_a_text_hit_past_a_visual_one():
    visual = [10, 20]
    text = [20, 10]
    # Balanced, 10 wins on id after a tie. Leaning on text, 20's rank-1 there
    # outweighs 10's rank-1 in the visual leg.
    assert [i for i, _ in rrf_merge([visual, text], weights=leg_weights(50))] == [10, 20]
    assert [i for i, _ in rrf_merge([visual, text], weights=leg_weights(80))] == [20, 10]
    assert [i for i, _ in rrf_merge([visual, text], weights=leg_weights(20))] == [10, 20]


def test_leg_weights_clamp_a_hand_edited_config():
    # config.toml is read back as-is, so the value can be anything.
    assert leg_weights(-40) == leg_weights(0)
    assert leg_weights(400) == leg_weights(100)
    assert leg_weights(100) == (0.0, 2.0)
    assert leg_weights(0) == (2.0, 0.0)


def test_a_silenced_leg_contributes_nothing_at_all():
    """Weight 0 skips the list rather than scoring it at zero. Multiplying
    through put every candidate of the silenced leg in the result at score 0,
    sorted by id after the real hits — the far end of the slider answered with
    the whole library."""
    visual = [10, 20, 30]
    text = [40]
    assert [i for i, _ in rrf_merge([visual, text], weights=leg_weights(100))] == [40]
    assert [i for i, _ in rrf_merge([visual, text], weights=leg_weights(0))] == [10, 20, 30]


def test_rrf_ties_break_on_id_for_a_stable_order():
    # 10 and 30 score identically here; the order must still be deterministic.
    merged = rrf_merge([[10, 20, 30], [30, 40, 10]])
    assert [i for i, _ in merged] == [10, 30, 20, 40]


def test_rrf_rewards_agreement_over_a_single_strong_hit():
    top_of_one = rrf_merge([[1, 2, 3], [4, 5, 6]])
    assert dict(top_of_one)[1] == pytest.approx(1 / 61)
    both = rrf_merge([[1, 2], [2, 1]])
    assert dict(both)[1] == dict(both)[2]


def test_rrf_ignores_lists_an_id_is_absent_from():
    merged = dict(rrf_merge([[7], []]))
    assert merged == {7: pytest.approx(1 / 61)}


def test_rrf_k_dampens_rank_one_dominance():
    tight = rrf_merge([[1], [2]], k=1)
    assert dict(tight)[1] == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# VectorIndex
# ---------------------------------------------------------------------------

def unit(*first3) -> np.ndarray:
    v = np.zeros(DIM, dtype=np.float32)
    v[:len(first3)] = first3
    return v / np.linalg.norm(v)


def test_vector_index_loads_only_the_active_model(store: Store):
    store.upsert_image(
        path="/a.jpg", mtime=1.0, size_bytes=1, width=10, height=10, mime="image/jpeg",
        phash=1, sha256="a" * 64, taken_at=None, is_screenshot=False,
    )
    store.put_embedding(1, MODEL, unit(1, 0, 0))
    store.put_embedding(1, "jina-clip-v2", np.ones(1024, dtype=np.float32))

    idx = VectorIndex.load(store, MODEL, DIM)
    assert idx.size == 1
    assert idx.matrix.shape == (1, DIM)
    assert VectorIndex.load(store, "openclip-vit-l14", 768).size == 0


def test_vector_index_search_ranks_by_cosine():
    idx = VectorIndex(MODEL, DIM)
    idx.add(1, unit(1, 0, 0))
    idx.add(2, unit(0, 1, 0))
    idx.add(3, unit(0.7, 0.7, 0))

    ranked = idx.search(unit(1, 0, 0), limit=3)
    assert [i for i, _ in ranked] == [1, 3, 2]
    assert ranked[0][1] == pytest.approx(1.0, abs=1e-5)


def test_vector_index_restricts_to_candidates():
    idx = VectorIndex(MODEL, DIM)
    idx.add(1, unit(1, 0, 0))
    idx.add(2, unit(0, 1, 0))
    assert [i for i, _ in idx.search(unit(1, 0, 0), 5, candidates={2})] == [2]
    assert idx.search(unit(1, 0, 0), 5, candidates=set()) == []


def test_vector_index_add_replaces_and_remove_drops():
    idx = VectorIndex(MODEL, DIM)
    idx.add(1, unit(1, 0, 0))
    idx.add(1, unit(0, 1, 0))
    assert idx.size == 1
    np.testing.assert_allclose(idx.vector_for(1)[:3], [0, 1, 0], atol=1e-6)

    idx.add(2, unit(0, 0, 1))
    idx.remove([1])
    assert idx.size == 1 and idx.vector_for(1) is None
    assert idx.vector_for(2) is not None


def test_vector_index_rejects_a_foreign_dimension():
    idx = VectorIndex(MODEL, DIM)
    with pytest.raises(ValueError):
        idx.add(1, np.ones(1024, dtype=np.float32))


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

def test_type_filter_sql():
    where, args = build_filter_sql(SearchParams(types=["Screenshot"]))
    assert "is_screenshot = 1" in where
    where, _ = build_filter_sql(SearchParams(types=["Photo"]))
    assert "is_screenshot = 0" in where
    # Both selected is the same as neither.
    where, _ = build_filter_sql(SearchParams(types=["Photo", "Screenshot"]))
    assert where == ""


def test_dims_filter_sql():
    where, args = build_filter_sql(SearchParams(dims="large"))
    assert ">= ?" in where and args == [2500]
    where, args = build_filter_sql(SearchParams(dims="small"))
    assert "< ?" in where and args == [2500]


def test_candidate_ids_by_folder(app_state, library):
    ids = candidate_ids(app_state.store, SearchParams(folders=[str(library / "shots")]))
    assert ids is not None and len(ids) == 3
    for image_id in ids:
        assert "shots" in app_state.store.image_by_id(image_id)["path"]


def test_folder_filter_matches_a_watched_root_and_its_subtree(app_state, library):
    """The sidebar checkboxes carry watched roots from listFolders(), and no
    image sits directly in one — matching the dirname alone would find nothing."""
    ids = candidate_ids(app_state.store, SearchParams(folders=[str(library)]))
    assert ids is not None and len(ids) == 10


def test_folder_filter_accepts_several_folders(app_state, library):
    ids = candidate_ids(
        app_state.store,
        SearchParams(folders=[str(library / "shots"), str(library / "photos")]),
    )
    assert len(ids) == 10


def test_folder_filter_does_not_match_a_sibling_prefix(app_state, library, tmp_path):
    """~/Pictures must not sweep in ~/Pictures-old."""
    sibling = library.parent / (library.name + "-old")
    make_image(sibling / "photos" / "stray.jpg", COLORS["red"], seed=77)
    app_state.indexer.scan([(sibling, True)], prune=False)

    ids = candidate_ids(app_state.store, SearchParams(folders=[str(library)]))
    assert len(ids) == 10
    assert app_state.store.image_count() == 11


def test_folder_filter_escapes_like_wildcards(app_state, library):
    """`_` and `%` are legal in directory names and must not act as wildcards."""
    odd = library.parent / "a_b"
    twin = library.parent / "axb"
    make_image(odd / "one.jpg", COLORS["red"], seed=81)
    make_image(twin / "two.jpg", COLORS["red"], seed=82)
    app_state.indexer.scan([(odd, True), (twin, True)], prune=False)

    ids = candidate_ids(app_state.store, SearchParams(folders=[str(odd)]))
    assert len(ids) == 1
    found = app_state.store.image_by_id(next(iter(ids)))["path"]
    assert found.endswith(os.path.join("a_b", "one.jpg"))


def test_candidate_ids_by_type(app_state):
    shots = candidate_ids(app_state.store, SearchParams(types=["Screenshot"]))
    assert len(shots) == 3  # the 1920x1080 blues
    photos = candidate_ids(app_state.store, SearchParams(types=["Photo"]))
    assert len(photos) == 7


def test_candidate_ids_by_dims(app_state):
    large = candidate_ids(app_state.store, SearchParams(dims="large"))
    assert len(large) == 3  # the 3000x2000 greens


def test_no_filters_means_no_restriction(app_state):
    assert candidate_ids(app_state.store, SearchParams()) is None


# ---------------------------------------------------------------------------
# Searcher
# ---------------------------------------------------------------------------

def test_query_ranks_the_matching_colour_first(app_state):
    res = app_state.searcher.search(SearchParams(q="a blue image"))
    assert res["items"]
    top = res["items"][0]
    assert "blue" in top["filename"]
    assert top["score"] > res["items"][-1]["score"]


def test_browsing_omits_score_entirely(app_state):
    """types.ts declares `score?: number` — absent, never null."""
    res = app_state.searcher.search(SearchParams(q=""))
    assert res["total"] == 10
    assert all("score" not in item for item in res["items"])


def test_search_includes_score(app_state):
    res = app_state.searcher.search(SearchParams(q="red"))
    assert all(isinstance(item["score"], float) for item in res["items"])


def test_filters_apply_to_a_text_query(app_state):
    res = app_state.searcher.search(SearchParams(q="red", types=["Screenshot"]))
    assert all(item["isScreenshot"] for item in res["items"])
    assert len(res["items"]) == 3


def test_pagination_walks_the_cursor(app_state):
    first = app_state.searcher.search(SearchParams(q="", limit=4))
    assert len(first["items"]) == 4
    assert first["cursor"] == "4"

    second = app_state.searcher.search(SearchParams(q="", limit=4, cursor=first["cursor"]))
    assert len(second["items"]) == 4
    assert second["cursor"] == "8"

    third = app_state.searcher.search(SearchParams(q="", limit=4, cursor=second["cursor"]))
    assert len(third["items"]) == 2
    assert third["cursor"] is None

    seen = [i["id"] for page in (first, second, third) for i in page["items"]]
    assert len(set(seen)) == 10


def test_similar_uses_cosine_and_excludes_the_subject(app_state):
    blue = [
        i for i in app_state.searcher.search(SearchParams(q=""))["items"]
        if "blue" in i["filename"]
    ][0]
    res = app_state.searcher.similar(blue["id"])
    assert blue["id"] not in [i["id"] for i in res["items"]]
    assert "blue" in res["items"][0]["filename"]


def test_exact_duplicates_are_flagged(app_state, library):
    """A byte copy is always a duplicate, and `view=dupes` shows exactly the
    flagged set.

    Every same-coloured fixture is *already* a pHash duplicate of its siblings —
    `make_image`'s corner block is 32 px wide and disappears entirely when pHash
    downscales to 32x32, so all four reds hash identically. That is the correct
    answer for near-identical images and it is why this asserts the copy joins
    red_0 rather than asserting the copy is the only duplicate in the library.
    """
    copy = library / "photos" / "red_copy.jpg"
    # A byte copy, not a re-encode: exact duplicates are a sha256 match.
    shutil.copyfile(library / "photos" / "red_0.jpg", copy)
    app_state.indexer.scan([(library, True)])

    res = app_state.searcher.search(SearchParams(q=""))
    dupes = [i for i in res["items"] if i["isDupe"]]
    stems = {Path(i["filename"]).stem for i in dupes}
    assert {"red_0", "red_copy"} <= stems

    by_id = {i["id"]: Path(i["filename"]).stem for i in res["items"]}
    copy_id = next(i for i, stem in by_id.items() if stem == "red_copy")
    group = next(g for g in app_state.searcher.dupes.groups if copy_id in g)
    assert "red_0" in {by_id[i] for i in group}
    # Different colours are 16 apart — past the threshold, so they stay out.
    assert not {by_id[i] for i in group} & {"blue_0", "green_0"}

    only_dupes = app_state.searcher.search(SearchParams(q="", view="dupes"))
    assert {i["id"] for i in only_dupes["items"]} == {i["id"] for i in dupes}


# ---------------------------------------------------------------------------
# Wire contract
# ---------------------------------------------------------------------------

def photo_keys_from_types_ts() -> set[str]:
    text = TYPES_TS.read_text(encoding="utf-8")
    block = text.split("export interface Photo{", 1)[1].split("}", 1)[0]
    block = re.sub(r"/\*.*?\*/", "", block, flags=re.S)
    block = re.sub(r"//.*", "", block)
    return set(re.findall(r"^\s*(\w+)\??:", block, flags=re.M))


def test_item_keys_match_types_ts(app_state):
    expected = photo_keys_from_types_ts()
    assert "score" in expected

    item = app_state.searcher.search(SearchParams(q="red"))["items"][0]
    assert set(item) == expected

    browsing = app_state.searcher.search(SearchParams(q=""))["items"][0]
    assert set(browsing) == expected - {"score"}


def test_ocr_fields_are_present_and_null_without_text(app_state):
    # Present-and-null, never absent: the frontend tells "no OCR" from "field
    # missing", and a blanket exclude_none would delete both.
    item = app_state.searcher.search(SearchParams(q=""))["items"][0]
    assert item["hasOcr"] is False
    assert item["ocrText"] is None
    assert item["snippet"] is None


def test_envelope_shape(app_state):
    res = app_state.searcher.search(SearchParams(q=""))
    assert set(res) == {"items", "total", "tookMs", "cursor"}
    assert isinstance(res["tookMs"], float)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def test_every_route_requires_the_token(app_state):
    bare = TestClient(create_app(app_state))
    for method, path in (
        ("get", "/health"), ("get", "/search?q=red"), ("get", "/folders"),
        ("get", "/settings"), ("get", "/storage"), ("get", "/images/1"),
        ("get", "/thumb/1"), ("get", "/file/1"), ("get", "/events"),
    ):
        res = getattr(bare, method)(path)
        assert res.status_code == 401, f"{path} answered {res.status_code} without a token"


def test_a_wrong_token_is_rejected(app_state):
    bare = TestClient(create_app(app_state))
    res = bare.get("/search", headers={TOKEN_HEADER: "not-the-token"})
    assert res.status_code == 401


def test_search_over_http(client):
    res = client.get("/search", params={"q": "blue", "limit": 5})
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"items", "total", "tookMs", "cursor"}
    assert "blue" in body["items"][0]["filename"]


def test_repeated_filter_params_over_http(client, app_state, library):
    res = client.get(
        "/search",
        params=[("q", ""), ("type", "Screenshot"), ("folder", str(library / "shots"))],
    )
    assert res.status_code == 200
    assert len(res.json()["items"]) == 3


def test_similar_accepts_the_snake_case_body_api_ts_sends(client):
    first = client.get("/search", params={"q": ""}).json()["items"][0]
    res = client.post("/search/similar", json={"image_id": first["id"]})
    assert res.status_code == 200
    assert first["id"] not in [i["id"] for i in res.json()["items"]]


def test_a_non_ascii_token_is_a_401_not_a_500(app_state):
    bare = TestClient(create_app(app_state))
    assert bare.get("/health", headers={TOKEN_HEADER: "tökén".encode("latin-1")}).status_code == 401
    assert bare.get("/thumb/1", params={"t": "tökén"}).status_code == 401


def test_thumb_accepts_the_token_as_a_query_param(client, app_state):
    """`<img src>` cannot set headers, so ?t= has to work."""
    image_id = client.get("/search", params={"q": ""}).json()["items"][0]["id"]
    bare = TestClient(create_app(app_state))

    res = bare.get(f"/thumb/{image_id}", params={"size": 256, "t": app_state.token})
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/webp"

    assert bare.get(f"/thumb/{image_id}", params={"size": 256}).status_code == 401
    assert bare.get(f"/thumb/{image_id}", params={"size": 256, "t": "wrong"}).status_code == 401


def test_thumb_rejects_an_unknown_size(client):
    image_id = client.get("/search", params={"q": ""}).json()["items"][0]["id"]
    assert client.get(f"/thumb/{image_id}", params={"size": 1024}).status_code == 400


def test_file_serves_the_original(client):
    image_id = client.get("/search", params={"q": ""}).json()["items"][0]["id"]
    res = client.get(f"/file/{image_id}")
    assert res.status_code == 200
    assert res.headers["content-type"] in ("image/jpeg", "image/png")


def test_image_detail_carries_ocr_text(client, app_state):
    image_id = client.get("/search", params={"q": ""}).json()["items"][0]["id"]
    app_state.store.put_ocr(image_id, "rapidocr", "tur+eng", "build failed")

    body = client.get(f"/images/{image_id}").json()
    assert body["hasOcr"] is True
    assert body["ocrText"] == "build failed"


def test_folders_crud_over_http(client, tmp_path, library):
    listed = client.get("/folders").json()
    assert listed[0]["path"] == str(library)
    assert listed[0]["count"] == 10
    assert listed[0]["recursive"] is True

    assert client.post("/folders", json=None).json() is None

    other = tmp_path / "other"
    other.mkdir()
    added = client.post("/folders", json={"path": str(other), "recursive": False}).json()
    assert added["path"] == str(other)
    assert added["recursive"] is False

    assert client.patch("/folders", json={"path": str(other), "recursive": True}).status_code == 200
    assert client.request("DELETE", "/folders", params={"path": str(other)}).status_code == 200
    assert [f["path"] for f in client.get("/folders").json()] == [str(library)]


def test_adding_a_missing_folder_is_a_400(client, tmp_path):
    res = client.post("/folders", json={"path": str(tmp_path / "nope")})
    assert res.status_code == 400


def test_health_reports_the_active_model(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["modelId"] == MODEL
    assert body["images"] == 10
    assert body["vectors"] == 10


def test_storage_reports_usage(client):
    body = client.get("/storage").json()
    assert set(body) == {"thumbnailCacheGb", "indexGb"}
    assert body["thumbnailCacheGb"] >= 0
    assert client.request("DELETE", "/storage/thumbnails").status_code == 200
    assert client.get("/storage").json()["thumbnailCacheGb"] == 0


def test_settings_round_trip_over_http(client):
    body = client.get("/settings").json()
    assert body["modelId"] == MODEL
    assert body["ocrLangs"] == ["en", "tr"]

    updated = client.put("/settings", json={"theme": "light", "density": 2}).json()
    assert updated["theme"] == "light"
    assert updated["density"] == 2
    assert client.get("/settings").json()["theme"] == "light"


def test_appearance_settings_survive_a_restart(client):
    """The sidecar never reads these — config.toml is simply the only thing
    that outlives the window, and an interface scale the user has to set again
    on every launch is not an accessibility setting."""
    updated = client.put("/settings", json={
        "fontId": "fira-code", "uiScale": 150, "reduceMotion": True, "highContrast": True,
    }).json()
    assert updated["uiScale"] == 150
    assert updated["fontId"] == "fira-code"

    reread = client.get("/settings").json()
    assert reread["reduceMotion"] is True
    assert reread["highContrast"] is True
    assert reread["uiScale"] == 150


def test_settings_rejects_an_unknown_model(client):
    res = client.put("/settings", json={"modelId": "clip-vit-nope"})
    assert res.status_code == 400
    assert client.get("/settings").json()["modelId"] == MODEL


def test_deleting_images_drops_rows_and_vectors(client, app_state, monkeypatch):
    # The route moves the file to the real trash; here it only has to unlink.
    monkeypatch.setattr(system, "move_to_trash", lambda path: Path(path).unlink())
    items = client.get("/search", params={"q": ""}).json()["items"]
    victim = items[0]["id"]

    res = client.request("DELETE", "/images", json={"ids": [victim]})
    assert res.json() == {"removed": 1, "failed": []}
    assert app_state.vectors.size == 9
    assert victim not in [i["id"] for i in client.get("/search", params={"q": ""}).json()["items"]]


def test_new_ingest_appends_to_the_live_vector_index(app_state, library):
    before = app_state.vectors.size
    make_image(library / "photos" / "red_new.jpg", COLORS["red"])
    app_state.indexer.scan([(library, True)])
    assert app_state.vectors.size == before + 1


def test_rescan_starts_a_background_pass(client, app_state):
    assert client.post("/rescan").json() == {"started": True}
    app_state.indexer.join(timeout=60)


def test_event_bus_fans_out_to_subscribers(app_state):
    """/events itself is covered end-to-end in test_server_live.py — TestClient
    buffers streaming responses, so this exercises the bus directly."""
    import asyncio

    async def exercise():
        app_state.events.bind(asyncio.get_running_loop())
        q = app_state.events.subscribe()
        app_state.events.publish("index", {"current": 1, "total": 2})
        await asyncio.sleep(0)
        event = await asyncio.wait_for(q.get(), timeout=2.0)
        assert event == {"type": "index", "current": 1, "total": 2}

        app_state.events.unsubscribe(q)
        app_state.events.publish("index", {"current": 2, "total": 2})
        await asyncio.sleep(0)
        assert q.empty()

    asyncio.run(exercise())
    assert app_state.events.last["index"]["current"] == 2


def test_indexer_progress_reaches_the_bus(app_state, library):
    make_image(library / "photos" / "red_evt.jpg", COLORS["red"], seed=99)
    app_state.indexer.scan([(library, True)])
    assert app_state.events.last["scan-complete"]["ingested"] == 1


def test_searcher_survives_an_empty_index(xdg_tmp):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
    res = state.searcher.search(SearchParams(q="red"))
    assert res == {"items": [], "total": 0, "tookMs": res["tookMs"], "cursor": None}


def test_indexer_and_searcher_share_the_store(xdg_tmp, library):
    store = Store()
    embedder = ColorEmbedder()
    vectors = VectorIndex(MODEL, DIM)
    indexer = Indexer(store, embedder, on_vector=vectors.add)
    indexer.scan([(library, True)])

    searcher = Searcher(store, vectors, embedder)
    assert vectors.size == 10
    assert searcher.search(SearchParams(q="green"))["items"][0]["filename"].startswith("green")


# ---------------------------------------------------------------------------
# Text leg: FTS5 over OCR, and its fusion with the vector leg
# ---------------------------------------------------------------------------

def shot_ids(app_state) -> list[int]:
    """The three 1920x1080 blue fixtures, which the heuristic calls screenshots."""
    return [
        int(r["id"])
        for r in app_state.store.conn().execute(
            "SELECT id FROM images WHERE is_screenshot = 1 ORDER BY id"
        )
    ]


def test_fts_match_query_quotes_every_token():
    assert fts_match_query("build failed") == '"build" "failed"'


def test_fts_match_query_is_none_when_there_are_no_words():
    assert fts_match_query("   ") is None
    assert fts_match_query("-- ** ?") is None


def test_fts_match_query_defuses_fts5_syntax():
    # A photo search is never a query language. `*`, `-`, `OR` and a stray quote
    # must reach SQLite as literal terms, not as operators.
    assert fts_match_query('build* OR -failed "x"') == '"build" "OR" "failed" "x"'


def test_fts_match_query_keeps_turkish_words_whole():
    assert fts_match_query("masaüstü görüntüsü") == '"masaüstü" "görüntüsü"'


def test_fts_search_ranks_matches_and_returns_a_snippet(app_state):
    hit, miss, _rest = shot_ids(app_state)
    app_state.store.put_ocr(hit, "fake", "eng", "ERROR: the build failed after 3 minutes")
    app_state.store.put_ocr(miss, "fake", "eng", "a note about gardening")

    ids, snippets = fts_search(app_state.store, "build failed")
    assert ids == [hit]
    assert "build" in snippets[hit]


def test_fts_search_respects_the_candidate_set(app_state):
    first, second, _rest = shot_ids(app_state)
    for image_id in (first, second):
        app_state.store.put_ocr(image_id, "fake", "eng", "build failed")

    # Without this the folder/type/date filters silently stop applying to text
    # hits, and no assertion about the vector leg would ever catch it.
    ids, _snippets = fts_search(app_state.store, "build failed", candidates={second})
    assert ids == [second]


def test_fts_search_degrades_to_empty_on_a_match_sqlite_rejects(app_state, monkeypatch):
    import picsearch.search as search_mod

    app_state.store.put_ocr(shot_ids(app_state)[0], "fake", "eng", "build failed")
    monkeypatch.setattr(search_mod, "fts_match_query", lambda q: 'NEAR("a"')
    # A bad query is a bad query, not a 500 — the vector leg still answers it.
    assert fts_search(app_state.store, "anything") == ([], {})


def test_a_screenshot_is_retrievable_by_the_text_in_it(app_state):
    target = shot_ids(app_state)[0]
    app_state.store.put_ocr(target, "fake", "eng", "ERROR: build failed\nnpm run tauri dev")

    res = app_state.searcher.search(SearchParams(q="build failed"))
    top = res["items"][0]
    assert top["id"] == target
    assert top["hasOcr"] is True
    assert top["ocrText"].startswith("ERROR")
    assert "build" in top["snippet"]


def test_an_unrelated_phrase_does_not_surface_it(app_state):
    target = shot_ids(app_state)[0]
    app_state.store.put_ocr(target, "fake", "eng", "ERROR: build failed\nnpm run tauri dev")

    # The vector leg ranks every image for every query, so the assertion that
    # means something is about *rank*, not membership.
    top = app_state.searcher.search(SearchParams(q="red"))["items"][:3]
    assert all(item["filename"].startswith("red") for item in top)
    assert target not in [item["id"] for item in top]


def test_a_text_hit_outranks_a_better_visual_match(app_state):
    """The reason fusion is RRF and not a weighted sum.

    A blue screenshot with the word "red" in it beats a perfectly red photo,
    because rank 1 in the text list is worth more than rank 1 in only one list —
    and cosine 0.99 versus BM25 -4.2 could never have been compared directly.
    """
    target = shot_ids(app_state)[0]
    app_state.store.put_ocr(target, "fake", "eng", "the red banner at the top")

    res = app_state.searcher.search(SearchParams(q="red"))
    assert res["items"][0]["id"] == target
    assert res["items"][1]["filename"].startswith("red")


def test_scores_are_rrf_not_cosine(app_state):
    # The colour embedder returns cosine 1.0 for an exact match; RRF at rank 1
    # of one list is 1/61. Any weighted sum of the two would sit between them.
    res = app_state.searcher.search(SearchParams(q="red"))
    assert 0.0 < res["items"][0]["score"] < 0.05


def test_text_matches_still_respect_the_filters(app_state):
    target = shot_ids(app_state)[0]
    app_state.store.put_ocr(target, "fake", "eng", "build failed")

    res = app_state.searcher.search(SearchParams(q="build failed", types=["Photo"]))
    assert target not in [item["id"] for item in res["items"]]


def test_an_empty_ocr_row_is_not_has_ocr(app_state):
    target = shot_ids(app_state)[0]
    app_state.store.put_ocr(target, "fake", "eng", "")

    item = next(
        i for i in app_state.searcher.search(SearchParams(q=""))["items"] if i["id"] == target
    )
    # The row is the "OCR ran, found nothing" marker. It must not light up the
    # TEXT badge or render an empty quote in the lightbox.
    assert item["hasOcr"] is False
    assert item["ocrText"] is None


def test_an_unavailable_ocr_engine_is_still_persisted(client, app_state):
    body = client.put("/settings", json={"ocrEngineId": "easyocr"}).json()
    app_state.indexer.join(timeout=60)
    # The preference is the user's; what actually runs is whatever is installed.
    assert body["ocrEngineId"] == "easyocr"
    assert client.get("/health").json()["ocrEngine"] != "easyocr"


# ---------------------------------------------------------------------------
# Stability on a big library
# ---------------------------------------------------------------------------

def test_a_filter_matching_more_rows_than_sqlite_has_variables_still_browses(app_state):
    """The id set was bound one `?` per id: past SQLITE_MAX_VARIABLE_NUMBER
    (32766 in the CPython that ships with the app) every filtered browse, and
    the timeline, answered 500. The limit is lowered here instead of indexing
    30,000 photos."""
    import sqlite3

    app_state.store.conn().setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 5)
    params = SearchParams(q="", types=["Photo"], limit=3)
    res = app_state.searcher.search(params)
    assert res["total"] == 7
    assert len(res["items"]) == 3
    assert app_state.searcher.timeline(params)["buckets"]


def test_a_vector_without_a_row_does_not_repeat_items_on_the_next_page(app_state):
    """`hydrate` drops an id whose row is gone, and the cursor was advanced by
    the survivors only — so the next page began inside the previous one."""
    app_state.vectors.add(99999, unit(1, 0, 0))     # ranks first, has no row
    seen: list[int] = []
    cursor = None
    for _ in range(20):
        page = app_state.searcher.search(SearchParams(q="red", limit=2, cursor=cursor))
        seen += [i["id"] for i in page["items"]]
        cursor = page["cursor"]
        if(cursor is None):
            break
    assert len(seen) == len(set(seen))


def test_deleting_a_row_removes_its_vector(app_state):
    """`forget_paths` and `_prune_missing` removed rows and left the vectors, so
    search kept ranking photos that no longer existed."""
    row = app_state.store.conn().execute("SELECT id, path FROM images LIMIT 1").fetchone()
    before = app_state.vectors.size
    Path(row["path"]).unlink()
    assert app_state.indexer.forget_paths([Path(row["path"])]) == 1
    assert app_state.vectors.size == before - 1
    assert app_state.vectors.vector_for(row["id"]) is None


def test_a_rename_over_another_image_removes_the_displaced_vector(app_state):
    ids = [r["id"] for r in app_state.store.conn().execute("SELECT id FROM images LIMIT 2")]
    a, b = (app_state.store.image_by_id(i)["path"] for i in ids)
    before = app_state.vectors.size
    app_state.store.move_image(a, b)
    assert app_state.vectors.size == before - 1
    assert app_state.vectors.vector_for(ids[1]) is None


def test_vector_index_grows_in_place_and_stays_consistent():
    idx = VectorIndex(MODEL, DIM)
    for n in range(1, 700):
        idx.add(n, unit(1, n % 7, 0))
    assert idx.size == 699
    assert idx.matrix.shape == (699, DIM)
    assert idx.ids.tolist() == list(range(1, 700))
    idx.remove([1, 350, 699])
    assert idx.size == 696
    assert idx.vector_for(350) is None
    assert idx.vector_for(2) is not None
    idx.add(5000, unit(0, 0, 1))
    assert idx.search(unit(0, 0, 1), 1)[0][0] == 5000
    idx.add(2, unit(0, 0, 1))                       # re-adding replaces, never appends
    assert idx.size == 697


def test_a_text_query_under_a_filter_is_not_cut_to_the_global_top_500(store: Store):
    """With more than 900 candidates the text leg took the global top `limit` and
    filtered afterwards, so a word common outside the filter hid its matches
    inside it."""
    rows = []
    for i in range(1, 2101):
        rows.append((
            i, f"/lib/{i}.png", 1.0, 1, 1, 1, "image/png", 1, f"{i:064d}", None, 0,
            "2026-01-01T00:00:00", None, "",
        ))
    store.conn().executemany("INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    store.conn().commit()
    # Ids 1..1000 are outside the filter and repeat the word more, so they win BM25.
    for i in range(1, 2101):
        store.put_ocr(i, "tesseract", "eng", "build " * (5 if i <= 1000 else 1) + "failed")
    inside = set(range(1001, 2101))
    ids, _ = fts_search(store, "build", inside, limit=50)
    assert len(ids) == 50 and set(ids) <= inside
