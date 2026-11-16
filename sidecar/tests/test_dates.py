"""Dates, sort order, date filters and the timeline.

A real 299-image library came back with every `taken_at` NULL — the PNGs have
no EXIF, and the JPEG read looked for DateTimeOriginal where Pillow never puts
it — so the grid was one "Undated" section in scan order. These pin down each
source, the order they win in, and everything that reads the column.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from picsearch import dates
from picsearch.search import Searcher, SearchParams, VectorIndex
from picsearch.store import Store

MODEL = "siglip2-so400m-patch14-384"
DIM = 8


def epoch(text: str) -> float:
    """A local wall-clock time as the epoch a file's mtime would hold."""
    return datetime.fromisoformat(text).timestamp()


# ---------------------------------------------------------------------------
# Filename
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(("name", "expected"), [
    ("Screenshot_20260530_213645.png", "2026-05-30T21:36:45"),
    ("IMG_20260530_213645.jpg", "2026-05-30T21:36:45"),
    ("PXL_20260530_213645123.jpg", "2026-05-30T21:36:45"),
    ("20260530_213645.jpg", "2026-05-30T21:36:45"),
    ("signal-2026-05-30-213645.jpg", "2026-05-30T21:36:45"),
    ("Screenshot 2026-05-30 at 21.36.45.png", "2026-05-30T21:36:45"),
    ("Screenshot_2026-05-30_21-36-45.png", "2026-05-30T21:36:45"),
    ("flameshot 2026-05-30_21-36.png", "2026-05-30T21:36:00"),
    ("IMG-20260530-WA0012.jpg", "2026-05-30T00:00:00"),
    ("holiday 2026-05-30.jpg", "2026-05-30T00:00:00"),
])
def test_filename_patterns(name, expected):
    parsed = dates.from_filename(name)
    assert parsed is not None
    assert dates._iso(parsed[0]) == expected


@pytest.mark.parametrize("name", [
    "stun.png",
    "the-kirbys-calling-the-police-v0-8yjl3rm7j9xg1.webp",
    "20261399.png",          # month 13
    "a320260530999.png",     # a date buried in a longer digit run
    "18990101.png",          # before digital photos
    "20990101.png",          # the future
    "IMG_0012.jpg",
])
def test_filename_rejects_non_dates(name):
    assert dates.from_filename(name) is None


def test_a_bad_candidate_does_not_hide_a_good_one():
    parsed = dates.from_filename("20261399 copy of 20260530.png")
    assert parsed is not None and dates._iso(parsed[0]) == "2026-05-30T00:00:00"


def test_a_day_only_name_takes_the_time_from_a_same_day_mtime():
    taken, source = dates.resolve_without_exif(
        "IMG-20260530-WA0012.jpg", epoch("2026-05-30T18:02:11")
    )
    assert (taken, source) == ("2026-05-30T18:02:11", "filename")


def test_a_day_only_name_ignores_an_mtime_from_another_day():
    taken, source = dates.resolve_without_exif(
        "IMG-20260530-WA0012.jpg", epoch("2026-07-01T09:00:00")
    )
    assert (taken, source) == ("2026-05-30T00:00:00", "filename")


# ---------------------------------------------------------------------------
# mtime and EXIF
# ---------------------------------------------------------------------------

def test_mtime_is_local_wall_clock():
    """mtime is a UTC epoch; the column is local time like EXIF and names."""
    taken, source = dates.resolve_without_exif("stun.png", epoch("2026-08-11T12:58:40"))
    assert (taken, source) == ("2026-08-11T12:58:40", "mtime")


def test_no_mtime_is_undated():
    assert dates.resolve_without_exif("stun.png", 0.0) == (None, None)


def save_with_exif(path: Path, tags: dict[int, str], sub: dict[int, str] | None = None) -> Path:
    img = Image.new("RGB", (32, 32), (10, 10, 10))
    exif = img.getexif()
    for tag, value in tags.items():
        exif[tag] = value
    if(sub):
        ifd = exif.get_ifd(dates.EXIF_IFD)
        for tag, value in sub.items():
            ifd[tag] = value
    img.save(path, exif=exif)
    return path


