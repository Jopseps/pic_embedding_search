"""Ingest tests.

These run without a GPU: the Indexer only needs an object with `model_id` and
`embed_pil`, so a fake stands in for the model and every assertion about
scanning, skipping, thumbnails and metadata stays fast and deterministic.

The assertion that matters most is `test_second_scan_embeds_nothing` — the
whole ingest design exists to make a rescan free.
"""

from __future__ import annotations

import os
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from PIL import Image

from picsearch import imaging, paths
from picsearch.index import Indexer, walk_images
from picsearch.ocr import OcrError
from picsearch.store import Store, hamming64, phash_from_db

DIM = 8


class FakeEmbedder:
    """Deterministic stand-in. Counts how many images it was asked to embed."""

    model_id = "siglip2-base-patch16-224"
    dim = DIM

    def __init__(self):
        self.calls = 0
        self.embedded = 0
        self.batch_sizes: list[int] = []

    def embed_pil(self, images, batch_size: int = 32) -> np.ndarray:
        self.calls += 1
        self.embedded += len(images)
        self.batch_sizes.append(len(images))
        out = np.zeros((len(images), DIM), dtype=np.float32)
        for i, img in enumerate(images):
            px = np.asarray(img.resize((4, 2)).convert("L"), dtype=np.float32).ravel()
            out[i] = px / (np.linalg.norm(px) or 1.0)
        return out

    def embed_text(self, text):
        rng = np.random.default_rng(abs(hash(text)) % (2**32))
        v = rng.normal(size=DIM).astype(np.float32)
        return v / np.linalg.norm(v)


