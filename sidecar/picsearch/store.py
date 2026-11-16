"""SQLite storage: schema, migrations, and every read/write the sidecar does.

Two things here are load-bearing and easy to break:

* `embeddings` is keyed by **(image_id, model_id)**, never by image_id alone.
  The embedding model is a user preference, models produce incompatible vector
  spaces, and never deleting the old rows is what makes switching back instant.
* `phash` is a 64-bit unsigned value stored in a *signed* SQLite INTEGER
  column. Anything >= 2**63 raises OverflowError on write, so it is wrapped on
  the way in and unwrapped on the way out. XOR/popcount over the wrapped form
  still yields the correct Hamming distance, but read it back through
  `phash_from_db` so callers never see the wrapped value.

Connections are thread-local: the ingest queue is threaded and a sqlite3
connection may not cross threads.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable, Iterable, Iterator, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from . import dates, paths
from .paths import db_path

SCHEMA_VERSION = 2

# Copied from ARCHITECTURE.md § 3. The ocr_fts triggers are a deliberate
# addition: ocr_fts is an external-content FTS5 table, so writing ocr_text does
# not index anything on its own. Without these, step 8's text search silently
# returns nothing.
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS images(
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    mtime       REAL NOT NULL,
    size_bytes  INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    mime        TEXT NOT NULL,
    phash       INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    taken_at    TEXT,
    is_screenshot INTEGER NOT NULL DEFAULT 0,
    indexed_at  TEXT NOT NULL,
    date_source TEXT,
    name_key    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_images_taken   ON images(taken_at);
CREATE INDEX IF NOT EXISTS idx_images_phash   ON images(phash);
CREATE INDEX IF NOT EXISTS idx_images_sha     ON images(sha256);

CREATE TABLE IF NOT EXISTS embeddings(
    image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    model_id  TEXT    NOT NULL,
    dim       INTEGER NOT NULL,
    vector    BLOB    NOT NULL,
    PRIMARY KEY(image_id, model_id)
);

CREATE TABLE IF NOT EXISTS ocr_text(
    image_id  INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    engine    TEXT NOT NULL,
    langs     TEXT NOT NULL,
    text      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ocr_fts USING fts5(
    text, content='ocr_text', content_rowid='image_id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS ocr_text_ai AFTER INSERT ON ocr_text BEGIN
    INSERT INTO ocr_fts(rowid, text) VALUES (new.image_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS ocr_text_ad AFTER DELETE ON ocr_text BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, text) VALUES ('delete', old.image_id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS ocr_text_au AFTER UPDATE ON ocr_text BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, text) VALUES ('delete', old.image_id, old.text);
    INSERT INTO ocr_fts(rowid, text) VALUES (new.image_id, new.text);
END;

CREATE TABLE IF NOT EXISTS watched_folders(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
    recursive INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS collections(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items(
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    PRIMARY KEY(collection_id, image_id)
);
CREATE TABLE IF NOT EXISTS saved_searches(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, query_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# Indexes on columns a migration adds. They cannot sit in SCHEMA_SQL: that
# script runs *before* the migrations, against a v1 table that does not have
# the column yet.
INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_images_name    ON images(name_key);
CREATE INDEX IF NOT EXISTS idx_images_size    ON images(size_bytes);
"""


# ---------------------------------------------------------------------------
# 64-bit unsigned <-> signed SQLite INTEGER
# ---------------------------------------------------------------------------

def phash_to_db(value: int) -> int:
    v = value & 0xFFFFFFFFFFFFFFFF
    if(v >= 1 << 63):
        return v - (1 << 64)
    return v


def phash_from_db(value: int) -> int:
    if(value < 0):
        return value + (1 << 64)
    return value