def test_exif_reads_datetimeoriginal_from_the_exif_sub_ifd(tmp_path):
    """Where cameras put it. The old reader only looked in IFD0 and so only
    ever found DateTime — the time the file was last *edited*."""
    p = save_with_exif(
        tmp_path / "cam.jpg",
        {dates.EXIF_DATETIME: "2026:09:01 10:00:00"},
        {dates.EXIF_DATETIME_ORIGINAL: "2026:03:14 14:22:00"},
    )
    assert dates.from_exif(p) == "2026-03-14T14:22:00"


def test_exif_still_reads_datetimeoriginal_from_ifd0(tmp_path):
    p = save_with_exif(tmp_path / "odd.jpg", {dates.EXIF_DATETIME_ORIGINAL: "2026:03:14 14:22:00"})
    assert dates.from_exif(p) == "2026-03-14T14:22:00"


def test_an_unset_camera_clock_is_not_a_date(tmp_path):
    p = save_with_exif(tmp_path / "zero.jpg", {dates.EXIF_DATETIME: "0000:00:00 00:00:00"})
    assert dates.from_exif(p) is None


def test_exif_beats_filename_beats_mtime(tmp_path):
    p = save_with_exif(
        tmp_path / "IMG_20200101_000000.jpg",
        {},
        {dates.EXIF_DATETIME_ORIGINAL: "2026:03:14 14:22:00"},
    )
    assert dates.resolve(p, epoch("2026-08-01T00:00:00")) == ("2026-03-14T14:22:00", "exif")

    plain = tmp_path / "IMG_20200101_000000.png"
    Image.new("RGB", (8, 8)).save(plain)
    assert dates.resolve(plain, epoch("2026-08-01T00:00:00")) == ("2020-01-01T00:00:00", "filename")

    art = tmp_path / "stun.png"
    Image.new("RGB", (8, 8)).save(art)
    assert dates.resolve(art, epoch("2026-08-01T00:00:00")) == ("2026-08-01T00:00:00", "mtime")


def test_a_missing_file_still_gets_a_date(tmp_path):
    """The startup refresh reads files that may be on an unplugged drive."""
    gone = tmp_path / "Screenshot_20260530_213645.png"
    assert dates.resolve(gone, 1.0) == ("2026-05-30T21:36:45", "filename")


def test_name_key_is_natural_and_case_blind():
    names = ["img10.png", "IMG2.png", "img1.png", "b.png", "A.png"]
    assert sorted(names, key=dates.name_key) == [
        "A.png", "b.png", "img1.png", "IMG2.png", "img10.png",
    ]


# ---------------------------------------------------------------------------
# Store: migration, refresh, rename
# ---------------------------------------------------------------------------

V1_IMAGES = """
CREATE TABLE images(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime REAL NOT NULL,
    size_bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
    mime TEXT NOT NULL, phash INTEGER NOT NULL, sha256 TEXT NOT NULL,
    taken_at TEXT, is_screenshot INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL
);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES('schema_version', '1');
"""


def test_a_v1_library_migrates_and_refreshes(tmp_path):
    db = tmp_path / "index.db"
    c = sqlite3.connect(db)
    c.executescript(V1_IMAGES)
    c.execute(
        "INSERT INTO images VALUES(1, ?, ?, 1, 10, 10, 'image/png', 0, 'x', NULL, 1,"
        " '2026-08-15T04:42:16+00:00')",
        (str(tmp_path / "Screenshot_20260530_213645.png"), epoch("2026-05-30T21:36:49")),
    )
    c.commit()
    c.close()

    store = Store(db)
    assert store.get_setting("schema_version") == "2"
    assert store.dates_stale()
    assert store.refresh_dates() == 1
    assert not store.dates_stale()
    row = store.image_by_id(1)
    assert (row["taken_at"], row["date_source"]) == ("2026-05-30T21:36:45", "filename")
    assert row["name_key"] == dates.name_key("Screenshot_20260530_213645.png")


