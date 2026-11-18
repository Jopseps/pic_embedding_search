from pathlib import Path

import numpy as np
import pytest

from picsearch import paths
from picsearch.store import SCHEMA_VERSION, Store, hamming64, phash_from_db, phash_to_db


def make_image(store: Store, path: str = "/photos/a.jpg", **kw) -> int:
    args = dict(
        path=path,
        mtime=1_700_000_000.0,
        size_bytes=2048,
        width=1920,
        height=1080,
        mime="image/jpeg",
        phash=0x0123456789ABCDEF,
        sha256="ab" * 32,
        taken_at="2026-03-14T14:22:00",
        is_screenshot=False,
    )
    args.update(kw)
    return store.upsert_image(**args)


# -- paths ------------------------------------------------------------------

def test_xdg_roots_honour_env_override(xdg_tmp):
    assert paths.data_dir() == xdg_tmp / "data"
    assert paths.config_dir() == xdg_tmp / "config"
    assert paths.db_path() == xdg_tmp / "data" / "index.db"


def test_thumb_path_shards_by_hash_prefix(xdg_tmp):
    sha = "deadbeef" * 8
    p = paths.thumb_path(sha, 256)
    assert p.parent == paths.thumbs_dir() / "de" / "ad"
    assert p.name == f"{sha}_256.webp"


# -- schema -----------------------------------------------------------------

def test_fresh_db_has_schema_and_version(store: Store):
    assert paths.db_path().exists()
    assert store.get_setting("schema_version") == str(SCHEMA_VERSION)
    tables = {
        r["name"]
        for r in store.conn().execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"images", "embeddings", "ocr_text", "watched_folders", "collections"} <= tables


def test_wal_and_foreign_keys_are_on(store: Store):
    assert store.conn().execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert store.conn().execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_reopening_an_existing_db_is_a_no_op(store: Store):
    image_id = make_image(store)
    again = Store()
    assert again.image_by_id(image_id) is not None
    assert again.get_setting("schema_version") == str(SCHEMA_VERSION)
    again.close()


# -- images -----------------------------------------------------------------

def test_image_round_trips(store: Store):
    image_id = make_image(store)
    row = store.image_by_id(image_id)
    assert row["path"] == "/photos/a.jpg"
    assert row["width"] == 1920 and row["height"] == 1080
    assert row["is_screenshot"] == 0
    assert row["indexed_at"]


def test_upsert_on_same_path_replaces_rather_than_duplicates(store: Store):
    first = make_image(store)
    second = make_image(store, mtime=1_700_000_500.0, width=800, height=600)
    assert first == second
    assert store.image_count() == 1
    assert store.image_by_id(first)["width"] == 800


def test_is_unchanged_is_the_ingest_fast_path(store: Store):
    make_image(store)
    assert store.is_unchanged("/photos/a.jpg", 1_700_000_000.0, 2048)
    assert not store.is_unchanged("/photos/a.jpg", 1_700_000_001.0, 2048)
    assert not store.is_unchanged("/photos/a.jpg", 1_700_000_000.0, 4096)
    assert not store.is_unchanged("/photos/missing.jpg", 1_700_000_000.0, 2048)


@pytest.mark.parametrize("value", [0, 1, 2**63 - 1, 2**63, 2**64 - 1, 0xFFFFFFFF00000000])
def test_phash_survives_the_signed_integer_column(store: Store, value: int):
    image_id = make_image(store, phash=value)
    stored = store.image_by_id(image_id)["phash"]
    assert -(2**63) <= stored < 2**63
    assert phash_from_db(stored) == value


def test_hamming_distance_over_wrapped_values(store: Store):
    a = 2**64 - 1
    b = 2**64 - 4
    assert hamming64(a, b) == 2
    assert hamming64(phash_to_db(a) & 0xFFFFFFFFFFFFFFFF, phash_to_db(b) & 0xFFFFFFFFFFFFFFFF) == 2


# -- embeddings -------------------------------------------------------------

def test_embedding_round_trips_as_float32(store: Store):
    image_id = make_image(store)
    vec = np.arange(8, dtype=np.float32)
    vec /= np.linalg.norm(vec)
    store.put_embedding(image_id, "siglip2-base-patch16-224", vec)

    got = store.get_embedding(image_id, "siglip2-base-patch16-224")
    assert got is not None
    assert got.dtype == np.float32
    np.testing.assert_allclose(got, vec, rtol=0, atol=0)


def test_same_image_and_model_replaces_never_duplicates(store: Store):
    """The one mistake in this project that forces a rewrite. Guard it."""
    image_id = make_image(store)
    model = "siglip2-base-patch16-224"
    store.put_embedding(image_id, model, np.ones(4, dtype=np.float32))
    store.put_embedding(image_id, model, np.zeros(4, dtype=np.float32))

    n = store.conn().execute(
        "SELECT count(*) AS n FROM embeddings WHERE image_id=? AND model_id=?", (image_id, model)
    ).fetchone()["n"]
    assert n == 1
    np.testing.assert_allclose(store.get_embedding(image_id, model), np.zeros(4))


