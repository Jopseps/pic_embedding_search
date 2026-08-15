"""Search: SQL prefilter → vector scan + FTS5 → RRF fusion.

Design notes that are decisions, not accidents:

* All vectors for the active model live in one contiguous `(N, dim)` float32
  matrix. `matrix @ query_vec` is the entire vector search — at a few thousand
  images that is well under 10 ms, and FAISS/Qdrant would be unjustified.
* Metadata filters run in SQL **first** and produce a candidate id set. Both
  legs are restricted to it — the text leg too, or folder/type/date filters
  silently stop applying to OCR matches.
* Hybrid fusion is Reciprocal Rank Fusion, never a weighted sum of scores.
  Cosine lands around 0.20-0.35 and BM25 around 0-20; any blend of the two is
  noise. `score = Σ 1/(60 + rank_i)`.
* A user's query is never FTS5 syntax. Every token is quoted, and a MATCH that
  SQLite still rejects degrades to vector-only rather than to a 500.
* `isDupe` and `view=dupes` come from `dupes.DupeIndex`, a cached pHash
  clustering, never from cosine and no longer from exact `sha256` alone.
  `hydrate` runs on every response, so it is handed the cached set rather than
  computing one.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .dupes import DupeIndex
from .store import Store

log = logging.getLogger(__name__)

RRF_K = 60
DEFAULT_LIMIT = 200

# How deep the text leg goes. BM25 past a few hundred rows is noise, and RRF
# weights rank 500 at 1/560 — it cannot move anything.
FTS_DEPTH = 500
# Words of context around the match in the returned snippet.
SNIPPET_TOKENS = 12
# SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766, but a candidate set that
# large is better filtered in Python than bound one id at a time.
MAX_SQL_PARAMS = 900

DATE_PRESET_DAYS = {"today": 1, "week": 7, "month": 30, "year": 365}
LARGE_EDGE = 2500


# ---------------------------------------------------------------------------
# In-memory vector matrix
# ---------------------------------------------------------------------------

class VectorIndex:
    """Rebuilt from SQLite on startup, appended to on ingest.

    Never mixes model_ids: vectors from different models live in different,
    incompatible spaces and may not even share a dimension.
    """

    def __init__(self, model_id: str, dim: int):
        self.model_id = model_id
        self.dim = dim
        self.ids = np.zeros((0,), dtype=np.int64)
        self.matrix = np.zeros((0, dim), dtype=np.float32)
        self._row_of: dict[int, int] = {}
        self._lock = threading.RLock()

    @property
    def size(self) -> int:
        return int(self.ids.shape[0])

    @classmethod
    def load(cls, store: Store, model_id: str, dim: int) -> "VectorIndex":
        idx = cls(model_id, dim)
        ids: list[int] = []
        vecs: list[np.ndarray] = []
        for image_id, vec in store.iter_embeddings(model_id):
            if(vec.shape[0] != dim):
                log.warning(
                    "image %s has a %d-dim vector for %s (expected %d); skipping",
                    image_id, vec.shape[0], model_id, dim,
                )
                continue
            ids.append(image_id)
            vecs.append(vec)
        if(ids):
            idx.ids = np.asarray(ids, dtype=np.int64)
            idx.matrix = np.ascontiguousarray(np.stack(vecs), dtype=np.float32)
            idx._row_of = {int(i): r for r, i in enumerate(ids)}
        log.info("vector index: %d vectors for %s", idx.size, model_id)
        return idx

    def add(self, image_id: int, vector: np.ndarray) -> None:
        v = np.asarray(vector, dtype=np.float32).ravel()
        if(v.shape[0] != self.dim):
            raise ValueError(f"expected dim {self.dim}, got {v.shape[0]}")
        with self._lock:
            existing = self._row_of.get(int(image_id))
            if(existing is not None):
                self.matrix[existing] = v
                return
            self.ids = np.append(self.ids, np.int64(image_id))
            self.matrix = np.ascontiguousarray(np.vstack([self.matrix, v[None, :]]))
            self._row_of[int(image_id)] = self.size - 1

    def remove(self, image_ids: Iterable[int]) -> None:
        drop = {int(i) for i in image_ids}
        if(not drop or self.size == 0):
            return
        with self._lock:
            keep = np.array([int(i) not in drop for i in self.ids], dtype=bool)
            self.ids = self.ids[keep]
            self.matrix = np.ascontiguousarray(self.matrix[keep])
            self._row_of = {int(i): r for r, i in enumerate(self.ids)}

    def vector_for(self, image_id: int) -> np.ndarray | None:
        row = self._row_of.get(int(image_id))
        return None if row is None else self.matrix[row]

    def search(
        self, query_vec: np.ndarray, limit: int, candidates: set[int] | None = None
    ) -> list[tuple[int, float]]:
        """Cosine over normalized vectors == one matmul. Returns (id, score)."""
        if(self.size == 0):
            return []
        q = np.asarray(query_vec, dtype=np.float32).ravel()
        if(q.shape[0] != self.dim):
            raise ValueError(f"query dim {q.shape[0]} != index dim {self.dim}")

        with self._lock:
            matrix = self.matrix
            ids = self.ids
            if(candidates is not None):
                mask = np.fromiter(
                    (int(i) in candidates for i in ids), dtype=bool, count=ids.shape[0]
                )
                matrix = matrix[mask]
                ids = ids[mask]
            if(ids.shape[0] == 0):
                return []
            scores = matrix @ q

        k = min(limit, scores.shape[0])
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [(int(ids[i]), float(scores[i])) for i in top]


# ---------------------------------------------------------------------------
# Query model
# ---------------------------------------------------------------------------

@dataclass
class SearchParams:
    q: str = ""
    view: str | None = None
    collection: str | None = None
    date: str | None = None
    dims: str | None = None
    folders: list[str] = field(default_factory=list)
    types: list[str] = field(default_factory=list)
    limit: int = DEFAULT_LIMIT
    cursor: str | None = None

    @property
    def offset(self) -> int:
        if(not self.cursor):
            return 0
        try:
            return max(0, int(self.cursor))
        except ValueError:
            return 0


# SQLite has no dirname(); rtrim(path, replace(path,'/','')) strips the basename
# by trimming every trailing character that is not a slash.
DIRNAME_SQL = "rtrim(rtrim(images.path, replace(images.path, '/', '')), '/')"


def _like_subtree(folder: str) -> str:
    """LIKE pattern matching everything under `folder`.

    `%` and `_` are legal in filenames, so they are escaped rather than left to
    act as wildcards.
    """
    escaped = (
        folder.rstrip("/")
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return escaped + "/%"


def build_filter_sql(params: SearchParams) -> tuple[str, list]:
    """WHERE fragments + params for the metadata prefilter."""
    clauses: list[str] = []
    args: list = []

    if(params.types):
        wants_shot = "Screenshot" in params.types
        wants_photo = "Photo" in params.types
        if(wants_shot and not wants_photo):
            clauses.append("images.is_screenshot = 1")
        elif(wants_photo and not wants_shot):
            clauses.append("images.is_screenshot = 0")

    if(params.folders):
        # The sidebar's "Source folder" checkboxes come from listFolders() —
        # watched *roots*, not per-result dirnames. Matching the dirname alone
        # would return nothing for ~/Pictures when every image actually lives in
        # ~/Pictures/Screenshots. Match the folder and its whole subtree.
        parts = []
        for folder in params.folders:
            parts.append(f"({DIRNAME_SQL} = ? OR images.path LIKE ? ESCAPE '\\')")
            args.extend([folder.rstrip("/"), _like_subtree(folder)])
        clauses.append("(" + " OR ".join(parts) + ")")

    days = DATE_PRESET_DAYS.get(params.date or "")
    if(params.view == "recent" and days is None):
        days = 7
    if(days is not None):
        clauses.append(
            "COALESCE(images.taken_at, images.indexed_at) >= datetime('now', ?)"
        )
        args.append(f"-{days} days")

    if(params.dims == "large"):
        clauses.append("max(images.width, images.height) >= ?")
        args.append(LARGE_EDGE)
    elif(params.dims == "small"):
        clauses.append("max(images.width, images.height) < ?")
        args.append(LARGE_EDGE)

    return (" AND ".join(clauses) if clauses else ""), args


def candidate_ids(
    store: Store, params: SearchParams, dupes: frozenset[int] | None = None
) -> set[int] | None:
    """Ids surviving the metadata filters, or None meaning "no restriction"."""
    where, args = build_filter_sql(params)
    joins = ""

    if(params.collection):
        # By id, not name: renaming a collection must not silently empty the
        # view the user is looking at. `api.ts` sends `Collection.id`.
        joins += (
            " JOIN collection_items ci ON ci.image_id = images.id"
            " AND ci.collection_id = ?"
        )
        args = [_collection_id(params.collection)] + args

    if(not where and not joins and params.view != "dupes"):
        return None

    sql = f"SELECT images.id FROM images{joins}"
    if(where):
        sql += f" WHERE {where}"
    ids = {int(r["id"]) for r in store.conn().execute(sql, args)}

    # Near-duplicates are a pHash clustering, not a SQL predicate — see
    # `dupes.py` for why the grouping is complete linkage. Intersecting here
    # rather than joining keeps that entirely out of the query builder.
    if(params.view == "dupes"):
        ids &= (dupes if dupes is not None else frozenset())
    return ids


def _collection_id(value: str) -> int:
    """`-1` for a malformed id, which matches no row — an unknown collection is
    an empty view, never every image in the library."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