def test_refresh_skips_a_row_renamed_underneath_it(store: Store, monkeypatch):
    """The refresh runs beside the watcher. A rename that lands between its read
    and its write already set the right values; the stale ones must not win."""
    add(store, "/lib/Screenshot_20260530_213645.png", taken_at=None)
    real = dates.resolve

    def rename_mid_refresh(path, mtime):
        store.move_image(
            "/lib/Screenshot_20260530_213645.png", "/lib/Screenshot_20260101_080000.png"
        )
        return real(path, mtime)

    monkeypatch.setattr(dates, "resolve", rename_mid_refresh)
    store.refresh_dates()
    row = store.image_by_path("/lib/Screenshot_20260101_080000.png")
    assert row["taken_at"] == "2026-01-01T08:00:00"


def add(
    store: Store, path: str, *, mtime: float = 1.0, size: int = 1, taken_at=None, source=None
) -> int:
    return store.upsert_image(
        path=path, mtime=mtime, size_bytes=size, width=10, height=10, mime="image/png",
        phash=hash(path) & 0xFFFF, sha256=path.ljust(64, "0")[:64], taken_at=taken_at,
        date_source=source, is_screenshot=False,
    )


def test_a_rename_re_derives_a_filename_date(store: Store):
    add(
        store, "/lib/Screenshot_20260530_213645.png",
        taken_at="2026-05-30T21:36:45", source="filename",
    )
    store.move_image("/lib/Screenshot_20260530_213645.png", "/lib/Screenshot_20260101_080000.png")
    row = store.image_by_path("/lib/Screenshot_20260101_080000.png")
    assert (row["taken_at"], row["date_source"]) == ("2026-01-01T08:00:00", "filename")
    assert row["name_key"] == dates.name_key("Screenshot_20260101_080000.png")


def test_a_rename_keeps_an_exif_date(store: Store):
    add(store, "/lib/IMG_20200101_000000.jpg", taken_at="2026-03-14T14:22:00", source="exif")
    store.move_image("/lib/IMG_20200101_000000.jpg", "/lib/IMG_20210101_000000.jpg")
    row = store.image_by_path("/lib/IMG_20210101_000000.jpg")
    assert (row["taken_at"], row["date_source"]) == ("2026-03-14T14:22:00", "exif")


# ---------------------------------------------------------------------------
# Sort, filters, timeline
# ---------------------------------------------------------------------------

class AxisEmbedder:
    """Query "a" points along axis 0; image vectors lean towards it by id."""

    def embed_text(self, text: str) -> np.ndarray:
        v = np.zeros(DIM, dtype=np.float32)
        v[0] = 1.0
        return v


@pytest.fixture()
def dated(store: Store):
    """Five rows: three dated across two months, two undated."""
    rows = [
        ("/lib/b10.png", "2026-05-30T21:36:45", 300),
        ("/lib/b2.png", "2026-05-01T08:00:00", 100),
        ("/lib/A.png", "2026-06-02T12:00:00", 500),
        ("/lib/c.png", None, 200),
        ("/lib/d.png", None, 400),
    ]
    ids = {}
    for path, taken, size in rows:
        source = "filename" if taken else None
        ids[Path(path).name] = add(store, path, size=size, taken_at=taken, source=source)
    vectors = VectorIndex(MODEL, DIM)
    # b10 is the best match for "a", then A, then b2, then c, then d.
    for rank, name in enumerate(["b10.png", "A.png", "b2.png", "c.png", "d.png"]):
        v = np.zeros(DIM, dtype=np.float32)
        v[0] = 1.0
        v[1] = rank * 0.5
        vectors.add(ids[name], v / np.linalg.norm(v))
    return Searcher(store, vectors, AxisEmbedder()), ids


def names(result: dict) -> list[str]:
    return [item["filename"] for item in result["items"]]


def test_browse_defaults_to_newest_with_undated_last(dated):
    searcher, _ = dated
    got = names(searcher.search(SearchParams()))
    assert got == ["A.png", "b10.png", "b2.png", "d.png", "c.png"]


def test_oldest_first_still_puts_undated_last(dated):
    searcher, _ = dated
    got = names(searcher.search(SearchParams(sort="date-asc")))
    assert got == ["b2.png", "b10.png", "A.png", "c.png", "d.png"]