def hamming64(a: int, b: int) -> int:
    return ((a ^ b) & 0xFFFFFFFFFFFFFFFF).bit_count()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class Store:
    """Owns one database file. Hand it around; do not open sqlite3 elsewhere."""

    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path is not None else db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.RLock()
        self._pixel_epoch = 0
        self._on_delete: list[Callable[[Sequence[int]], None]] = []
        self._migrate(self.conn())

    # -- pixel epoch --------------------------------------------------------

    @property
    def pixel_epoch(self) -> int:
        """Bumped whenever the set of images or their pixels change.

        `dupes.DupeIndex` caches an O(N) clustering pass and rebuilds when this
        moves. Every write that could change a pHash goes through `upsert_image`
        or `delete_images`, so hooking those two is exhaustive in a way that
        hooking the ingest paths would not be — the watcher and the scanner both
        end up here.

        **`move_image` deliberately does not bump it.** A rename changes a path;
        the pixels, and therefore every hash, are untouched.
        """
        return self._pixel_epoch

    # -- connections --------------------------------------------------------

    def conn(self) -> sqlite3.Connection:
        existing = getattr(self._local, "conn", None)
        if(existing is not None):
            return existing
        c = sqlite3.connect(self.path, timeout=30.0)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=30000")
        self._local.conn = c
        return c

    def close(self) -> None:
        existing = getattr(self._local, "conn", None)
        if(existing is not None):
            existing.close()
            self._local.conn = None

    # -- migrations ---------------------------------------------------------

    def _migrate(self, c: sqlite3.Connection) -> None:
        with self._write_lock:
            c.executescript(SCHEMA_SQL)
            c.commit()
            current = self.get_setting("schema_version")
            if(current is None):
                self.set_setting("schema_version", str(SCHEMA_VERSION))
            else:
                version = int(current)
                while(version < SCHEMA_VERSION):
                    step = MIGRATIONS.get(version + 1)
                    if(step is None):
                        raise RuntimeError(f"no migration to schema version {version + 1}")
                    step(c)
                    c.commit()
                    version += 1
                    self.set_setting("schema_version", str(version))
                if(version > SCHEMA_VERSION):
                    raise RuntimeError(
                        f"database is schema v{version}, this build understands v{SCHEMA_VERSION}"
                    )
            c.executescript(INDEX_SQL)
            c.commit()

    # -- settings -----------------------------------------------------------

    def get_setting(self, key: str) -> str | None:
        row = self.conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row is not None else None

    def set_setting(self, key: str, value: str) -> None:
        with self._write_lock:
            c = self.conn()
            c.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            c.commit()

    def get_json_setting(self, key: str, default: Any = None) -> Any:
        raw = self.get_setting(key)
        if(raw is None):
            return default
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return default

    def set_json_setting(self, key: str, value: Any) -> None:
        self.set_setting(key, json.dumps(value))

    # -- images -------------------------------------------------------------

    def image_by_path(self, path: str) -> sqlite3.Row | None:
        return self.conn().execute("SELECT * FROM images WHERE path=?", (path,)).fetchone()

    def image_by_id(self, image_id: int) -> sqlite3.Row | None:
        return self.conn().execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()

    def is_unchanged(self, path: str, mtime: float, size_bytes: int) -> bool:
        """The ingest fast path. Must never touch the GPU."""
        row = self.conn().execute(
            "SELECT 1 FROM images WHERE path=? AND size_bytes=? AND abs(mtime - ?) < 0.001",
            (path, size_bytes, mtime),
        ).fetchone()
        return row is not None

    def upsert_image(
        self,
        *,
        path: str,
        mtime: float,
        size_bytes: int,
        width: int,
        height: int,
        mime: str,
        phash: int,
        sha256: str,
        taken_at: str | None,
        is_screenshot: bool,
        date_source: str | None = None,
    ) -> int:
        with self._write_lock:
            c = self.conn()
            cur = c.execute(
                "INSERT INTO images(path, mtime, size_bytes, width, height, mime, phash,"
                " sha256, taken_at, is_screenshot, indexed_at, date_source, name_key)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(path) DO UPDATE SET"
                "  mtime=excluded.mtime, size_bytes=excluded.size_bytes,"
                "  width=excluded.width, height=excluded.height, mime=excluded.mime,"
                "  phash=excluded.phash, sha256=excluded.sha256, taken_at=excluded.taken_at,"
                "  is_screenshot=excluded.is_screenshot, indexed_at=excluded.indexed_at,"
                "  date_source=excluded.date_source, name_key=excluded.name_key"
                " RETURNING id",
                (
                    path, mtime, size_bytes, width, height, mime,
                    phash_to_db(phash), sha256, taken_at, int(is_screenshot), now_iso(),
                    date_source, dates.name_key(Path(path).name),
                ),
            )
            image_id = int(cur.fetchone()["id"])
            c.commit()
            self._pixel_epoch += 1
            return image_id

    def add_delete_listener(self, fn: Callable[[Sequence[int]], None]) -> None:
        """Call `fn(ids)` after rows are gone, so the in-memory vector index can
        follow. A vector left behind outlives its row: search ranks it, `hydrate`
        drops it, and the page comes back short."""
        self._on_delete.append(fn)

    def _deleted(self, ids: Sequence[int]) -> None:
        for fn in self._on_delete:
            fn(ids)

    def delete_images(self, ids: Sequence[int]) -> int:
        if(not ids):
            return 0
        with self._write_lock:
            c = self.conn()
            cur = c.execute(
                "DELETE FROM images WHERE id IN (SELECT value FROM json_each(?))",
                (json.dumps([int(i) for i in ids]),),
            )
            c.commit()
            if(cur.rowcount):
                self._pixel_epoch += 1
        if(cur.rowcount):
            self._deleted(ids)
        return cur.rowcount

    def move_image(self, old_path: str, new_path: str) -> int | None:
        """Repoint a row at a renamed file. Returns the image id, or None.

        The whole reason to track renames is that the pixels did not change:
        the embedding, the OCR text and the thumbnails are all still correct
        and all of them hang off `image_id`. Re-ingesting would spend the GPU
        on a file that only moved.

        The name did change, though, and the name can carry the date: a date
        that came from the old filename is re-derived from the new one. An EXIF
        date stays — the bytes it was read from are the same bytes.
        """
        with self._write_lock:
            c = self.conn()
            row = c.execute(
                "SELECT id, mtime, taken_at, date_source FROM images WHERE path=?", (old_path,)
            ).fetchone()
            if(row is None):
                return None
            image_id = int(row["id"])
            taken_at, date_source = row["taken_at"], row["date_source"]
            if(date_source != "exif"):
                taken_at, date_source = dates.resolve_without_exif(
                    Path(new_path).name, float(row["mtime"])
                )
            # Landing on an existing row would violate UNIQUE(path). Whatever
            # was at the destination has just been overwritten on disk, so its
            # row is stale — drop it and let the cascade take its rows with it.
            gone = [
                int(r["id"]) for r in c.execute(
                    "SELECT id FROM images WHERE path=? AND id!=?", (new_path, image_id)
                )
            ]
            c.execute("DELETE FROM images WHERE path=? AND id!=?", (new_path, image_id))
            c.execute(
                "UPDATE images SET path=?, name_key=?, taken_at=?, date_source=? WHERE id=?",
                (new_path, dates.name_key(Path(new_path).name), taken_at, date_source, image_id),
            )
            c.commit()
            # The rename itself changes no pixels and must not invalidate the
            # dupe index. Overwriting a *different* image does — that row is gone.
            if(gone):
                self._pixel_epoch += 1
        if(gone):
            self._deleted(gone)
        return image_id

    def image_count(self) -> int:
        return int(self.conn().execute("SELECT count(*) AS n FROM images").fetchone()["n"])

    def all_paths(self) -> set[str]:
        return {r["path"] for r in self.conn().execute("SELECT path FROM images")}

    # -- dates --------------------------------------------------------------

    def dates_stale(self) -> bool:
        return self.get_setting("date_rules_version") != str(dates.DATE_RULES_VERSION)

    def refresh_dates(self, batch: int = 500) -> int:
        """Re-derive `taken_at`, `date_source` and `name_key` for every row.

        Run once per `dates.DATE_RULES_VERSION`, on start. A rescan cannot do
        this: an unchanged file is skipped on `(path, mtime, size)` before
        anything reads it, so rows indexed under the old rules would keep
        their old date forever. Reads EXIF headers only — no decode, no GPU.
        The stored `mtime` is used rather than a fresh `stat`, and a file that
        cannot be opened falls through to filename and mtime like any other.
        Returns how many rows were read; a row changed underneath is skipped.
        """
        rows = [
            (int(r["id"]), r["path"], float(r["mtime"]))
            for r in self.conn().execute("SELECT id, path, mtime FROM images ORDER BY id")
        ]
        done = 0
        for start in range(0, len(rows), batch):
            payload = []
            for image_id, path, mtime in rows[start:start + batch]:
                taken_at, date_source = dates.resolve(path, mtime)
                payload.append((
                    taken_at, date_source, dates.name_key(Path(path).name), image_id, path, mtime,
                ))
            with self._write_lock:
                c = self.conn()
                # Guarded on the path and mtime the values were derived from:
                # this runs beside the watcher, and a row renamed or re-ingested
                # since it was read already has the right values for what it is
                # now — overwriting them would put the old name's date back.
                c.executemany(
                    "UPDATE images SET taken_at=?, date_source=?, name_key=?"
                    " WHERE id=? AND path=? AND mtime=?",
                    payload,
                )
                c.commit()
            done += len(payload)
        self.set_setting("date_rules_version", str(dates.DATE_RULES_VERSION))
        return done

    # -- embeddings ---------------------------------------------------------

    def put_embedding(self, image_id: int, model_id: str, vector: np.ndarray) -> None:
        """Vectors are stored L2-normalized float32 so cosine is a dot product."""
        v = np.asarray(vector, dtype=np.float32).ravel()
        with self._write_lock:
            c = self.conn()
            c.execute(
                "INSERT INTO embeddings(image_id, model_id, dim, vector) VALUES(?,?,?,?)"
                " ON CONFLICT(image_id, model_id) DO UPDATE SET"
                "  dim=excluded.dim, vector=excluded.vector",
                (image_id, model_id, int(v.shape[0]), v.tobytes()),
            )
            c.commit()

    def put_embeddings(self, model_id: str, rows: Iterable[tuple[int, np.ndarray]]) -> int:
        payload = []
        for image_id, vector in rows:
            v = np.asarray(vector, dtype=np.float32).ravel()
            payload.append((image_id, model_id, int(v.shape[0]), v.tobytes()))
        if(not payload):
            return 0
        with self._write_lock:
            c = self.conn()
            c.executemany(
                "INSERT INTO embeddings(image_id, model_id, dim, vector) VALUES(?,?,?,?)"
                " ON CONFLICT(image_id, model_id) DO UPDATE SET"
                "  dim=excluded.dim, vector=excluded.vector",
                payload,
            )
            c.commit()
            return len(payload)

    def get_embedding(self, image_id: int, model_id: str) -> np.ndarray | None:
        row = self.conn().execute(
            "SELECT vector FROM embeddings WHERE image_id=? AND model_id=?",
            (image_id, model_id),
        ).fetchone()
        if(row is None):
            return None
        return np.frombuffer(row["vector"], dtype=np.float32)

    def iter_embeddings(self, model_id: str) -> Iterator[tuple[int, np.ndarray]]:
        cur = self.conn().execute(
            "SELECT image_id, vector FROM embeddings WHERE model_id=? ORDER BY image_id",
            (model_id,),
        )
        for row in cur:
            yield int(row["image_id"]), np.frombuffer(row["vector"], dtype=np.float32)

    def embedding_count(self, model_id: str) -> int:
        return int(self.conn().execute(
            "SELECT count(*) AS n FROM embeddings WHERE model_id=?", (model_id,)
        ).fetchone()["n"])

    def images_missing_embedding(self, model_id: str, limit: int | None = None) -> list[int]:
        sql = (
            "SELECT i.id FROM images i"
            " LEFT JOIN embeddings e ON e.image_id = i.id AND e.model_id = ?"
            " WHERE e.image_id IS NULL ORDER BY i.id"
        )
        params: list[Any] = [model_id]
        if(limit is not None):
            sql += " LIMIT ?"
            params.append(limit)
        return [int(r["id"]) for r in self.conn().execute(sql, params)]

    # -- OCR ----------------------------------------------------------------

    def put_ocr(self, image_id: int, engine: str, langs: str, text: str) -> None:
        with self._write_lock:
            c = self.conn()
            c.execute(
                "INSERT INTO ocr_text(image_id, engine, langs, text) VALUES(?,?,?,?)"
                " ON CONFLICT(image_id) DO UPDATE SET"
                "  engine=excluded.engine, langs=excluded.langs, text=excluded.text",
                (image_id, engine, langs, text),
            )
            c.commit()

    def get_ocr(self, image_id: int) -> str | None:
        row = self.conn().execute(
            "SELECT text FROM ocr_text WHERE image_id=?", (image_id,)
        ).fetchone()
        return row["text"] if row is not None else None

    def ocr_ids(self) -> set[int]:
        """Images with *text*, not merely with a row.

        An empty row is the "OCR ran and found nothing" marker that stops every
        rescan from re-reading the same text-free screenshot forever. It must
        not light up the TEXT badge in the grid.
        """
        return {
            int(r["image_id"])
            for r in self.conn().execute(
                "SELECT image_id FROM ocr_text WHERE length(trim(text)) > 0"
            )
        }

    def ocr_map(self, ids: Sequence[int]) -> dict[int, str]:
        """`image_id -> text` for the non-empty rows among `ids`."""
        if(not ids):
            return {}
        marks = ",".join("?" * len(ids))
        return {
            int(r["image_id"]): r["text"]
            for r in self.conn().execute(
                f"SELECT image_id, text FROM ocr_text"
                f" WHERE image_id IN ({marks}) AND length(trim(text)) > 0",
                tuple(int(i) for i in ids),
            )
        }

    def images_missing_ocr(
        self, engine: str, langs: str, limit: int | None = None
    ) -> list[int]:
        """Screenshots with no OCR row, or one from a different engine/langs.

        `langs` is the engine's *effective* language string. Installing new
        tesseract language data changes it, which is what makes the next rescan
        pick up the newly readable text without a manual reset.
        """
        sql = (
            "SELECT images.id FROM images"
            " LEFT JOIN ocr_text ON ocr_text.image_id = images.id"
            " WHERE images.is_screenshot = 1"
            "   AND (ocr_text.image_id IS NULL OR ocr_text.engine != ? OR ocr_text.langs != ?)"
            " ORDER BY images.id"
        )
        params: list[Any] = [engine, langs]
        if(limit is not None):
            sql += " LIMIT ?"
            params.append(limit)
        return [int(r["id"]) for r in self.conn().execute(sql, params)]

    # -- watched folders ----------------------------------------------------

    def list_folders(self) -> list[sqlite3.Row]:
        return list(self.conn().execute("SELECT * FROM watched_folders ORDER BY path"))

    def add_folder(self, path: str, recursive: bool = True) -> None:
        with self._write_lock:
            c = self.conn()
            c.execute(
                "INSERT INTO watched_folders(path, recursive, enabled) VALUES(?,?,1)"
                " ON CONFLICT(path) DO UPDATE SET recursive=excluded.recursive, enabled=1",
                (path, int(recursive)),
            )
            c.commit()

    def remove_folder(self, path: str) -> None:
        with self._write_lock:
            c = self.conn()
            c.execute("DELETE FROM watched_folders WHERE path=?", (path,))
            c.commit()

    def set_folder_recursive(self, path: str, recursive: bool) -> None:
        with self._write_lock:
            c = self.conn()
            c.execute(
                "UPDATE watched_folders SET recursive=? WHERE path=?", (int(recursive), path)
            )
            c.commit()

    def folder_count(self, path: str) -> int:
        return int(self.conn().execute(
            "SELECT count(*) AS n FROM images WHERE path LIKE ? ESCAPE '\\'",
            (paths.like_subtree(path),),
        ).fetchone()["n"])

    # -- collections --------------------------------------------------------

    def list_collections(self) -> list[sqlite3.Row]:
        return list(self.conn().execute("SELECT * FROM collections ORDER BY name"))

    def collections_for(self, image_ids: Sequence[int]) -> dict[int, list[str]]:
        """image_id -> collection **ids**, as strings.

        Ids rather than names because `Photo.collections` in `types.ts` is what
        `MockApi` filters on, and a collection that gets renamed must not drop
        out of its own membership list.
        """
        if(not image_ids):
            return {}
        marks = ",".join("?" * len(image_ids))
        cur = self.conn().execute(
            "SELECT image_id AS iid, collection_id AS cid FROM collection_items"
            f" WHERE image_id IN ({marks}) ORDER BY collection_id",
            tuple(image_ids),
        )
        out: dict[int, list[str]] = {}
        for row in cur:
            out.setdefault(int(row["iid"]), []).append(str(int(row["cid"])))
        return out

    def create_collection(self, name: str) -> sqlite3.Row:
        """Idempotent on name: `collections.name` is UNIQUE, and a second
        "New collection" with the same name should select the existing one
        rather than fail the request."""
        with self._write_lock:
            c = self.conn()
            c.execute(
                "INSERT INTO collections(name, created_at) VALUES(?,?)"
                " ON CONFLICT(name) DO NOTHING",
                (name, now_iso()),
            )
            c.commit()
        row = self.conn().execute(
            "SELECT * FROM collections WHERE name=?", (name,)
        ).fetchone()
        return row

    def delete_collection(self, collection_id: int) -> bool:
        with self._write_lock:
            c = self.conn()
            cur = c.execute("DELETE FROM collections WHERE id=?", (collection_id,))
            c.commit()
            return cur.rowcount > 0

    def rename_collection(self, collection_id: int, name: str) -> bool:
        with self._write_lock:
            c = self.conn()
            cur = c.execute(
                "UPDATE collections SET name=? WHERE id=?", (name, collection_id)
            )
            c.commit()
            return cur.rowcount > 0

    def collection_count(self, collection_id: int) -> int:
        return int(self.conn().execute(
            "SELECT count(*) AS n FROM collection_items WHERE collection_id=?",
            (collection_id,),
        ).fetchone()["n"])

    def add_to_collection(self, collection_id: int, image_ids: Sequence[int]) -> int:
        """Returns how many rows were newly added — re-adding is not an error."""
        if(not image_ids):
            return 0
        with self._write_lock:
            c = self.conn()
            before = self.collection_count(collection_id)
            c.executemany(
                "INSERT INTO collection_items(collection_id, image_id) VALUES(?,?)"
                " ON CONFLICT DO NOTHING",
                [(collection_id, int(i)) for i in image_ids],
            )
            c.commit()
            return self.collection_count(collection_id) - before

    def remove_from_collection(self, collection_id: int, image_ids: Sequence[int]) -> int:
        if(not image_ids):
            return 0
        with self._write_lock:
            c = self.conn()
            cur = c.execute(
                "DELETE FROM collection_items WHERE collection_id=?"
                " AND image_id IN (SELECT value FROM json_each(?))",
                (collection_id, json.dumps([int(i) for i in image_ids])),
            )
            c.commit()
            return cur.rowcount

    # -- saved searches -----------------------------------------------------

    def list_saved_searches(self) -> list[sqlite3.Row]:
        return list(self.conn().execute("SELECT * FROM saved_searches ORDER BY id"))

    def create_saved_search(self, name: str, query_json: str) -> sqlite3.Row:
        """`query_json` holds the whole search — text, view and filters — so
        running a saved search restores what was on screen, not just the words
        in the box. `name` is what the sidebar shows."""
        with self._write_lock:
            c = self.conn()
            cur = c.execute(
                "INSERT INTO saved_searches(name, query_json) VALUES(?,?) RETURNING id",
                (name, query_json),
            )
            new_id = int(cur.fetchone()["id"])
            c.commit()
        return self.conn().execute(
            "SELECT * FROM saved_searches WHERE id=?", (new_id,)
        ).fetchone()

    def delete_saved_search(self, search_id: int) -> bool:
        with self._write_lock:
            c = self.conn()
            cur = c.execute("DELETE FROM saved_searches WHERE id=?", (search_id,))
            c.commit()
            return cur.rowcount > 0


def _migrate_v2(c: sqlite3.Connection) -> None:
    """`date_source` and `name_key`. Both are filled by `refresh_dates`, which
    the sidecar runs on start because `date_rules_version` is not yet set."""
    c.execute("ALTER TABLE images ADD COLUMN date_source TEXT")
    c.execute("ALTER TABLE images ADD COLUMN name_key TEXT NOT NULL DEFAULT ''")


MIGRATIONS: dict[int, Any] = {2: _migrate_v2}
"""version -> callable(conn). Add entries as the schema evolves."""