# ---------------------------------------------------------------------------
# Text leg (FTS5 over OCR)
# ---------------------------------------------------------------------------

def fts_match_query(query: str) -> str | None:
    """Turn a user query into an FTS5 MATCH expression, or None if there is none.

    Splitting on non-word characters and quoting each token means FTS5's
    operator syntax — `*`, `-`, `^`, `:`, `NEAR`, `OR`, a stray `"` — can never
    reach the parser as syntax. `\\w` is Unicode-aware, so Turkish words survive
    intact. Whitespace between quoted terms is implicit AND, which is what
    "build failed" should mean.
    """
    tokens = [t for t in re.split(r"[^\w'’]+", query, flags=re.UNICODE) if t]
    if(not tokens):
        return None
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def fts_search(
    store: Store,
    query: str,
    candidates: set[int] | None = None,
    limit: int = FTS_DEPTH,
) -> tuple[list[int], dict[int, str]]:
    """BM25-ranked OCR matches: (ranked ids, id -> snippet)."""
    match = fts_match_query(query)
    if(match is None):
        return [], {}

    sql = (
        "SELECT ocr_fts.rowid AS id,"
        f" snippet(ocr_fts, 0, '', '', '…', {SNIPPET_TOKENS}) AS snip"
        " FROM ocr_fts WHERE ocr_fts MATCH ?"
    )
    args: list = [match]
    post_filter: set[int] | None = None

    if(candidates is not None):
        if(not candidates):
            return [], {}
        if(len(candidates) <= MAX_SQL_PARAMS):
            marks = ",".join("?" * len(candidates))
            sql += f" AND ocr_fts.rowid IN ({marks})"
            args.extend(int(i) for i in candidates)
        else:
            post_filter = candidates

    # bm25() is negative and *more* negative is better, so ascending is
    # best-first. A DESC here would rank the worst matches at the top.
    sql += " ORDER BY bm25(ocr_fts) LIMIT ?"
    args.append(limit)

    try:
        rows = list(store.conn().execute(sql, args))
    except sqlite3.OperationalError as exc:
        # An unparseable MATCH is a bad query, not a broken server: the vector
        # leg still answers it.
        log.warning("FTS query %r rejected: %s", match, exc)
        return [], {}

    ids: list[int] = []
    snippets: dict[int, str] = {}
    for row in rows:
        image_id = int(row["id"])
        if(post_filter is not None and image_id not in post_filter):
            continue
        ids.append(image_id)
        snippets[image_id] = row["snip"]
    return ids, snippets