def test_name_sort_is_natural(dated):
    searcher, _ = dated
    got = names(searcher.search(SearchParams(sort="name-asc")))
    assert got == ["A.png", "b2.png", "b10.png", "c.png", "d.png"]
    assert names(searcher.search(SearchParams(sort="name-desc")))[0] == "d.png"


def test_size_sort(dated):
    searcher, _ = dated
    got = names(searcher.search(SearchParams(sort="size-desc")))
    assert got == ["A.png", "d.png", "b10.png", "c.png", "b2.png"]


def test_pages_do_not_repeat_or_skip(dated):
    searcher, _ = dated
    first = searcher.search(SearchParams(sort="size-asc", limit=2))
    second = searcher.search(SearchParams(sort="size-asc", limit=2, cursor=first["cursor"]))
    third = searcher.search(SearchParams(sort="size-asc", limit=2, cursor=second["cursor"]))
    got = names(first) + names(second) + names(third)
    assert got == ["b2.png", "c.png", "b10.png", "d.png", "A.png"]
    assert third["cursor"] is None


def test_an_unknown_sort_falls_back_to_newest(dated):
    searcher, _ = dated
    assert names(searcher.search(SearchParams(sort="; DROP TABLE images")))[0] == "A.png"


def test_a_query_is_relevance_ordered_by_default(dated):
    searcher, _ = dated
    assert names(searcher.search(SearchParams(q="a")))[:3] == ["b10.png", "A.png", "b2.png"]


def test_a_re_sorted_query_keeps_only_the_best_matches(dated):
    """The vector leg ranks every image; re-sorting all of them by date would
    just be the library. The top `sorted_keep` survive, then get re-ordered."""
    searcher, _ = dated
    result = searcher.search(SearchParams(q="a", sort="date-asc", sorted_keep=3))
    assert names(result) == ["b2.png", "b10.png", "A.png"]
    assert result["total"] == 3
    assert all("score" in item for item in result["items"])


def test_date_range_is_inclusive_and_drops_undated(dated):
    searcher, _ = dated
    got = searcher.search(SearchParams(date_from="2026-05-30", date_to="2026-06-02"))
    assert names(got) == ["A.png", "b10.png"]
    got = searcher.search(SearchParams(date_to="2026-05-30"))
    assert names(got) == ["b10.png", "b2.png"]


def test_a_malformed_range_is_ignored(dated):
    searcher, _ = dated
    assert searcher.search(SearchParams(date_from="yesterday'--"))["total"] == 5


def test_presets_measure_local_time(store: Store):
    """`datetime('now')` is UTC with a space; `taken_at` is local with a T. A
    photo from an hour ago must be in "today" whatever the zone."""
    now = datetime.now().replace(microsecond=0)
    add(store, "/lib/now.png", taken_at=now.isoformat(), source="mtime")
    add(store, "/lib/old.png", taken_at="2020-01-01T00:00:00", source="mtime")
    searcher = Searcher(store, VectorIndex(MODEL, DIM), AxisEmbedder())
    assert names(searcher.search(SearchParams(date="today"))) == ["now.png"]


def test_timeline_counts_months_in_grid_order(dated):
    searcher, _ = dated
    assert searcher.timeline(SearchParams()) == {
        "buckets": [{"month": "2026-06", "count": 1}, {"month": "2026-05", "count": 2}],
        "undated": 2,
    }
    asc = searcher.timeline(SearchParams(sort="date-asc"))
    assert [b["month"] for b in asc["buckets"]] == ["2026-05", "2026-06"]


def test_timeline_follows_a_re_sorted_query(dated):
    searcher, _ = dated
    got = searcher.timeline(SearchParams(q="a", sort="date-desc", sorted_keep=2))
    assert got == {
        "buckets": [{"month": "2026-06", "count": 1}, {"month": "2026-05", "count": 1}],
        "undated": 0,
    }


def test_timeline_is_empty_unless_sorted_by_date(dated):
    searcher, _ = dated
    assert searcher.timeline(SearchParams(sort="name-asc")) == {"buckets": [], "undated": 0}
    assert searcher.timeline(SearchParams(q="a")) == {"buckets": [], "undated": 0}
