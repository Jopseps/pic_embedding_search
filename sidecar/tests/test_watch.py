"""The folder watcher.

Almost everything here drives `FolderWatcher`'s intake and `flush()` directly
rather than through a real observer. Filesystem event delivery is the least
deterministic thing that could go into this suite — inotify coalesces, macOS
batches, and a CI box under load does neither on schedule. One integration test
at the bottom runs a real `Observer` with a generous timeout; the rest are
exact.

Two assertions carry the design:

`test_a_watched_file_survives_the_next_scan` — the watcher must only accept
files a scan would have walked. If it accepts more, `_prune_missing` deletes
them on the next rescan and images appear, then vanish an hour later.

`test_a_move_costs_no_gpu` — the reason moves are tracked at all. A rename that
re-embeds is a rename that was not worth special-casing.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from picsearch import paths
from picsearch.dupes import DupeIndex
from picsearch.index import Indexer, indexable_under
from picsearch.store import Store
from picsearch.watch import FolderWatcher

DIM = 8


class FakeEmbedder:
    model_id = "siglip2-base-patch16-224"
    dim = DIM

    def __init__(self):
        self.embedded = 0

    def embed_pil(self, images, batch_size: int = 32) -> np.ndarray:
        self.embedded += len(images)
        return np.tile(np.eye(1, DIM, dtype=np.float32), (len(images), 1))


def make_photo(path: Path, size=(640, 480), color=(80, 130, 190)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, color)
    img.paste((240, 90, 30), (10, 10, 60, 60))
    img.save(path)
    return path


@pytest.fixture()
def watched(xdg_tmp, tmp_path):
    """A store with one recursive watched folder, an indexer, and a watcher."""
    root = tmp_path / "library"
    root.mkdir()
    store = Store()
    store.add_folder(str(root), recursive=True)
    embedder = FakeEmbedder()
    indexer = Indexer(store, embedder)
    watcher = FolderWatcher(store, indexer, debounce=0.0, max_wait=0.0)
    watcher.sync()
    yield watcher, root, store, indexer, embedder
    store.close()


# -- the shared accept rule -------------------------------------------------

def test_indexable_under_matches_a_recursive_walk(tmp_path):
    root = tmp_path / "lib"
    assert indexable_under(root / "a.jpg", root, True)
    assert indexable_under(root / "sub" / "a.png", root, True)


def test_a_non_recursive_folder_stops_at_its_own_level(tmp_path):
    root = tmp_path / "lib"
    assert indexable_under(root / "a.jpg", root, False)
    assert not indexable_under(root / "sub" / "a.jpg", root, False)


def test_dotdirs_and_dotfiles_are_not_indexable(tmp_path):
    root = tmp_path / "lib"
    assert not indexable_under(root / ".cache" / "a.jpg", root, True)
    assert not indexable_under(root / ".secret.jpg", root, True)


def test_unsupported_files_and_outsiders_are_not_indexable(tmp_path):
    root = tmp_path / "lib"
    assert not indexable_under(root / "notes.txt", root, True)
    assert not indexable_under(tmp_path / "elsewhere" / "a.jpg", root, True)


def test_the_thumbnail_cache_is_never_indexable(xdg_tmp):
    # Writing a thumbnail is itself an event. Watching the folder that holds
    # the cache would otherwise ingest its own output in a loop.
    thumbs = paths.thumbs_dir()
    data = paths.data_dir()
    (thumbs / "ab").mkdir(parents=True, exist_ok=True)
    victim = thumbs / "ab" / "deadbeef_256.webp"
    victim.write_bytes(b"")
    assert not indexable_under(victim, data, True)


# -- intake -----------------------------------------------------------------

def test_only_files_under_a_watched_root_are_queued(watched, tmp_path):
    watcher, root, _store, _indexer, _embedder = watched
    watcher.touch(root / "a.jpg")
    watcher.touch(tmp_path / "outside" / "b.jpg")
    watcher.touch(root / "notes.txt")
    assert watcher.pending() == 1


def test_a_delete_cancels_a_pending_ingest(watched):
    watcher, root, *_ = watched
    watcher.touch(root / "a.jpg")
    watcher.remove(root / "a.jpg")
    assert watcher.pending() == 1
    watcher.flush()  # must not try to ingest a file that is gone


# -- debounce ---------------------------------------------------------------

def test_a_burst_waits_for_quiet(xdg_tmp, tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    store = Store()
    store.add_folder(str(root), recursive=True)
    watcher = FolderWatcher(store, Indexer(store, FakeEmbedder()), debounce=2.0, max_wait=30.0)
    watcher.sync()

    start = time.monotonic()
    watcher.touch(root / "a.jpg")
    assert not watcher.due(start + 1.0)
    assert watcher.due(start + 2.5)
    store.close()


def test_a_folder_that_never_goes_quiet_still_flushes(xdg_tmp, tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    store = Store()
    store.add_folder(str(root), recursive=True)
    watcher = FolderWatcher(store, Indexer(store, FakeEmbedder()), debounce=2.0, max_wait=5.0)
    watcher.sync()

    start = time.monotonic()
    watcher.touch(root / "a.jpg")
    # A screen recorder or a sync client writes continuously; without the
    # ceiling the quiet window never arrives and nothing is ever indexed.
    for _ in range(10):
        watcher.touch(root / "a.jpg")
    assert watcher.due(start + 6.0)
    store.close()


def test_nothing_pending_is_never_due(watched):
    watcher, *_ = watched
    assert not watcher.due()


# -- ingest ------------------------------------------------------------------

def test_a_new_file_is_indexed_on_flush(watched):
    watcher, root, store, _indexer, embedder = watched
    make_photo(root / "new.jpg")
    watcher.touch(root / "new.jpg")
    ingested, _forgotten, _moved = watcher.flush()
    assert ingested == 1
    assert store.image_by_path(str(root / "new.jpg")) is not None
    assert embedder.embedded == 1


def test_a_watched_file_survives_the_next_scan(watched):
    # The watcher's accept rule and walk_images must agree. If the watcher is
    # looser, _prune_missing deletes what it ingested on the next rescan.
    watcher, root, store, indexer, _embedder = watched
    make_photo(root / "sub" / "deep.png")
    watcher.touch(root / "sub" / "deep.png")
    watcher.flush()
    image_id = store.image_by_path(str(root / "sub" / "deep.png"))["id"]

    report = indexer.scan()
    row = store.image_by_path(str(root / "sub" / "deep.png"))
    assert row is not None and row["id"] == image_id
    assert report.removed == 0


def test_a_second_flush_of_an_unchanged_file_costs_no_gpu(watched):
    watcher, root, _store, _indexer, embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    watcher.flush()
    watcher.touch(root / "a.jpg")
    watcher.flush()
    # Editors and sync clients emit modify storms on files nobody changed.
    assert embedder.embedded == 1


def test_paths_are_kept_when_the_ingest_slot_is_busy(watched):
    watcher, root, store, indexer, _embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    indexer.status.running = True  # a scan is under way

    ingested, _forgotten, _moved = watcher.flush()
    assert ingested == 0
    assert store.image_by_path(str(root / "a.jpg")) is None
    # Dropping them would lose the image until someone rescans by hand.
    assert watcher.pending() == 1
    assert watcher.due()

    indexer.status.running = False
    assert watcher.flush()[0] == 1


# -- deletes -----------------------------------------------------------------

def test_a_deleted_file_leaves_the_index(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    watcher.flush()

    (root / "a.jpg").unlink()
    watcher.remove(root / "a.jpg")
    _ingested, forgotten, _moved = watcher.flush()
    assert forgotten == 1
    assert store.image_by_path(str(root / "a.jpg")) is None


def test_thumbnails_outlive_the_row(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    watcher.flush()
    sha = store.image_by_path(str(root / "a.jpg"))["sha256"]
    thumb = paths.thumb_path(sha, 256)
    assert thumb.exists()

    (root / "a.jpg").unlink()
    watcher.remove(root / "a.jpg")
    watcher.flush()
    # Content-addressed: a duplicate elsewhere still needs it, and a file that
    # comes back costs no re-encode. The cache is a cache.
    assert thumb.exists()


def test_a_file_deleted_and_immediately_recreated_keeps_its_row(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    watcher.flush()

    # Save-by-replace: the delete event arrives, the file is back before flush.
    watcher.remove(root / "a.jpg")
    watcher.flush()
    assert store.image_by_path(str(root / "a.jpg")) is not None


# -- moves -------------------------------------------------------------------

def test_a_move_costs_no_gpu(watched):
    watcher, root, store, indexer, embedder = watched
    make_photo(root / "before.jpg")
    watcher.touch(root / "before.jpg")
    watcher.flush()
    image_id = store.image_by_path(str(root / "before.jpg"))["id"]
    embedded_before = embedder.embedded

    (root / "before.jpg").rename(root / "after.jpg")
    watcher.moved(root / "before.jpg", root / "after.jpg")
    _ingested, _forgotten, moved = watcher.flush()

    assert moved == 1
    assert store.image_by_path(str(root / "before.jpg")) is None
    row = store.image_by_path(str(root / "after.jpg"))
    assert row is not None and row["id"] == image_id
    assert embedder.embedded == embedded_before

    # And the rename must not look like a change to the next scan either: the
    # file kept its mtime and size, so the row is already correct.
    report = indexer.scan()
    assert report.ingested == 0
    assert report.embedded == 0
    assert store.image_by_path(str(root / "after.jpg"))["id"] == image_id


def test_a_move_keeps_the_ocr_text_and_the_vector(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "shot.png", size=(1920, 1080))
    watcher.touch(root / "shot.png")
    watcher.flush()
    image_id = store.image_by_path(str(root / "shot.png"))["id"]
    store.put_ocr(image_id, "tesseract", "eng", "build failed")

    (root / "shot.png").rename(root / "renamed.png")
    watcher.moved(root / "shot.png", root / "renamed.png")
    watcher.flush()

    assert store.get_ocr(image_id) == "build failed"
    assert store.get_embedding(image_id, "siglip2-base-patch16-224") is not None


def test_a_move_onto_an_existing_row_replaces_it(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg", color=(200, 50, 50))
    make_photo(root / "b.jpg", color=(50, 200, 50))
    watcher.touch(root / "a.jpg")
    watcher.touch(root / "b.jpg")
    watcher.flush()
    a_id = store.image_by_path(str(root / "a.jpg"))["id"]

    # replace(), not rename(): the POSIX rename-over that a save-by-replace
    # does. rename() refuses an existing target on Windows.
    (root / "a.jpg").replace(root / "b.jpg")
    watcher.moved(root / "a.jpg", root / "b.jpg")
    watcher.flush()

    # b.jpg was overwritten on disk, so its old row is stale, not a duplicate.
    assert store.image_by_path(str(root / "a.jpg")) is None
    assert store.image_by_path(str(root / "b.jpg"))["id"] == a_id
    assert store.image_count() == 1


def test_moving_out_of_the_library_removes_it(watched, tmp_path):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg")
    watcher.touch(root / "a.jpg")
    watcher.flush()

    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (root / "a.jpg").rename(outside / "a.jpg")
    watcher.moved(root / "a.jpg", outside / "a.jpg")
    _ingested, forgotten, _moved = watcher.flush()
    assert forgotten == 1
    assert store.image_count() == 0


def test_moving_into_the_library_indexes_it(watched, tmp_path):
    watcher, root, store, _indexer, _embedder = watched
    outside = tmp_path / "elsewhere"
    make_photo(outside / "a.jpg")
    (outside / "a.jpg").rename(root / "a.jpg")
    watcher.moved(outside / "a.jpg", root / "a.jpg")

    assert watcher.flush()[0] == 1
    assert store.image_by_path(str(root / "a.jpg")) is not None


def test_a_move_with_nothing_indexed_at_the_source_is_an_ingest(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "a.jpg")
    (root / "a.jpg").rename(root / "b.jpg")
    # No flush happened in between, so there is no row at the source.
    watcher.moved(root / "a.jpg", root / "b.jpg")
    ingested, _forgotten, moved = watcher.flush()
    assert moved == 0 and ingested == 1
    assert store.image_by_path(str(root / "b.jpg")) is not None


# -- directories -------------------------------------------------------------

def test_a_directory_moved_in_is_walked(watched, tmp_path):
    watcher, root, store, _indexer, _embedder = watched
    album = tmp_path / "album"
    make_photo(album / "one.jpg")
    make_photo(album / "two.jpg")
    album.rename(root / "album")
    # A directory move is one event; the files inside are never reported.
    watcher.move_dir(tmp_path / "album", root / "album")

    assert watcher.flush()[0] == 2
    assert store.image_count() == 2


def test_a_renamed_directory_repoints_its_rows(watched):
    watcher, root, store, _indexer, embedder = watched
    make_photo(root / "trip" / "one.jpg")
    make_photo(root / "trip" / "two.jpg")
    watcher.touch(root / "trip" / "one.jpg")
    watcher.touch(root / "trip" / "two.jpg")
    watcher.flush()
    ids = {row["id"] for row in store.conn().execute("SELECT id FROM images")}
    embedded_before = embedder.embedded

    (root / "trip").rename(root / "holiday")
    watcher.move_dir(root / "trip", root / "holiday")
    watcher.flush()

    after = {row["id"] for row in store.conn().execute("SELECT id FROM images")}
    assert after == ids
    assert embedder.embedded == embedded_before
    assert store.image_by_path(str(root / "holiday" / "one.jpg")) is not None


def test_a_deleted_directory_drops_its_rows(watched):
    watcher, root, store, _indexer, _embedder = watched
    make_photo(root / "trip" / "one.jpg")
    watcher.touch(root / "trip" / "one.jpg")
    watcher.flush()

    (root / "trip" / "one.jpg").unlink()
    (root / "trip").rmdir()
    # Some backends report only the directory, never the files inside it.
    watcher.remove_dir(root / "trip")
    assert watcher.flush()[1] == 1
    assert store.image_count() == 0


def test_a_dotdir_appearing_is_ignored(watched):
    watcher, root, _store, _indexer, _embedder = watched
    make_photo(root / ".thumbnails" / "a.jpg")
    watcher.touch_dir(root / ".thumbnails")
    assert watcher.pending() == 0


# -- observers ---------------------------------------------------------------

def test_sync_skips_folders_that_are_not_on_disk(watched):
    watcher, root, store, _indexer, _embedder = watched
    store.add_folder("/nowhere/at/all", recursive=True)
    roots = watcher.sync()
    assert [str(p) for p, _r in roots] == [str(root)]


def test_sync_follows_the_recursive_flag(watched):
    watcher, root, store, _indexer, _embedder = watched
    store.set_folder_recursive(str(root), False)
    watcher.sync()
    watcher.touch(root / "sub" / "deep.jpg")
    assert watcher.pending() == 0


def test_a_real_observer_picks_up_a_dropped_file(watched):
    """The acceptance criterion, end to end: copy a file in, it appears."""
    watcher, root, store, _indexer, _embedder = watched
    watcher.debounce = 0.2
    watcher.start()
    try:
        make_photo(root / "dropped.jpg")
        deadline = time.monotonic() + 20.0
        while(time.monotonic() < deadline):
            if(store.image_by_path(str(root / "dropped.jpg")) is not None):
                break
            time.sleep(0.2)
    finally:
        watcher.stop()
    assert store.image_by_path(str(root / "dropped.jpg")) is not None


def test_a_watched_deletion_updates_the_duplicate_index(watched):
    """The dupe clustering is cached against `Store.pixel_epoch`, and the
    watcher deletes rows constantly. `forget_paths` routes through
    `store.delete_images`, so the epoch moves and the cache rebuilds — a raw
    DELETE here would leave `isDupe` true for an image whose twin is gone.
    """
    watcher, root, store, _indexer, _embedder = watched
    # Byte-identical copies: same pixels, so the same pHash.
    make_photo(root / "a.jpg")
    shutil.copyfile(root / "a.jpg", root / "b.jpg")
    watcher.touch(root / "a.jpg")
    watcher.touch(root / "b.jpg")
    watcher.flush()

    index = DupeIndex(store)
    assert len(index.ids) == 2

    (root / "b.jpg").unlink()
    watcher.remove(root / "b.jpg")
    watcher.flush()
    assert index.ids == frozenset()