# ---------------------------------------------------------------------------
# Fusion
# ---------------------------------------------------------------------------

def rrf_merge(ranked_lists: Sequence[Sequence[int]], k: int = RRF_K) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion over ranked id lists.

    `score(id) = Σ 1/(k + rank)` with rank starting at 1. Ids absent from a list
    contribute nothing from it. This is deliberately score-free: the inputs are
    cosine (0.20-0.35) and BM25 (0-20), which share no scale.
    """
    scores: dict[int, float] = {}
    for ranked in ranked_lists:
        for rank, image_id in enumerate(ranked, start=1):
            scores[image_id] = scores.get(image_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


# ---------------------------------------------------------------------------
# Row hydration
# ---------------------------------------------------------------------------

def hydrate(
    store: Store,
    ids: Sequence[int],
    scores: dict[int, float] | None = None,
    snippets: dict[int, str] | None = None,
    dupes: frozenset[int] | None = None,
) -> list[dict]:
    """Turn ids into wire-shape dicts, preserving the order of `ids`."""
    if(not ids):
        return []
    marks = ",".join("?" * len(ids))
    rows = {
        int(r["id"]): r
        for r in store.conn().execute(f"SELECT * FROM images WHERE id IN ({marks})", tuple(ids))
    }
    # Non-empty rows only: an empty one means "OCR ran, found nothing" and must
    # not light up the TEXT badge. The lightbox wants the text while browsing
    # too, so this runs for every response, not just for text queries.
    ocr = store.ocr_map(ids)
    # `dupes` is the cached pHash clustering (`dupes.DupeIndex`). Callers that
    # have no index — tests, one-off hydrations — get `isDupe: false` rather
    # than an O(N) rebuild hidden inside a row formatter.
    in_a_group = dupes if dupes is not None else frozenset()
    collections = store.collections_for(ids)

    out: list[dict] = []
    for image_id in ids:
        row = rows.get(int(image_id))
        if(row is None):
            continue
        p = Path(row["path"])
        item = {
            "id": int(row["id"]),
            "path": row["path"],
            "filename": p.name,
            "folder": str(p.parent),
            "width": int(row["width"]),
            "height": int(row["height"]),
            "mime": row["mime"],
            "takenAt": row["taken_at"],
            "isScreenshot": bool(row["is_screenshot"]),
            "hasOcr": int(row["id"]) in ocr,
            # Present-and-null, never absent: the frontend distinguishes "no
            # OCR" from "field missing", and a blanket exclude_none breaks it.
            "ocrText": ocr.get(int(row["id"])),
            "snippet": (snippets or {}).get(int(row["id"])),
            "isDupe": int(row["id"]) in in_a_group,
            "collections": collections.get(int(row["id"]), []),
        }
        # `score` is optional in types.ts — omitted when browsing, never null.
        if(scores is not None and int(image_id) in scores):
            item["score"] = round(float(scores[int(image_id)]), 6)
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

class Searcher:
    def __init__(self, store: Store, vectors: VectorIndex, embedder):
        self.store = store
        self.vectors = vectors
        self.embedder = embedder
        self.dupes = DupeIndex(store)

    def search(self, params: SearchParams) -> dict:
        started = time.perf_counter()
        # One read of the cached clustering per request: the property refreshes
        # on a stale epoch, and both the `dupes` view and every item's `isDupe`
        # must agree within one response.
        dupes = self.dupes.ids
        candidates = candidate_ids(self.store, params, dupes)
        query = params.q.strip()

        if(query == ""):
            ids, total = self._browse(params, candidates)
            items = hydrate(self.store, ids, dupes=dupes)
        else:
            # Two ranked lists, fused by rank. The text leg is usually short or
            # empty; when it fires, an OCR hit at rank 1 outranks a mediocre
            # visual match no matter what their raw scores look like.
            vector_ranked = self._vector_search(query, candidates)
            text_ranked, snippets = fts_search(self.store, query, candidates)
            ranked = rrf_merge([[i for i, _ in vector_ranked], text_ranked])
            total = len(ranked)
            window = ranked[params.offset:params.offset + params.limit]
            scores = {i: s for i, s in window}
            items = hydrate(self.store, [i for i, _ in window], scores, snippets, dupes)

        consumed = params.offset + len(items)
        cursor = str(consumed) if consumed < total else None
        return {
            "items": items,
            "total": total,
            "tookMs": round((time.perf_counter() - started) * 1000, 2),
            "cursor": cursor,
        }

    def _browse(self, params: SearchParams, candidates: set[int] | None) -> tuple[list[int], int]:
        """Empty query: newest first over the filtered set."""
        where, args = build_filter_sql(params)
        clauses = [where] if where else []
        if(candidates is not None):
            if(not candidates):
                return [], 0
            marks = ",".join("?" * len(candidates))
            clauses.append(f"images.id IN ({marks})")
            args = list(args) + [int(i) for i in candidates]
        sql_where = f" WHERE {' AND '.join(clauses)}" if clauses else ""

        total = int(self.store.conn().execute(
            f"SELECT count(*) AS n FROM images{sql_where}", args
        ).fetchone()["n"])

        rows = self.store.conn().execute(
            f"SELECT images.id FROM images{sql_where}"
            " ORDER BY COALESCE(images.taken_at, images.indexed_at) DESC, images.id DESC"
            " LIMIT ? OFFSET ?",
            [*args, params.limit, params.offset],
        )
        return [int(r["id"]) for r in rows], total

    def _vector_search(self, query: str, candidates: set[int] | None) -> list[tuple[int, float]]:
        if(self.vectors.size == 0):
            return []
        q_vec = self.embedder.embed_text(query)
        # Take a generous slice so pagination has somewhere to go; the matmul
        # already touched every row, so this costs only the sort.
        depth = min(self.vectors.size, DEFAULT_LIMIT * 10)
        return self.vectors.search(q_vec, depth, candidates)

    def similar(self, image_id: int, limit: int = 60) -> dict:
        """Cosine neighbours. This is the correct use of cosine — dupes use pHash."""
        started = time.perf_counter()
        vec = self.vectors.vector_for(image_id)
        if(vec is None):
            vec_db = self.store.get_embedding(image_id, self.vectors.model_id)
            if(vec_db is None):
                return {"items": [], "total": 0, "tookMs": 0.0, "cursor": None}
            vec = vec_db

        ranked = [
            (i, s) for i, s in self.vectors.search(vec, limit + 1) if i != int(image_id)
        ][:limit]
        scores = {i: s for i, s in ranked}
        return {
            "items": hydrate(self.store, [i for i, _ in ranked], scores, dupes=self.dupes.ids),
            "total": len(ranked),
            "tookMs": round((time.perf_counter() - started) * 1000, 2),
            "cursor": None,
        }