def test_two_models_coexist_for_one_image(store: Store):
    image_id = make_image(store)
    store.put_embedding(image_id, "siglip2-base-patch16-224", np.ones(768, dtype=np.float32))
    store.put_embedding(image_id, "jina-clip-v2", np.ones(1024, dtype=np.float32))

    assert store.embedding_count("siglip2-base-patch16-224") == 1
    assert store.embedding_count("jina-clip-v2") == 1
    assert len(store.get_embedding(image_id, "siglip2-base-patch16-224")) == 768
    assert len(store.get_embedding(image_id, "jina-clip-v2")) == 1024

    dims = {r["model_id"]: r["dim"] for r in store.conn().execute(
        "SELECT model_id, dim FROM embeddings WHERE image_id=?", (image_id,)
    )}
    assert dims == {"siglip2-base-patch16-224": 768, "jina-clip-v2": 1024}


def test_images_missing_embedding_drives_the_model_swap_job(store: Store):
    a = make_image(store, path="/photos/a.jpg")
    b = make_image(store, path="/photos/b.jpg")
    store.put_embedding(a, "jina-clip-v2", np.ones(4, dtype=np.float32))

    assert store.images_missing_embedding("jina-clip-v2") == [b]
    assert store.images_missing_embedding("siglip2-base-patch16-224") == [a, b]


def test_deleting_an_image_cascades_to_its_embeddings(store: Store):
    image_id = make_image(store)
    store.put_embedding(image_id, "jina-clip-v2", np.ones(4, dtype=np.float32))
    store.delete_images([image_id])

    assert store.image_count() == 0
    assert store.embedding_count("jina-clip-v2") == 0


# -- OCR + FTS5 -------------------------------------------------------------

def test_ocr_round_trips(store: Store):
    image_id = make_image(store, is_screenshot=True)
    store.put_ocr(image_id, "rapidocr", "tur+eng", "build failed: 3 errors")
    assert store.get_ocr(image_id) == "build failed: 3 errors"
    assert store.ocr_ids() == {image_id}


def test_ocr_triggers_keep_the_external_content_fts_table_in_sync(store: Store):
    """ocr_fts is content='ocr_text'; without the triggers it indexes nothing."""
    image_id = make_image(store, is_screenshot=True)
    store.put_ocr(image_id, "rapidocr", "tur+eng", "build failed on the linker step")

    hits = list(store.conn().execute("SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH 'failed'"))
    assert [int(h["rowid"]) for h in hits] == [image_id]

    miss = list(store.conn().execute("SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH 'kedi'"))
    assert miss == []

    store.put_ocr(image_id, "rapidocr", "tur+eng", "kedi masada oturuyor")
    gone = store.conn().execute("SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH 'failed'")
    assert list(gone) == []
    assert [
        int(h["rowid"])
        for h in store.conn().execute("SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH 'kedi'")
    ] == [image_id]

    store.delete_images([image_id])
    assert list(store.conn().execute("SELECT rowid FROM ocr_fts WHERE ocr_fts MATCH 'kedi'")) == []


# -- folders / settings -----------------------------------------------------

def test_watched_folder_crud(store: Store):
    store.add_folder("/home/u/Pictures", recursive=True)
    store.add_folder("/home/u/Downloads", recursive=False)
    rows = store.list_folders()
    assert [r["path"] for r in rows] == ["/home/u/Downloads", "/home/u/Pictures"]
    assert dict((r["path"], r["recursive"]) for r in rows)["/home/u/Downloads"] == 0

    store.set_folder_recursive("/home/u/Downloads", True)
    assert dict((r["path"], r["recursive"]) for r in store.list_folders())["/home/u/Downloads"] == 1

    store.remove_folder("/home/u/Downloads")
    assert [r["path"] for r in store.list_folders()] == ["/home/u/Pictures"]


def test_folder_count_matches_indexed_images(store: Store):
    # str(Path): stored paths use the platform's separator.
    make_image(store, path=str(Path("/home/u/Pictures/a.jpg")))
    make_image(store, path=str(Path("/home/u/Pictures/sub/b.jpg")))
    make_image(store, path=str(Path("/home/u/Downloads/c.jpg")))
    assert store.folder_count(str(Path("/home/u/Pictures"))) == 2


def test_settings_round_trip(store: Store):
    store.set_setting("model_id", "jina-clip-v2")
    assert store.get_setting("model_id") == "jina-clip-v2"
    store.set_setting("model_id", "siglip2-base-patch16-224")
    assert store.get_setting("model_id") == "siglip2-base-patch16-224"

    store.set_json_setting("ocr_langs", ["en", "tr"])
    assert store.get_json_setting("ocr_langs") == ["en", "tr"]
    assert store.get_json_setting("nope", default=42) == 42


def test_folder_count_does_not_treat_underscore_as_a_wildcard(store: Store):
    # Real paths, not literals: `subtree_prefix` uses the platform separator, and
    # on Windows stored paths read `\\pics\\my_pics\\a.png`.
    make_image(store, str(Path("/pics/my_pics/a.png")))
    make_image(store, str(Path("/pics/my_pics/c.png")), sha256="cd" * 32)
    make_image(store, str(Path("/pics/myXpics/b.png")), sha256="ef" * 32)
    assert store.folder_count(str(Path("/pics/my_pics"))) == 2