def make_photo(path, size=(800, 600), color=(90, 140, 200)):
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, color)
    # A little structure so pHash is not degenerate across fixtures.
    for x in range(0, size[0], 40):
        for y in range(0, size[1], 40):
            if((x // 40 + y // 40 + color[0]) % 2 == 0):
                img.paste((255 - color[0], color[1], 20), (x, y, x + 20, y + 20))
    img.save(path)
    return path


@pytest.fixture()
def library(tmp_path):
    """20 images: 14 photos, 5 screenshot-shaped, 1 in a Screenshots folder."""
    root = tmp_path / "library"
    for i in range(14):
        make_photo(
            root / f"photo_{i:02d}.jpg", size=(800 + i * 10, 600), color=(60 + i * 12, 140, 200)
        )
    for i in range(5):
        make_photo(root / "sub" / f"cap_{i}.png", size=(1920, 1080), color=(30 + i * 30, 90, 160))
    make_photo(root / "Screenshots" / "odd.png", size=(1234, 567), color=(200, 40, 40))
    (root / "notes.txt").write_text("not an image")
    (root / ".hidden").mkdir(exist_ok=True)
    make_photo(root / ".hidden" / "ignored.png", size=(400, 400))
    return root


@pytest.fixture()
def indexer(store: Store):
    return Indexer(store, FakeEmbedder())


# -- walking ----------------------------------------------------------------

def test_walk_finds_images_and_skips_the_rest(library):
    found = list(walk_images(library, recursive=True))
    assert len(found) == 20
    assert all(imaging.is_supported(p) for p in found)
    assert not any(".hidden" in str(p) for p in found)
    assert not any(p.suffix == ".txt" for p in found)


def test_walk_respects_non_recursive(library):
    found = list(walk_images(library, recursive=False))
    assert len(found) == 14
    assert all(p.parent == library for p in found)


# -- first scan -------------------------------------------------------------

def test_first_scan_ingests_everything(indexer: Indexer, store: Store, library):
    report = indexer.scan([(library, True)])
    assert report.scanned == 20
    assert report.ingested == 20
    assert report.skipped == 0
    assert report.errors == []
    assert store.image_count() == 20


def test_every_row_has_real_dimensions(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    rows = list(store.conn().execute("SELECT width, height, mime, sha256, phash FROM images"))
    assert len(rows) == 20
    for r in rows:
        assert r["width"] > 0 and r["height"] > 0
        assert r["mime"].startswith("image/")
        assert len(r["sha256"]) == 64
        assert 0 <= phash_from_db(r["phash"]) < 2**64


def test_thumbnails_land_on_disk_sharded(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    for row in store.conn().execute("SELECT sha256 FROM images"):
        for size in imaging.THUMB_SIZES:
            p = paths.thumb_path(row["sha256"], size)
            assert p.exists(), f"missing {size}px thumbnail"
            assert p.stat().st_size > 0
            with Image.open(p) as img:
                assert img.format == "WEBP"
                assert max(img.size) <= size


def test_embeddings_are_written_for_the_active_model(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    assert store.embedding_count("siglip2-base-patch16-224") == 20
    assert store.images_missing_embedding("siglip2-base-patch16-224") == []


def test_embedding_runs_in_batches(indexer: Indexer, library):
    indexer.scan([(library, True)])
    assert max(indexer.embedder.batch_sizes) <= 32
    assert sum(indexer.embedder.batch_sizes) == 20


# -- the fast path ----------------------------------------------------------

def test_second_scan_embeds_nothing(indexer: Indexer, store: Store, library):
    """Users rescan constantly. A rescan must not touch the GPU."""
    indexer.scan([(library, True)])
    before = indexer.embedder.embedded

    report = indexer.scan([(library, True)])
    assert report.skipped == 20
    assert report.ingested == 0
    assert report.embedded == 0
    assert indexer.embedder.embedded == before
    assert store.image_count() == 20


def test_touching_a_file_reingests_only_that_file(indexer: Indexer, library):
    indexer.scan([(library, True)])
    before = indexer.embedder.embedded

    target = library / "photo_03.jpg"
    make_photo(target, size=(640, 480), color=(10, 200, 10))

    report = indexer.scan([(library, True)])
    assert report.ingested == 1
    assert report.skipped == 19
    assert indexer.embedder.embedded == before + 1


def test_a_deleted_file_is_pruned(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    (library / "photo_00.jpg").unlink()

    report = indexer.scan([(library, True)])
    assert report.removed == 1
    assert store.image_count() == 19
    assert store.embedding_count("siglip2-base-patch16-224") == 19


# -- metadata ---------------------------------------------------------------

def test_screenshot_heuristic(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    shots = {
        r["path"]
        for r in store.conn().execute("SELECT path FROM images WHERE is_screenshot=1")
    }
    assert len([p for p in shots if f"{os.sep}sub{os.sep}" in p]) == 5    # 1920x1080
    assert any(f"Screenshots{os.sep}odd.png" in p for p in shots)          # folder name
    assert not any("photo_" in p for p in shots)


# -- pHash ------------------------------------------------------------------

def blobby(path, size=(600, 400), seed=0):
    """Photo-like: strong, varied low-frequency structure.

    Flat gradients and checkerboards both make bad pHash fixtures — the first
    leaves every DCT coefficient near zero so noise flips bits, the second is
    exactly the high-frequency content JPEG throws away. Upscaled random blocks
    behave like a real photograph, where this hash is bit-exact across
    recompression (verified against ~/Pictures).
    """
    rng = np.random.default_rng(seed)
    coarse = rng.integers(0, 255, size=(6, 9, 3), dtype=np.uint8)
    img = Image.fromarray(coarse).resize(size, Image.Resampling.BICUBIC)
    img.save(path)
    return path


def test_phash_is_stable_under_recompression(tmp_path):
    src = blobby(tmp_path / "a.png")
    with imaging.open_image(src) as img:
        original = imaging.phash(img)
        jpg = tmp_path / "a.jpg"
        img.save(jpg, quality=70)
    with imaging.open_image(jpg) as img2:
        assert hamming64(original, imaging.phash(img2)) <= 4


def test_phash_separates_different_images(tmp_path):
    a = blobby(tmp_path / "a.png", seed=0)
    b = blobby(tmp_path / "b.png", seed=3)
    with imaging.open_image(a) as ia, imaging.open_image(b) as ib:
        assert hamming64(imaging.phash(ia), imaging.phash(ib)) > 4


# -- backfill ---------------------------------------------------------------

def test_embed_missing_backfills_a_new_model(indexer: Indexer, store: Store, library):
    indexer.scan([(library, True)])
    indexer.embedder.model_id = "jina-clip-v2"

    done = indexer.embed_missing()
    assert done == 20
    assert store.embedding_count("jina-clip-v2") == 20
    # Switching back must be instant: the old rows were never deleted.
    assert store.embedding_count("siglip2-base-patch16-224") == 20


def test_events_are_emitted(store: Store, library):
    seen: list[tuple[str, dict]] = []
    idx = Indexer(store, FakeEmbedder(), on_event=lambda k, p: seen.append((k, p)))
    idx.scan([(library, True)])

    kinds = [k for k, _ in seen]
    assert "index" in kinds
    assert kinds[-1] == "scan-complete"
    assert dict(seen)["scan-complete"]["ingested"] == 20


def test_background_rescan_runs_and_finishes(store: Store, library):
    idx = Indexer(store, FakeEmbedder())
    store.add_folder(str(library), recursive=True)
    assert idx.start_rescan() is True
    idx.join(timeout=60)
    assert store.image_count() == 20
    assert idx.running is False


# -- OCR --------------------------------------------------------------------

class FakeOcr:
    """Stands in for tesseract. Thread-safe: the pool calls it from 4 threads."""

    id = "fake"

    def __init__(self, langs_key: str = "eng", text: str = "build failed", fail: bool = False):
        self.langs_key = langs_key
        self.text = text
        self.fail = fail
        self.reads = 0
        self.sizes: list[tuple[int, int]] = []
        self._lock = threading.Lock()

    def read(self, image):
        with self._lock:
            self.reads += 1
            self.sizes.append(image.size)
        if(self.fail):
            raise OcrError("engine said no")
        return self.text


def screenshot_ids(store: Store) -> set[int]:
    return {
        int(r["id"]) for r in store.conn().execute("SELECT id FROM images WHERE is_screenshot = 1")
    }


def test_scan_ocrs_screenshots_and_nothing_else(store: Store, library):
    fake = FakeOcr()
    idx = Indexer(store, FakeEmbedder(), ocr=fake)
    report = idx.scan([(library, True)])

    shots = screenshot_ids(store)
    assert len(shots) == 6
    assert fake.reads == 6
    assert report.ocred == 6
    # Photos are never read: OCR is the expensive half of ingest.
    assert store.ocr_ids() == shots


def test_ocr_reads_full_resolution_not_the_embed_copy(store: Store, library):
    fake = FakeOcr()
    Indexer(store, FakeEmbedder(), ocr=fake).scan([(library, True)])
    # 768 px (EMBED_MAX_EDGE) would make body text unreadable.
    assert (1920, 1080) in fake.sizes


def test_second_scan_does_not_reocr(store: Store, library):
    fake = FakeOcr()
    idx = Indexer(store, FakeEmbedder(), ocr=fake)
    idx.scan([(library, True)])
    idx.scan([(library, True)])
    assert fake.reads == 6


def test_an_empty_result_is_stored_as_a_marker(store: Store, library):
    fake = FakeOcr(text="")
    idx = Indexer(store, FakeEmbedder(), ocr=fake)
    idx.scan([(library, True)])

    # The row exists so the screenshot is never read again...
    assert idx.scan([(library, True)]) and fake.reads == 6
    assert store.get_ocr(next(iter(screenshot_ids(store)))) == ""
    # ...but an empty row is not "has text", or the grid lights up a TEXT badge
    # on every screenshot that happens to contain no words.
    assert store.ocr_ids() == set()


def test_changing_the_languages_reocrs(store: Store, library):
    first = FakeOcr(langs_key="eng")
    idx = Indexer(store, FakeEmbedder(), ocr=first)
    idx.scan([(library, True)])

    # What installing tesseract-data-tur looks like from here.
    second = FakeOcr(langs_key="eng+tur", text="masaüstü")
    idx.set_ocr(second)
    idx.scan([(library, True)])

    assert second.reads == 6
    assert store.get_ocr(next(iter(screenshot_ids(store)))) == "masaüstü"


def test_a_failed_read_writes_no_row_and_is_retried(store: Store, library):
    broken = FakeOcr(fail=True)
    idx = Indexer(store, FakeEmbedder(), ocr=broken)
    report = idx.scan([(library, True)])

    assert store.ocr_ids() == set()
    assert len(report.errors) == 6
    # No row means the next scan tries again, which is the point.
    working = FakeOcr()
    idx.set_ocr(working)
    idx.scan([(library, True)])
    assert working.reads == 6
    assert store.ocr_ids() == screenshot_ids(store)


def test_backfill_reads_screenshots_indexed_before_ocr_existed(store: Store, library):
    idx = Indexer(store, FakeEmbedder())
    idx.scan([(library, True)])
    assert store.ocr_ids() == set()

    fake = FakeOcr()
    idx.set_ocr(fake)
    assert idx.ocr_missing() == 6
    assert store.ocr_ids() == screenshot_ids(store)
    # Idempotent: a second call has nothing left to do.
    assert idx.ocr_missing() == 0


def test_background_ocr_backfill_finishes_and_announces_itself(store: Store, library):
    seen: list[tuple[str, dict]] = []
    idx = Indexer(store, FakeEmbedder(), on_event=lambda k, p: seen.append((k, p)))
    idx.scan([(library, True)])
    idx.set_ocr(FakeOcr())

    assert idx.start_ocr_backfill() is True
    idx.join(timeout=60)
    assert idx.running is False
    assert store.ocr_ids() == screenshot_ids(store)
    # The frontend refreshes its results on scan-complete; without it the TEXT
    # badges only appear on the next manual reload.
    assert seen[-1][0] == "scan-complete"
    assert seen[-1][1]["ocred"] == 6


def test_a_result_is_stamped_with_the_engine_that_produced_it(store: Store, library):
    """`PUT /settings` can swap the engine while reads are still in flight.

    Stamping that text with the *new* engine's identity would make a stale row
    look current to images_missing_ocr, which would then never re-read it.
    """
    idx = Indexer(store, FakeEmbedder(), ocr=FakeOcr(langs_key="eng", text="old engine"))
    idx.scan([(library, True)])
    shot = min(screenshot_ids(store))

    pending: deque = deque()
    with ThreadPoolExecutor(max_workers=1) as pool:
        idx._ocr_submit(pool, pending, shot, Image.new("L", (64, 64)))
        idx.set_ocr(FakeOcr(langs_key="eng+tur", text="new engine"))
        idx._ocr_drain(pending)

    row = store.conn().execute(
        "SELECT langs, text FROM ocr_text WHERE image_id = ?", (shot,)
    ).fetchone()
    assert (row["langs"], row["text"]) == ("eng", "old engine")
    # And it is still stale under the new engine, so the backfill picks it up.
    assert shot in store.images_missing_ocr("fake", "eng+tur")
