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

import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import paths
from .dupes import DupeIndex
from .store import Store

log = logging.getLogger(__name__)

RRF_K = 60
DEFAULT_LIMIT = 200
# How deep the visual leg goes into a response.
VECTOR_DEPTH = DEFAULT_LIMIT * 10

# How deep the text leg goes. BM25 past a few hundred rows is noise, and RRF
# weights rank 500 at 1/560 — it cannot move anything.
FTS_DEPTH = 500
# Words of context around the match in the returned snippet.
SNIPPET_TOKENS = 12

DATE_PRESET_DAYS = {"today": 1, "week": 7, "month": 30, "year": 365}
LARGE_EDGE = 2500

# `taken_at` is naive local wall-clock ISO (`dates.py`), so "now" has to be too,
# and spelled with the same `T` — `datetime('now')` is UTC and uses a space,
# which put every photo from today on the wrong side of a string compare.
NOW_LOCAL_SQL = "strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime', ?)"
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Undated rows sort last in both directions; `id` breaks every tie so a page
# boundary can never split or repeat a run of equal keys.
SORT_SQL = {
    "date-desc": "images.taken_at IS NULL, images.taken_at DESC, images.id DESC",
    "date-asc": "images.taken_at IS NULL, images.taken_at ASC, images.id ASC",
    "name-asc": "images.name_key ASC, images.id ASC",
    "name-desc": "images.name_key DESC, images.id DESC",
    "size-desc": "images.size_bytes DESC, images.id DESC",
    "size-asc": "images.size_bytes ASC, images.id ASC",
}
DEFAULT_SORT = "date-desc"
RELEVANCE = "relevance"
# How many of the best matches a query keeps when it is re-sorted by something
# other than relevance. The vector leg ranks *every* image, so without a cut
# "search, sorted by date" is the whole library sorted by date.
DEFAULT_SORTED_KEEP = 100


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
        # Spare capacity past `_n`: copying the whole matrix per added vector
        # made indexing a large library quadratic in memory traffic.
        self._ids_buf = np.zeros((0,), dtype=np.int64)
        self._mat_buf = np.zeros((0, dim), dtype=np.float32)
        self._n = 0
        self._row_of: dict[int, int] = {}
        self._lock = threading.RLock()

    @property
    def ids(self) -> np.ndarray:
        return self._ids_buf[:self._n]

    @property
    def matrix(self) -> np.ndarray:
        return self._mat_buf[:self._n]

    @property
    def size(self) -> int:
        return self._n

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
            idx._ids_buf = np.asarray(ids, dtype=np.int64)
            idx._mat_buf = np.ascontiguousarray(np.stack(vecs), dtype=np.float32)
            idx._n = len(ids)
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
                self._mat_buf[existing] = v
                return
            n = self._n
            if(n == self._mat_buf.shape[0]):
                # New buffers rather than resizing in place: a search that took
                # its view before this keeps reading the old, still-valid ones.
                cap = max(256, n + n // 4)
                ids_buf = np.zeros((cap,), dtype=np.int64)
                mat_buf = np.zeros((cap, self.dim), dtype=np.float32)
                ids_buf[:n] = self._ids_buf[:n]
                mat_buf[:n] = self._mat_buf[:n]
                self._ids_buf, self._mat_buf = ids_buf, mat_buf
            self._ids_buf[n] = image_id
            self._mat_buf[n] = v
            self._row_of[int(image_id)] = n
            self._n = n + 1

    def remove(self, image_ids: Iterable[int]) -> None:
        drop = {int(i) for i in image_ids}
        if(not drop or self.size == 0):
            return
        with self._lock:
            keep = ~np.isin(self.ids, np.fromiter(drop, dtype=np.int64, count=len(drop)))
            ids = self.ids[keep]
            self._mat_buf = np.ascontiguousarray(self.matrix[keep])
            self._ids_buf = ids
            self._n = int(ids.shape[0])
            self._row_of = {int(i): r for r, i in enumerate(ids)}

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
    # Balance between the two ranked legs, 0-100 (`textWeight` in config.toml).
    # 50 is equal weighting; 100 is OCR text only, 0 is visual only.
    text_weight: int = 50
    # A key of SORT_SQL, or "relevance". Empty means the default for the mode:
    # relevance with a query, newest first without.
    sort: str = ""
    # Inclusive `YYYY-MM-DD` bounds on the effective date; either may be open.
    date_from: str | None = None
    date_to: str | None = None
    sorted_keep: int = DEFAULT_SORTED_KEEP
    # How far above the pack a visual hit must score to count as a match, 0-100
    # (`matchStrictness` in config.toml). 0 keeps every image, as before.
    strictness: int = 0
    # The "show less relevant" request: ignore `strictness` and rank everything.
    weak: bool = False

    @property
    def order(self) -> str:
        """The sort that applies: a SORT_SQL key or RELEVANCE."""
        if(self.sort == RELEVANCE and self.q.strip()):
            return RELEVANCE
        if(self.sort in SORT_SQL):
            return self.sort
        return RELEVANCE if self.q.strip() else DEFAULT_SORT

    @property
    def offset(self) -> int:
        if(not self.cursor):
            return 0
        try:
            return max(0, int(self.cursor))
        except ValueError:
            return 0


# SQLite has no dirname(); rtrim(path, replace(path,sep,'')) strips the basename
# by trimming every trailing character that is not a separator. The platform's
# separator: stored paths are `str(Path)`, backslashes on Windows. (A backslash
# is literal inside an SQL string, so no escaping is needed here.)
DIRNAME_SQL = f"rtrim(rtrim(images.path, replace(images.path, '{os.sep}', '')), '{os.sep}')"


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
            args.extend([paths.subtree_prefix(folder)[:-1], paths.like_subtree(folder)])
        clauses.append("(" + " OR ".join(parts) + ")")

    days = DATE_PRESET_DAYS.get(params.date or "")
    if(params.view == "recent" and days is None):
        days = 7
    if(days is not None):
        clauses.append(f"images.taken_at >= {NOW_LOCAL_SQL}")
        args.append(f"-{days} days")

    # A day string compares below every timestamp on that day, so `>=` the
    # start and `<` the next day's start is exactly "on or between".
    if(params.date_from and DAY_RE.match(params.date_from)):
        clauses.append("images.taken_at >= ?")
        args.append(params.date_from)
    if(params.date_to and DAY_RE.match(params.date_to)):
        clauses.append("images.taken_at < date(?, '+1 day')")
        args.append(params.date_to)

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

    if(candidates is not None):
        if(not candidates):
            return [], {}
        # In SQL however many there are: filtering the top `limit` afterwards
        # dropped real matches whenever a common word filled the top 500 with
        # rows outside the filter.
        sql += " AND ocr_fts.rowid IN (SELECT value FROM json_each(?))"
        args.append(json.dumps(sorted(candidates)))

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
        ids.append(image_id)
        snippets[image_id] = row["snip"]
    return ids, snippets


# ---------------------------------------------------------------------------
# Match cutoff
# ---------------------------------------------------------------------------

# Below this many candidates the median is not a baseline, it is just another hit.
CUTOFF_MIN_CANDIDATES = 20


def strong_matches(
    ranked: list[tuple[int, float]], strictness: int
) -> list[tuple[int, float]]:
    """The head of a best-first cosine list that stands clear of the pack.

    The floor sits `strictness`% of the way from the median score up to the top
    one. Not a fixed cosine: SigLIP's scores bunch near 0.1 and shift per model,
    language and query, and a floor measured against the top alone cuts "flower"
    to four photos while keeping a vague "build failed" at a hundred. The median
    is what the query scores on an image that has nothing to do with it.
    """
    if(strictness <= 0 or len(ranked) < CUTOFF_MIN_CANDIDATES):
        return ranked
    # A non-finite score would make the floor NaN, and every comparison against
    # NaN is false: the cutoff would return nothing at all.
    ranked = [hit for hit in ranked if math.isfinite(hit[1])]
    if(not ranked):
        return ranked
    median = ranked[len(ranked) // 2][1]
    floor = median + (ranked[0][1] - median) * min(100, strictness) / 100.0
    return [hit for hit in ranked if hit[1] >= floor]


# ---------------------------------------------------------------------------
# Fusion
# ---------------------------------------------------------------------------

def rrf_merge(
    ranked_lists: Sequence[Sequence[int]],
    k: int = RRF_K,
    weights: Sequence[float] | None = None,
) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion over ranked id lists.

    `score(id) = Σ w_i/(k + rank)` with rank starting at 1. Ids absent from a
    list contribute nothing from it. This is deliberately score-free: the inputs
    are cosine (0.20-0.35) and BM25 (0-20), which share no scale.

    `weights` scales a whole *leg*, never an individual score, so the invariant
    holds — a weight of 1.4 says "a rank in this list is worth 1.4 of a rank in
    that one", which is a statement about ranks. Omitted (or all ones) it is the
    plain unweighted fusion, and `Searcher` passes weights that average to 1 so
    the default is bit-for-bit what it always was.
    """
    scores: dict[int, float] = {}
    for i, ranked in enumerate(ranked_lists):
        weight = 1.0 if weights is None else float(weights[i])
        if(weight == 0.0):
            # Skipped, not multiplied by zero. A leg at weight 0 still *has*
            # candidates, and adding 0.0 for each puts every one of them in the
            # result at score 0 — at the far end of the slider the whole
            # candidate set came back in id order, described as matches.
            continue
        for rank, image_id in enumerate(ranked, start=1):
            scores[image_id] = scores.get(image_id, 0.0) + weight / (k + rank)
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def leg_weights(text_weight: int) -> tuple[float, float]:
    """`(visual, text)` leg weights for a 0-100 balance setting.

    They sum to 2, not to 1, so the balanced setting is `(1.0, 1.0)` — the
    plain unweighted fusion, identical scores and identical order. Halving both
    would rank the same but renumber every score in the API response.
    """
    w = min(100, max(0, int(text_weight))) / 100.0
    return (2.0 * (1.0 - w), 2.0 * w)


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
            # Where the date came from — the lightbox says "Taken" for exif and
            # filename, "Modified" for a date that is only the file's mtime.
            "dateSource": row["date_source"],
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

@dataclass(frozen=True)
class Backend:
    """The vector index and the model that can query it, as one value.

    They must move together. A model swap that assigned them one at a time left
    a window — small, but hit on the very first real swap — where an in-flight
    request embedded its query with one model and scanned the other's index:
    `ValueError: query dim 768 != index dim 1152`. Replacing a single immutable
    attribute closes it without a lock on the hot path.
    """

    vectors: VectorIndex
    embedder: Any


class Searcher:
    def __init__(self, store: Store, vectors: VectorIndex, embedder):
        self.store = store
        self._backend = Backend(vectors, embedder)
        self.dupes = DupeIndex(store)

    @property
    def vectors(self) -> VectorIndex:
        return self._backend.vectors

    @vectors.setter
    def vectors(self, value: VectorIndex) -> None:
        self._backend = Backend(value, self._backend.embedder)

    @property
    def embedder(self):
        return self._backend.embedder

    def swap(self, vectors: VectorIndex, embedder) -> None:
        """Point at a different model. One assignment, so no request can see
        half of it."""
        self._backend = Backend(vectors, embedder)

    def search(self, params: SearchParams) -> dict:
        started = time.perf_counter()
        # Snapshot once: a promotion mid-request must not change the answer
        # underneath it.
        backend = self._backend
        # One read of the cached clustering per request: the property refreshes
        # on a stale epoch, and both the `dupes` view and every item's `isDupe`
        # must agree within one response.
        dupes = self.dupes.ids
        candidates = candidate_ids(self.store, params, dupes)
        query = params.q.strip()

        weak = 0
        if(query == ""):
            ids, total = self._browse(params, candidates)
            items = hydrate(self.store, ids, dupes=dupes)
            taken = len(ids)
        else:
            ranked, snippets, weak = self._ranked(params, candidates, backend)
            total = len(ranked)
            window = ranked[params.offset:params.offset + params.limit]
            scores = {i: s for i, s in window}
            items = hydrate(self.store, [i for i, _ in window], scores, snippets, dupes)
            taken = len(window)

        # Rows asked for, not rows that came back: `hydrate` drops an id whose row
        # is gone, and counting only survivors repeats items on the next page.
        consumed = params.offset + taken
        cursor = str(consumed) if consumed < total else None
        return {
            "items": items,
            "total": total,
            "tookMs": round((time.perf_counter() - started) * 1000, 2),
            "cursor": cursor,
            # Matches held back by the cutoff; what "show less relevant" adds.
            "weak": weak,
        }

    def _ranked(
        self, params: SearchParams, candidates: set[int] | None, backend: Backend
    ) -> tuple[list[tuple[int, float]], dict[int, str], int]:
        """Fused matches in the order the response lists them, plus snippets and
        how many more the cutoff held back."""
        query = params.q.strip()
        # Two ranked lists, fused by rank. The text leg is usually short or
        # empty; when it fires, an OCR hit at rank 1 outranks a mediocre
        # visual match no matter what their raw scores look like.
        cut = params.strictness > 0 and not params.weak
        vector_ranked = self._vector_search(query, candidates, backend, full=cut)
        text_ranked, snippets = fts_search(self.store, query, candidates)
        weights = leg_weights(params.text_weight)
        everything = rrf_merge(
            [[i for i, _ in vector_ranked[:VECTOR_DEPTH]], text_ranked], weights=weights
        )
        ranked = everything
        if(cut):
            # Only the visual leg is cut. A photo whose OCR text matches the
            # query is a match whatever its cosine says.
            kept = strong_matches(vector_ranked, params.strictness)
            ranked = rrf_merge([[i for i, _ in kept], text_ranked], weights=weights)
        weak = len(everything) - len(ranked)
        if(params.order != RELEVANCE):
            ranked = self._resort(ranked[:max(1, params.sorted_keep)], params.order)
        return ranked, snippets, weak

    def timeline(self, params: SearchParams) -> dict:
        """Photos per month, in the order the grid lists them.

        The scrubber's map of the whole result, including the pages not loaded
        yet — it is what lets a jump to a month know how far down that month
        starts. Empty unless the order is by date: the scrubber exists only then.
        """
        order = params.order
        if(order not in ("date-desc", "date-asc")):
            return {"buckets": [], "undated": 0}
        dupes = self.dupes.ids
        candidates = candidate_ids(self.store, params, dupes)
        if(params.q.strip()):
            ranked, _, _ = self._ranked(params, candidates, self._backend)
            candidates = {i for i, _ in ranked}
            where = self._where(SearchParams(), candidates)
        else:
            where = self._where(params, candidates)
        if(where is None):
            return {"buckets": [], "undated": 0}
        sql_where, args = where
        rows = self.store.conn().execute(
            f"SELECT substr(images.taken_at, 1, 7) AS month, count(*) AS n"
            f" FROM images{sql_where} GROUP BY month",
            args,
        )
        buckets = []
        undated = 0
        for r in rows:
            if(r["month"] is None):
                undated = int(r["n"])
            else:
                buckets.append({"month": r["month"], "count": int(r["n"])})
        buckets.sort(key=lambda b: b["month"], reverse=(order == "date-desc"))
        return {"buckets": buckets, "undated": undated}

    def _where(
        self, params: SearchParams, candidates: set[int] | None
    ) -> tuple[str, list] | None:
        """WHERE for the filtered set, or None when it is provably empty."""
        where, args = build_filter_sql(params)
        clauses = [where] if where else []
        if(candidates is not None):
            if(not candidates):
                return None
            # One bound value, not one `?` per id: a filter that matches tens of
            # thousands of photos blew SQLite's variable limit (32766 in the
            # bundled CPython) and answered every browse request with a 500.
            clauses.append("images.id IN (SELECT value FROM json_each(?))")
            args = list(args) + [json.dumps(sorted(candidates))]
        return (f" WHERE {' AND '.join(clauses)}" if clauses else ""), args

    def _resort(self, ranked: list[tuple[int, float]], order: str) -> list[tuple[int, float]]:
        """The kept matches in `order`, each still carrying its relevance score."""
        score_of = dict(ranked)
        if(not score_of):
            return []
        rows = self.store.conn().execute(
            "SELECT images.id FROM images"
            " WHERE images.id IN (SELECT value FROM json_each(?))"
            f" ORDER BY {SORT_SQL[order]}",
            (json.dumps(list(score_of)),),
        )
        return [(int(r["id"]), score_of[int(r["id"])]) for r in rows]

    def _browse(self, params: SearchParams, candidates: set[int] | None) -> tuple[list[int], int]:
        """Empty query: the filtered set in the requested order."""
        where = self._where(params, candidates)
        if(where is None):
            return [], 0
        sql_where, args = where

        total = int(self.store.conn().execute(
            f"SELECT count(*) AS n FROM images{sql_where}", args
        ).fetchone()["n"])

        rows = self.store.conn().execute(
            f"SELECT images.id FROM images{sql_where}"
            f" ORDER BY {SORT_SQL.get(params.order, SORT_SQL[DEFAULT_SORT])}"
            " LIMIT ? OFFSET ?",
            [*args, params.limit, params.offset],
        )
        return [int(r["id"]) for r in rows], total

    def _vector_search(
        self, query: str, candidates: set[int] | None, backend: Backend,
        full: bool = False,
    ) -> list[tuple[int, float]]:
        # `backend` is the caller's snapshot — the query text and the index it
        # is scanned against have to come from the same model.
        if(backend.vectors.size == 0):
            return []
        q_vec = backend.embedder.embed_text(query)
        # Take a generous slice so pagination has somewhere to go; the matmul
        # already touched every row, so this costs only the sort.
        # `full` asks for every row: the cutoff needs the median of the whole
        # candidate set, and a list cut at VECTOR_DEPTH has a skewed one.
        depth = backend.vectors.size if full else min(backend.vectors.size, VECTOR_DEPTH)
        return backend.vectors.search(q_vec, depth, candidates)

    def similar(
        self, image_id: int, limit: int = 60, params: SearchParams | None = None
    ) -> dict:
        """Cosine neighbours. This is the correct use of cosine — dupes use pHash.

        `params` carries only the metadata filters; they narrow the candidates
        through the same `candidate_ids` a `/search` uses.
        """
        backend = self._backend
        vec = backend.vectors.vector_for(image_id)
        if(vec is None):
            vec = self.store.get_embedding(image_id, backend.vectors.model_id)
            if(vec is None):
                return {"items": [], "total": 0, "tookMs": 0.0, "cursor": None}
        return self._neighbours(vec, backend, limit, params, exclude=int(image_id))

    def similar_to_image(
        self, image, limit: int = 60, params: SearchParams | None = None
    ) -> dict:
        """Neighbours of a picture that is not in the library. The image is
        embedded with the snapshot's own model, the one its index belongs to."""
        backend = self._backend
        if(backend.vectors.size == 0):
            return {"items": [], "total": 0, "tookMs": 0.0, "cursor": None}
        vec = backend.embedder.embed_pil([image])[0]
        return self._neighbours(vec, backend, limit, params)

    def _neighbours(
        self, vec, backend: Backend, limit: int, params: SearchParams | None,
        exclude: int | None = None,
    ) -> dict:
        started = time.perf_counter()
        dupes = self.dupes.ids
        candidates = None if params is None else candidate_ids(self.store, params, dupes)
        ranked = [
            (i, s) for i, s in backend.vectors.search(vec, limit + 1, candidates)
            if i != exclude
        ][:limit]
        scores = {i: s for i, s in ranked}
        return {
            "items": hydrate(self.store, [i for i, _ in ranked], scores, dupes=dupes),
            "total": len(ranked),
            "tookMs": round((time.perf_counter() - started) * 1000, 2),
            "cursor": None,
        }
