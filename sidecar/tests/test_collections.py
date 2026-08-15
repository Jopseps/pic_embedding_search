"""Collections and saved searches over HTTP.

These are CRUD, so most of the surface is uninteresting. What is not: the
`collection` filter matches by **id**, ids cross the wire as **strings**, and a
saved search carries its whole query rather than just the words — get any of
those wrong and the UI silently shows the wrong photos rather than erroring.
"""

import json

import pytest
from fastapi.testclient import TestClient
from test_search import COLORS, MODEL, ColorEmbedder, make_image

from picsearch.search import SearchParams
from picsearch.server import TOKEN_HEADER, AppState, create_app


@pytest.fixture()
def library(tmp_path):
    root = tmp_path / "lib"
    for i in range(4):
        make_image(root / "photos" / f"red_{i}.jpg", COLORS["red"], seed=i + 1)
    for i in range(3):
        make_image(root / "shots" / f"blue_{i}.png", COLORS["blue"],
                   size=(1920, 1080), seed=i + 40)
    return root


@pytest.fixture()
def app_state(xdg_tmp, library):
    state = AppState(model_id=MODEL, embedder=ColorEmbedder())
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


def ids_of(client, **params):
    return [i["id"] for i in client.get("/search", params=params).json()["items"]]


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

def test_a_collection_round_trips(client):
    made = client.post("/collections", json={"name": "Refs"}).json()
    assert made["name"] == "Refs"
    # types.ts declares `Collection.id` a string; an int here typechecks in
    # Python and breaks strict equality in the sidebar.
    assert isinstance(made["id"], str)
    assert client.get("/collections").json() == [made]


def test_creating_the_same_name_twice_returns_the_same_collection(client):
    first = client.post("/collections", json={"name": "Refs"}).json()
    second = client.post("/collections", json={"name": "Refs"}).json()
    assert first == second
    assert len(client.get("/collections").json()) == 1


def test_a_blank_name_is_rejected(client):
    assert client.post("/collections", json={"name": "   "}).status_code == 400


def test_membership_shows_up_on_the_photo(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})

    items = {i["id"]: i for i in client.get("/search", params={"q": ""}).json()["items"]}
    for image_id in picked:
        # Ids, not names: a rename must not drop membership.
        assert items[image_id]["collections"] == [coll["id"]]
    assert all(i["collections"] == [] for k, i in items.items() if k not in picked)


def test_the_collection_filter_selects_exactly_its_members(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:3]
    added = client.post(f"/collections/{coll['id']}/items", json={"ids": picked}).json()
    assert added == {"added": 3, "count": 3}

    assert sorted(ids_of(client, collection=coll["id"])) == sorted(picked)


def test_adding_the_same_image_twice_is_not_an_error(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})
    again = client.post(f"/collections/{coll['id']}/items", json={"ids": picked}).json()
    assert again == {"added": 0, "count": 2}


def test_removing_membership_leaves_the_image(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})
    client.request("DELETE", f"/collections/{coll['id']}/items", json={"ids": picked[:1]})

    assert ids_of(client, collection=coll["id"]) == picked[1:]
    assert picked[0] in ids_of(client)


def test_renaming_a_collection_keeps_its_members(client):
    """The whole reason the wire carries ids. Matching by name would empty the
    view the user is looking at the moment they rename it."""
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})

    client.patch(f"/collections/{coll['id']}", json={"name": "References"})
    assert sorted(ids_of(client, collection=coll["id"])) == sorted(picked)


def test_deleting_a_collection_leaves_the_images(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})
    before = len(ids_of(client))

    assert client.delete(f"/collections/{coll['id']}").status_code == 200
    assert client.get("/collections").json() == []
    assert len(ids_of(client)) == before
    assert all(i["collections"] == [] for i in client.get("/search").json()["items"])


def test_deleting_an_image_drops_its_membership(client):
    coll = client.post("/collections", json={"name": "Refs"}).json()
    picked = ids_of(client)[:2]
    client.post(f"/collections/{coll['id']}/items", json={"ids": picked})

    client.request("DELETE", "/images", json={"ids": picked[:1]})
    assert client.post(f"/collections/{coll['id']}/items", json={"ids": []}).json() == {
        "added": 0, "count": 1,
    }


def test_an_unknown_collection_is_a_404_not_a_500(client):
    assert client.post("/collections/9999/items", json={"ids": [1]}).status_code == 404
    assert client.delete("/collections/9999").status_code == 404
    assert client.patch("/collections/9999", json={"name": "x"}).status_code == 404


def test_an_unknown_collection_filter_returns_nothing(app_state):
    """Not everything. A view that silently falls back to the whole library is
    the worst possible answer to "show me a collection that is gone"."""
    res = app_state.searcher.search(SearchParams(q="", collection="9999"))
    assert res["items"] == []
    assert app_state.searcher.search(SearchParams(q="", collection="not-a-number"))["items"] == []


def test_collections_need_the_token(app_state):
    bare = TestClient(create_app(app_state))
    assert bare.get("/collections").status_code == 401
    assert bare.post("/collections", json={"name": "x"}).status_code == 401


# ---------------------------------------------------------------------------
# Saved searches
# ---------------------------------------------------------------------------

def test_a_saved_search_carries_its_filters(client):
    made = client.post("/searches", json={
        "query": "masa",
        "view": None,
        "collection": None,
        "filters": {"datePreset": "week", "folders": ["/a"], "types": ["Screenshot"],
                    "dims": "large"},
    }).json()

    assert made["query"] == "masa"
    assert made["filters"]["datePreset"] == "week"
    assert made["filters"]["types"] == ["Screenshot"]
    assert isinstance(made["id"], str)
    assert client.get("/searches").json() == [made]


def test_a_saved_search_with_no_filters_still_has_the_full_shape(client):
    """`Filters` in types.ts has four keys and the store spreads them straight
    into its own state. A missing key would land as `undefined`."""
    made = client.post("/searches", json={"query": "table"}).json()
    assert made["filters"] == {
        "datePreset": None, "folders": [], "types": [], "dims": None,
    }
    assert made["view"] is None
    assert made["collection"] is None


def test_a_blank_query_is_rejected(client):
    assert client.post("/searches", json={"query": "  "}).status_code == 400


def test_saved_searches_delete(client):
    made = client.post("/searches", json={"query": "table"}).json()
    assert client.delete(f"/searches/{made['id']}").status_code == 200
    assert client.get("/searches").json() == []
    assert client.delete(f"/searches/{made['id']}").status_code == 404


def test_corrupt_stored_json_degrades_to_a_plain_query(client, app_state):
    """Hand-edited or truncated JSON must not take the whole sidebar list with
    it — the name column is enough to still run the search."""
    app_state.store.create_saved_search("receipts", "{not json")
    rows = client.get("/searches").json()
    assert rows[0]["query"] == "receipts"
    assert rows[0]["filters"]["folders"] == []


def test_the_stored_row_holds_the_whole_query(app_state):
    app_state.store.create_saved_search("masa", json.dumps({"q": "masa", "view": "recent"}))
    row = app_state.store.list_saved_searches()[0]
    assert json.loads(row["query_json"])["view"] == "recent"
