"""FastAPI sidecar — the only public surface of the Python half.

Two rules govern this file.

**Auth is never bypassable.** The process binds an ephemeral port, generates a
random token, and prints exactly one JSON line to stdout before serving:

    {"port": 41337, "token": "..."}

Rust reads that line; standalone debugging reads it the same way. Every route
requires `X-PicSearch-Token`. `/thumb` and `/file` additionally accept `?t=`
because `<img src>` cannot set headers. There is no flag that turns this off —
not for dev, not for tests. Without it any local process could read the user's
photo index.

**The parent watchdog is not optional.** An orphaned uvicorn holding 2 GB of
VRAM after a Tauri crash is the #1 failure mode of this architecture. Rust kills
the child on exit; this thread is what survives `pkill -9` on Rust.

The response shape is frozen and mirrors `src/lib/types.ts`, which is real
typechecked code and therefore the authority. `search.hydrate` emits it
directly — `ocrText`/`snippet` are present-and-**null** when an image has no
OCR text, and `score` is *absent* (not null) when browsing, because types.ts
declares it optional.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from . import config, imaging, models, ocr, paths, system
from .embed import REGISTRY, Embedder, spec_for
from .index import EMBED_MAX_EDGE, Indexer
from .search import (
    DEFAULT_LIMIT,
    DEFAULT_SORTED_KEEP,
    NOW_LOCAL_SQL,
    Searcher,
    SearchParams,
    VectorIndex,
    hydrate,
)
from .store import Store
from .watch import FolderWatcher

log = logging.getLogger("picsearch.server")

# How long a search waits for the startup date refresh before answering anyway.
DATES_WAIT_SEC = 5.0

TOKEN_HEADER = "X-PicSearch-Token"


# ---------------------------------------------------------------------------
# Request bodies. Responses are dicts straight from search.hydrate.
# ---------------------------------------------------------------------------

class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SimilarFilters(Camel):
    """The metadata filters a similar lookup honours — `Filters` in types.ts.
    Both `image_id` and `imageId` style spellings are accepted (`Camel`), because
    api.ts posts snake_case here while responses are camelCase."""

    date: str | None = None
    date_from: str | None = None
    date_to: str | None = None
    dims: str | None = None
    folders: list[str] = []
    types: list[str] = []


class SimilarRequest(SimilarFilters):
    image_id: int


class SimilarFileRequest(SimilarFilters):
    path: str


class PauseRequest(Camel):
    paused: bool


class IdsRequest(Camel):
    ids: list[int]


class IdRequest(Camel):
    id: int


class FolderRequest(Camel):
    path: str | None = None
    recursive: bool = True


class NameRequest(Camel):
    name: str


class SavedSearchRequest(Camel):
    query: str
    view: str | None = None
    collection: str | None = None
    filters: dict[str, Any] | None = None


class SettingsRequest(Camel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


# `Filters` in types.ts, with every key present. A saved search written before a
# filter existed must still deserialize into the full shape.
EMPTY_FILTERS: dict[str, Any] = {
    "datePreset": None, "dateFrom": None, "dateTo": None,
    "folders": [], "types": [], "dims": None,
}


def saved_search_payload(row) -> dict:
    """Wire shape of `SavedSearch` in types.ts."""
    try:
        data = json.loads(row["query_json"])
    except (TypeError, ValueError):
        # Hand-edited or truncated JSON degrades to a plain text search rather
        # than breaking the whole sidebar list.
        data = {}
    return {
        "id": str(int(row["id"])),
        "query": data.get("q") or row["name"],
        "view": data.get("view"),
        "collection": data.get("collection"),
        "filters": {**EMPTY_FILTERS, **(data.get("filters") or {})},
    }


# ---------------------------------------------------------------------------
# Event bus (SSE)
# ---------------------------------------------------------------------------

class EventBus:
    """Fan-out from worker threads to SSE subscribers on the event loop."""

    def __init__(self):
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self.last: dict[str, dict] = {}

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def publish(self, kind: str, payload: dict) -> None:
        self.last[kind] = payload
        event = {"type": kind, **payload}
        loop = self._loop
        if(loop is None):
            return
        with self._lock:
            targets = list(self._subscribers)
        for q in targets:
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except (RuntimeError, asyncio.QueueFull):
                continue


# ---------------------------------------------------------------------------
# App state
# ---------------------------------------------------------------------------

class AppState:
    def __init__(
        self,
        db: Path | None = None,
        model_id: str | None = None,
        embedder: Any | None = None,
        embedder_factory: Any | None = None,
        weights_present: Any | None = None,
    ):
        # Injectable like the embedders: a test has no HuggingFace cache and must
        # not start a real download to switch models.
        self.weights_present = weights_present or models.has_weights
        self.token = secrets.token_urlsafe(32)
        self.store = Store(db)
        self.settings = config.load()
        self.model_id = model_id or self.settings.get("modelId")
        try:
            self.spec = spec_for(self.model_id)
        except KeyError:
            # A hand-edited or stale config.toml must not stop the app booting.
            # The file is left as it is; only this run uses the default.
            fallback = config.DEFAULTS["modelId"]
            log.warning("model %r is not in the registry; using %s", self.model_id, fallback)
            self.model_id = fallback
            self.spec = spec_for(fallback)
        # Injectable so tests can drive the whole API without loading weights.
        # The factory builds the *second*, incoming embedder during a swap, and
        # is injectable for the same reason.
        self.embedder = embedder if embedder is not None else Embedder(self.model_id)
        self.embedder_factory = embedder_factory if embedder_factory is not None else Embedder
        self.vectors = VectorIndex.load(self.store, self.model_id, self.spec.dim)
        # Late-bound: a promotion replaces `self.vectors`, and a row deleted
        # afterwards has to leave the *new* index.
        self.store.add_delete_listener(lambda ids: self.vectors.remove(ids))
        self.events = EventBus()
        self.downloads = models.Downloads(self.events.publish)
        # resolve() never raises: an OCR engine that is not installed degrades
        # to no OCR with a warning, rather than a sidecar that will not boot.
        self.ocr = ocr.resolve(self.settings.get("ocrEngineId"), self.settings.get("ocrLangs"))
        self.indexer = Indexer(
            self.store,
            self.embedder,
            ocr=self.ocr,
            on_event=self._on_event,
            on_vector=self._on_vector,
        )
        # Constructed, not started: `create_app`'s lifespan owns that, so the
        # tests that build an AppState per case do not each spawn inotify
        # observer threads on the host filesystem.
        self.watcher = FolderWatcher(self.store, self.indexer)
        self.searcher = Searcher(self.store, self.vectors, self.embedder)
        # A swap in flight. `model_id` stays on the model that still answers
        # searches; this one is being embedded in the background by its own
        # Embedder, because both models have to be resident at once.
        self.pending_model_id: str | None = self.settings.get("pendingModelId")
        self.pending_embedder: Any | None = None
        self.started = time.time()
        # Set once every row's date follows the current `dates` rules. Search
        # waits on it briefly (`DATES_WAIT_SEC`) so the first grid after an
        # upgrade is not ordered by the dates it is about to replace.
        self.dates_ready = threading.Event()
        if(self.store.dates_stale() and self.store.image_count() == 0):
            # Nothing to re-derive: a fresh library is born on the current rules.
            self.store.refresh_dates()
        if(not self.store.dates_stale()):
            self.dates_ready.set()

    def refresh_dates(self) -> None:
        """Re-derive every row's date under the current rules, then tell the UI.

        Runs on its own thread from the lifespan: EXIF headers for a large
        library take a while, and the handshake must not wait for them.
        """
        try:
            started = time.perf_counter()
            count = self.store.refresh_dates()
            log.info("dates: re-derived %d rows in %.1fs", count, time.perf_counter() - started)
        except Exception:
            log.exception("date refresh failed")
            return
        finally:
            self.dates_ready.set()
        self.events.publish("dates-refreshed", {"count": count})

    def _on_event(self, kind: str, payload: dict) -> None:
        self.events.publish(kind, payload)
        # A swap asked for while a scan held the ingest slot was deferred, and
        # nothing else would ever start it: the boot scan runs before the
        # lifespan resumes a pending swap.
        if(kind == "scan-complete" and self.pending_model_id is not None):
            threading.Thread(target=self._retry_swap, name="swap-retry", daemon=True).start()

    def _retry_swap(self) -> None:
        self.indexer.join()
        model_id = self.pending_model_id
        if(model_id is None or self.indexer.running or self.indexer.status.running):
            return
        try:
            self.begin_model_swap(model_id)
        except Exception:
            log.exception("deferred model swap failed to start")

    def _on_vector(self, image_id: int, vector) -> None:
        try:
            self.vectors.add(image_id, vector)
        except ValueError:
            log.warning("vector for image %s does not fit the active index", image_id)

    # -- model swapping -----------------------------------------------------

    def coverage(self, model_id: str) -> tuple[int, int]:
        """(vectors, images) for `model_id`."""
        return self.store.embedding_count(model_id), self.store.image_count()

    def begin_model_swap(self, model_id: str) -> bool:
        """Start embedding the library with `model_id` in the background.

        The active model does not change here. Search keeps answering from the
        vectors it already has for the whole run — that is the entire reason
        the old model's rows are never deleted. `promote_model` flips it once
        coverage is complete.
        """
        spec_for(model_id)
        if(model_id == self.model_id):
            self.clear_pending()
            return False
        self.pending_model_id = model_id
        # `modelId` is written explicitly rather than left to the merge: it must
        # name the model that is *actually serving*, so a sidecar that dies mid
        # swap comes back searching. A `--model` override on the command line
        # would otherwise leave config naming something else entirely.
        self.settings = config.save({"modelId": self.model_id, "pendingModelId": model_id})
        if(not self.weights_present(model_id)):
            # Weights first, with a progress bar, instead of a silent download
            # buried in the backfill. The swap carries on when they land, and a
            # restart mid-download resumes it from `pendingModelId`.
            started = self.downloads.start(
                model_id, then=lambda: self._continue_swap(model_id), failed=self.clear_pending
            )
            if(not started):
                self.clear_pending()
                raise RuntimeError("another model is downloading")
            return True
        return self._continue_swap(model_id)

    def _continue_swap(self, model_id: str) -> bool:
        """The swap once the weights are on disk: promote at once when the
        library is already fully embedded, otherwise start the backfill."""
        if(self.pending_model_id != model_id):
            return False  # cancelled, or replaced by another choice, while downloading
        done, total = self.coverage(model_id)
        if(total > 0 and done >= total):
            # Switching back to a model that is already fully embedded, which
            # is what keeping the old rows buys. No GPU work at all.
            self.promote_model()
            return False
        # Its own Embedder: `Embedder` holds one resident model, and the live
        # one is still answering queries. Kept across retries — a fresh one per
        # call would drop weights a backfill pass has already loaded.
        held = self.pending_embedder
        if(held is None or getattr(held, "model_id", model_id) != model_id):
            self.pending_embedder = self.embedder_factory(model_id)
        started = self.indexer.start_model_backfill(
            model_id, self.pending_embedder, on_done=self.promote_model
        )
        if(not started):
            log.info("model backfill for %s deferred: ingest slot busy", model_id)
        return started

    def promote_model(self) -> None:
        """Make the pending model the active one. Called when coverage is full."""
        model_id = self.pending_model_id
        if(model_id is None):
            return
        done, total = self.coverage(model_id)
        if(total > 0 and done < total):
            log.warning(
                "not promoting %s: %d of %d images embedded", model_id, done, total
            )
            return
        # Hand over the embedder that just did the work — it already has the
        # incoming model resident, so promotion costs no load and there is no
        # moment where the shared embedder is half-switched.
        incoming = self.pending_embedder
        outgoing = self.embedder
        if(incoming is not None):
            spec = spec_for(model_id)
            vectors = VectorIndex.load(self.store, model_id, spec.dim)
            self.model_id = model_id
            self.spec = spec
            self.vectors = vectors
            self.embedder = incoming
            self.indexer.embedder = incoming
            # One assignment, so no in-flight request can embed a query with one
            # model and scan the other's index.
            self.searcher.swap(vectors, incoming)
            self.pending_embedder = None
            if(outgoing is not incoming):
                unload = getattr(outgoing, "unload", None)
                if(unload is not None):
                    unload()   # give the outgoing model's VRAM back
        else:
            self.switch_model(model_id)
        self.settings = config.save({"modelId": model_id, "pendingModelId": None})
        self.clear_pending()
        self.events.publish("model-changed", {"modelId": model_id})
        log.info("active model is now %s (%d vectors)", model_id, self.vectors.size)

    def clear_pending(self) -> None:
        self.pending_model_id = None
        if(self.pending_embedder is not None):
            unload = getattr(self.pending_embedder, "unload", None)
            if(unload is not None):
                unload()
            self.pending_embedder = None
        if(self.settings.get("pendingModelId") is not None):
            self.settings = config.save({"pendingModelId": None})

    def resume_model_swap(self) -> None:
        """Pick an interrupted swap back up at boot.

        `embed_missing` is keyed on what is missing, so nothing is embedded
        twice — a sidecar killed at 41% resumes at 41%.
        """
        model_id = self.settings.get("pendingModelId")
        if(model_id is None):
            return
        try:
            self.begin_model_swap(model_id)
        except KeyError:
            # The config names a model that no longer exists in the registry.
            log.warning("pending model %s is unknown; abandoning the swap", model_id)
            self.clear_pending()

    def switch_model(self, model_id: str) -> None:
        """Switch the resident model in place. Only for the case where no
        pending embedder exists — `promote_model` hands its own over instead."""
        spec = spec_for(model_id)
        self.embedder.switch(model_id)
        self.model_id = model_id
        self.spec = spec
        self.vectors = VectorIndex.load(self.store, model_id, spec.dim)
        self.searcher.swap(self.vectors, self.embedder)

    def switch_ocr(self, engine_id: str | None, langs: Any | None) -> bool:
        """Rebuild the OCR engine. True when the effective engine changed.

        Only the *effective* identity matters: asking for tesseract `tur+eng` on
        a machine without `tur.traineddata` resolves to `eng` both times, and
        re-reading the library would achieve nothing.
        """
        before = (self.ocr.id, self.ocr.langs_key) if self.ocr is not None else None
        self.ocr = ocr.resolve(engine_id, langs)
        after = (self.ocr.id, self.ocr.langs_key) if self.ocr is not None else None
        self.indexer.set_ocr(self.ocr)
        return before != after


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def _token_of(request: Request) -> str:
    return request.app.state.picsearch.token


def _token_matches(supplied: str, request: Request) -> bool:
    # Bytes: compare_digest raises TypeError on a non-ASCII str, which answered
    # a bad token with a 500 instead of a 401.
    return secrets.compare_digest(supplied.encode(), _token_of(request).encode())


async def require_token(request: Request) -> None:
    supplied = request.headers.get(TOKEN_HEADER)
    if(supplied is None or not _token_matches(supplied, request)):
        raise HTTPException(status_code=401, detail="missing or invalid token")


async def require_token_or_query(request: Request, t: str | None = Query(default=None)) -> None:
    """`<img src>` cannot set headers, so bytes routes also take `?t=`."""
    supplied = request.headers.get(TOKEN_HEADER) or t
    if(supplied is None or not _token_matches(supplied, request)):
        raise HTTPException(status_code=401, detail="missing or invalid token")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

def create_app(state: AppState) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # The event bus fans out from ingest worker threads, so it needs the
        # serving loop to hand work back to.
        state.events.bind(asyncio.get_running_loop())
        state.watcher.start()
        if(not state.dates_ready.is_set()):
            threading.Thread(target=state.refresh_dates, name="dates", daemon=True).start()
        # A swap interrupted by a crash or a quit picks up where it stopped —
        # `embed_missing` is keyed on what is missing, so nothing is redone.
        state.resume_model_swap()
        try:
            yield
        finally:
            state.watcher.stop()

    app = FastAPI(
        title="picsearch sidecar", version="1.0.3",
        docs_url=None, redoc_url=None, lifespan=lifespan,
    )
    app.state.picsearch = state

    # The frontend is served from tauri://localhost (or :1420 in dev), so every
    # request is cross-origin. The token — not the origin — is the gate.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    guard = Depends(require_token)
    bytes_guard = Depends(require_token_or_query)

    # -- health ------------------------------------------------------------

    @app.get("/health", dependencies=[guard])
    def health() -> dict:
        return {
            "ok": True,
            "modelId": state.model_id,
            "modelLoaded": state.embedder.loaded,
            "device": state.embedder.device,
            "dim": state.spec.dim,
            "images": state.store.image_count(),
            "vectors": state.vectors.size,
            "ocrEngine": None if state.ocr is None else state.ocr.id,
            "ocrLangs": None if state.ocr is None else state.ocr.langs_key,
            "watching": len(state.watcher.roots()),
            "indexing": state.indexer.status.as_wire(),
            "pendingModelId": state.pending_model_id,
            "uptimeSec": round(time.time() - state.started, 1),
        }

    @app.get("/ocr", dependencies=[guard])
    def ocr_status() -> dict:
        """The live engine, plus what to install when the configured one is
        missing something. Settings shows `hint` verbatim."""
        return {
            "engine": None if state.ocr is None else state.ocr.id,
            "langs": None if state.ocr is None else state.ocr.langs_key,
            "hint": ocr.install_hint(
                state.settings.get("ocrEngineId"), state.settings.get("ocrLangs")
            ),
        }

    @app.get("/counts", dependencies=[guard])
    def counts() -> dict:
        """Sidebar counts, over the whole library rather than the current page.

        The sidebar used to read these off the last search response, so "All"
        showed however many results the current query returned and "Duplicates"
        counted only the loaded window. Both were wrong the moment anyone typed.
        """
        # "Recent" reads `taken_at`; the first count after an upgrade must not
        # be taken from the dates the startup refresh is about to replace.
        state.dates_ready.wait(DATES_WAIT_SEC)
        recent = int(state.store.conn().execute(
            f"SELECT count(*) AS n FROM images WHERE images.taken_at >= {NOW_LOCAL_SQL}",
            ("-7 days",),
        ).fetchone()["n"])
        per_collection = {
            str(int(r["id"])): state.store.collection_count(int(r["id"]))
            for r in state.store.list_collections()
        }
        return {
            "library": state.store.image_count(),
            "recent": recent,
            "dupes": len(state.searcher.dupes.ids),
            "collections": per_collection,
        }

    # -- search ------------------------------------------------------------

    def _int_setting(key: str, fallback: int) -> int:
        """A hand-edited config.toml can put anything in any key, and `load()`
        copies values through without checking them. Search degrades to the
        default rather than answering 500 to `textWeight = "fifty"`."""
        try:
            return int(state.settings.get(key, fallback))
        except (TypeError, ValueError):
            return fallback

    def _params(
        q: str = "",
        view: str | None = None,
        collection: str | None = None,
        date: str | None = None,
        date_from: str | None = Query(default=None, alias="from"),
        date_to: str | None = Query(default=None, alias="to"),
        dims: str | None = None,
        folder: list[str] = Query(default_factory=list),
        type: list[str] = Query(default_factory=list),
        sort: str = "",
        limit: int = DEFAULT_LIMIT,
        cursor: str | None = None,
        weak: bool = False,
    ) -> SearchParams:
        # A first request after an upgrade waits for the date refresh rather
        # than rendering an order it is about to replace. Bounded, because a
        # huge library must still answer; `dates-refreshed` covers the rest.
        state.dates_ready.wait(DATES_WAIT_SEC)
        return SearchParams(
            q=q, view=view, collection=collection, date=date, dims=dims,
            date_from=date_from, date_to=date_to,
            folders=list(folder), types=list(type),
            limit=max(1, min(limit, 1000)), cursor=cursor, sort=sort,
            # Read per request, not captured at startup: `PUT /settings` writes
            # them live and the next query has to answer with them.
            text_weight=_int_setting("textWeight", 50),
            sorted_keep=max(1, _int_setting("sortedSearchKeep", DEFAULT_SORTED_KEEP)),
            strictness=_int_setting("matchStrictness", 50), weak=weak,
        )

    @app.get("/search", dependencies=[guard])
    def search(params: SearchParams = Depends(_params)) -> dict:
        return state.searcher.search(params)

    @app.get("/timeline", dependencies=[guard])
    def timeline(params: SearchParams = Depends(_params)) -> dict:
        """Photos per month for the same query `/search` would answer, so the
        scrubber can place months that are not loaded yet."""
        return state.searcher.timeline(params)

    def _filter_params(body: SimilarFilters) -> SearchParams:
        state.dates_ready.wait(DATES_WAIT_SEC)
        return SearchParams(
            date=body.date, dims=body.dims, date_from=body.date_from, date_to=body.date_to,
            folders=list(body.folders), types=list(body.types),
        )

    @app.post("/search/similar", dependencies=[guard])
    def similar(body: SimilarRequest) -> dict:
        """Neighbours of an indexed image, narrowed by the same filters `/search` takes."""
        return state.searcher.similar(body.image_id, params=_filter_params(body))

    @app.post("/search/similar-file", dependencies=[guard])
    def similar_file(body: SimilarFileRequest) -> dict:
        """Neighbours of a local image file, same response as `/search/similar`.

        An indexed file reuses its stored vector. Any other is decoded the way
        ingest decodes, embedded with the serving model, and forgotten — it is
        never added to the library.
        """
        path = Path(body.path).expanduser()
        if(not path.is_file()):
            raise HTTPException(status_code=404, detail=f"not a file: {path}")
        if(not imaging.is_supported(path)):
            raise HTTPException(status_code=415, detail=f"not a supported image: {path.name}")
        params = _filter_params(body)
        row = state.store.image_by_path(str(path))
        if(row is None and path.resolve() != path):
            row = state.store.image_by_path(str(path.resolve()))
        if(row is not None):
            return state.searcher.similar(int(row["id"]), params=params)
        try:
            with imaging.open_image(path) as img:
                small = img.copy()
            small.thumbnail((EMBED_MAX_EDGE, EMBED_MAX_EDGE), Image.Resampling.LANCZOS)
        except Exception as exc:
            raise HTTPException(
                status_code=422, detail=f"cannot read {path.name} as an image: {exc}"
            ) from exc
        return state.searcher.similar_to_image(small, params=params)

    @app.get("/images/{image_id}", dependencies=[guard])
    def image_detail(image_id: int) -> dict:
        items = hydrate(state.store, [image_id], dupes=state.searcher.dupes.ids)
        if(not items):
            raise HTTPException(status_code=404, detail="no such image")
        return items[0]

    @app.delete("/images", dependencies=[guard])
    def delete_images(body: IdsRequest) -> dict:
        """Moves each image's file to the system trash, then drops its row.

        Only paths of indexed rows are ever touched, and a file the trash refuses
        is never deleted another way: its id comes back in `failed` and its row
        stays. An id with no row is ignored, and so is a file that is already
        gone (its row just goes). Thumbnails stay — they are content-addressed
        and a duplicate elsewhere may still use them. The watcher sees the file
        vanish too; whichever of the two drops the row first, the other finds
        nothing to do.
        """
        done: list[int] = []
        failed: list[int] = []
        for image_id in dict.fromkeys(body.ids):
            row = state.store.image_by_id(image_id)
            if(row is None):
                continue
            path = Path(row["path"])
            try:
                if(os.path.lexists(path)):
                    system.move_to_trash(path)
            except FileNotFoundError:
                pass   # vanished between the check and the move: nothing left to trash
            except Exception as exc:
                log.warning("could not move %s to the trash: %s", path, exc)
                failed.append(image_id)
                continue
            done.append(image_id)
        state.store.delete_images(done)
        return {"removed": len(done), "failed": failed}

    # -- bytes -------------------------------------------------------------

    @app.get("/thumb/{image_id}", dependencies=[bytes_guard])
    def thumb(image_id: int, size: int = 256) -> FileResponse:
        if(size not in (256, 512)):
            raise HTTPException(status_code=400, detail="size must be 256 or 512")
        row = state.store.image_by_id(image_id)
        if(row is None):
            raise HTTPException(status_code=404, detail="no such image")
        path = paths.thumb_path(row["sha256"], size)
        if(not path.exists()):
            # Thumbnails are generated at ingest, never on demand.
            raise HTTPException(status_code=404, detail="thumbnail not generated")
        return FileResponse(path, media_type="image/webp")

    @app.get("/file/{image_id}", dependencies=[bytes_guard])
    def original(image_id: int) -> FileResponse:
        row = state.store.image_by_id(image_id)
        if(row is None):
            raise HTTPException(status_code=404, detail="no such image")
        path = Path(row["path"])
        if(not path.exists()):
            raise HTTPException(status_code=410, detail="file has moved or been deleted")
        return FileResponse(path, media_type=row["mime"])

    # -- folders -----------------------------------------------------------

    def folder_payload() -> list[dict]:
        return [
            {
                "path": r["path"],
                "count": state.store.folder_count(r["path"]),
                "recursive": bool(r["recursive"]),
            }
            for r in state.store.list_folders()
        ]

    @app.get("/folders", dependencies=[guard])
    def list_folders() -> list[dict]:
        return folder_payload()

    @app.post("/folders", dependencies=[guard])
    def add_folder(body: FolderRequest | None = None) -> dict | None:
        # A bodiless POST means "the UI has no path yet" — the native picker is
        # Tauri's job (build step 5b), so answer null rather than guessing.
        if(body is None or not body.path):
            return None
        path = Path(body.path).expanduser()
        if(not path.is_dir()):
            raise HTTPException(status_code=400, detail=f"not a directory: {path}")
        state.store.add_folder(str(path), body.recursive)
        # Watch it from now on, then walk what is already there.
        state.watcher.sync()
        state.indexer.start_rescan()
        return {"path": str(path), "count": state.store.folder_count(str(path)),
                "recursive": body.recursive}

    @app.delete("/folders", dependencies=[guard])
    def remove_folder(path: str) -> dict:
        """Stops watching `path` and drops its photos from the library. The files
        on disk are never touched."""
        watched = any(r["path"] == path for r in state.store.list_folders())
        state.store.remove_folder(path)
        state.watcher.sync()
        # Only a folder that was really watched: an unknown path must not be
        # able to empty whatever subtree it names.
        removed = state.indexer.drop_folder_images(path) if watched else 0
        return {"ok": True, "removed": removed}

    @app.patch("/folders", dependencies=[guard])
    def patch_folder(body: FolderRequest) -> dict:
        if(not body.path):
            raise HTTPException(status_code=400, detail="path is required")
        state.store.set_folder_recursive(body.path, body.recursive)
        # `recursive` changes which events count, so the observer is re-attached.
        state.watcher.sync()
        return {"ok": True}

    @app.post("/indexing/pause", dependencies=[guard])
    def pause_indexing(body: PauseRequest) -> dict:
        """Session-only. Work stops between files and batches and resumes where it
        stopped; the flag is not persisted, so a restart starts running."""
        state.indexer.pause(body.paused)
        return state.indexer.status.as_wire()

    @app.post("/rescan", dependencies=[guard])
    def rescan() -> dict:
        return {"started": state.indexer.start_rescan()}

    # -- collections -------------------------------------------------------

    # Ids go over the wire as strings: `Collection.id` in types.ts is a string,
    # and the mock adapter's ids ("refs", "memes") were never numeric.

    @app.get("/collections", dependencies=[guard])
    def list_collections() -> list[dict]:
        return [
            {"id": str(int(r["id"])), "name": r["name"]}
            for r in state.store.list_collections()
        ]

    @app.post("/collections", dependencies=[guard])
    def create_collection(body: NameRequest) -> dict:
        name = body.name.strip()
        if(not name):
            raise HTTPException(status_code=400, detail="name is required")
        row = state.store.create_collection(name)
        return {"id": str(int(row["id"])), "name": row["name"]}

    @app.delete("/collections/{collection_id}", dependencies=[guard])
    def delete_collection(collection_id: int) -> dict:
        if(not state.store.delete_collection(collection_id)):
            raise HTTPException(status_code=404, detail="no such collection")
        return {"ok": True}

    @app.patch("/collections/{collection_id}", dependencies=[guard])
    def rename_collection(collection_id: int, body: NameRequest) -> dict:
        name = body.name.strip()
        if(not name):
            raise HTTPException(status_code=400, detail="name is required")
        if(not state.store.rename_collection(collection_id, name)):
            raise HTTPException(status_code=404, detail="no such collection")
        return {"id": str(collection_id), "name": name}

    @app.post("/collections/{collection_id}/items", dependencies=[guard])
    def add_collection_items(collection_id: int, body: IdsRequest) -> dict:
        _require_collection(collection_id)
        added = state.store.add_to_collection(collection_id, body.ids)
        return {"added": added, "count": state.store.collection_count(collection_id)}

    @app.delete("/collections/{collection_id}/items", dependencies=[guard])
    def remove_collection_items(collection_id: int, body: IdsRequest) -> dict:
        _require_collection(collection_id)
        removed = state.store.remove_from_collection(collection_id, body.ids)
        return {"removed": removed, "count": state.store.collection_count(collection_id)}

    def _require_collection(collection_id: int) -> None:
        known = {int(r["id"]) for r in state.store.list_collections()}
        if(collection_id not in known):
            # Without this the insert fails on the foreign key and returns 500;
            # a request naming a collection that was deleted in another window
            # is a 404.
            raise HTTPException(status_code=404, detail="no such collection")

    # -- saved searches ----------------------------------------------------

    @app.get("/searches", dependencies=[guard])
    def list_searches() -> list[dict]:
        return [saved_search_payload(r) for r in state.store.list_saved_searches()]

    @app.post("/searches", dependencies=[guard])
    def create_search(body: SavedSearchRequest) -> dict:
        query = body.query.strip()
        if(not query):
            raise HTTPException(status_code=400, detail="query is required")
        # The full search is stored, not just the words: `filters` and `view`
        # ride along so running a saved search restores what was on screen. The
        # `name` column holds the query text — there is no separate naming step.
        payload = json.dumps({
            "q": query,
            "view": body.view,
            "collection": body.collection,
            "filters": body.filters or {},
        })
        row = state.store.create_saved_search(query, payload)
        return saved_search_payload(row)

    @app.delete("/searches/{search_id}", dependencies=[guard])
    def delete_search(search_id: int) -> dict:
        if(not state.store.delete_saved_search(search_id)):
            raise HTTPException(status_code=404, detail="no such saved search")
        return {"ok": True}

    # -- settings ----------------------------------------------------------

    def settings_payload() -> dict:
        """`modelId` is the model answering searches right now, which during a
        swap is still the outgoing one. `pendingModelId` is what is being
        embedded; the UI shows progress against that."""
        done, total = (0, 0)
        if(state.pending_model_id is not None):
            done, total = state.coverage(state.pending_model_id)
        return {
            **state.settings,
            "modelId": state.model_id,
            "pendingModelId": state.pending_model_id,
            "pendingCoverage": {"done": done, "total": total},
        }

    @app.get("/settings", dependencies=[guard])
    def get_settings() -> dict:
        return settings_payload()

    @app.put("/settings", dependencies=[guard])
    def put_settings(body: SettingsRequest) -> dict:
        incoming = body.model_dump(by_alias=True, exclude_none=True)
        wanted = incoming.pop("modelId", None)
        swapping = wanted is not None and wanted != state.model_id
        if(swapping):
            # Reject unknown ids before anything is persisted, as a 400 — a
            # bare KeyError here reaches the frontend as an opaque 500.
            try:
                spec_for(wanted)
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        touches_ocr = "ocrEngineId" in incoming or "ocrLangs" in incoming
        state.settings = config.save(incoming)
        if(swapping):
            # `modelId` is deliberately *not* written here. It moves in
            # `promote_model`, once the incoming model can actually answer a
            # query — until then search keeps running on the outgoing one.
            try:
                state.begin_model_swap(wanted)
            except RuntimeError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
        if(touches_ocr):
            changed = state.switch_ocr(
                state.settings.get("ocrEngineId"), state.settings.get("ocrLangs")
            )
            # Changing the engine in Settings has to *do* something. Screenshots
            # whose stored (engine, langs) no longer match are re-read in the
            # background; unchanged ones cost one query.
            if(changed):
                state.indexer.start_ocr_backfill()
        return settings_payload()

    # -- model files -------------------------------------------------------

    def _known_model(model_id: str) -> None:
        try:
            spec_for(model_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown model {model_id!r}") from exc

    @app.get("/models", dependencies=[guard])
    def list_models() -> dict:
        """What is on disk for every model in the registry, and the download in
        flight if there is one."""
        return {
            "models": [
                {
                    **models.status(model_id),
                    "active": model_id == state.model_id,
                    "pending": model_id == state.pending_model_id,
                }
                for model_id in REGISTRY
            ],
            "download": state.downloads.current,
        }

    @app.post("/models/{model_id}/download", dependencies=[guard])
    def download_model(model_id: str) -> dict:
        _known_model(model_id)
        if(state.weights_present(model_id)):
            return {"started": False}
        if(not state.downloads.start(model_id)):
            raise HTTPException(status_code=409, detail="another model is downloading")
        return {"started": True}

    @app.delete("/models/{model_id}", dependencies=[guard])
    def delete_model(model_id: str) -> dict:
        """Delete a model's files. Its vectors stay in the library, so switching
        back costs a download and no re-index."""
        _known_model(model_id)
        if(model_id == state.model_id):
            raise HTTPException(
                status_code=409, detail="this model is in use; switch to another first"
            )
        if(model_id == state.pending_model_id):
            raise HTTPException(status_code=409, detail="this model is being switched to")
        if(state.downloads.active(model_id)):
            raise HTTPException(status_code=409, detail="this model is downloading")
        try:
            freed = models.delete(model_id)
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail=f"could not delete the files: {exc}"
            ) from exc
        state.events.publish("model-deleted", {"modelId": model_id})
        return {"freed": freed}

    # -- storage -----------------------------------------------------------

    @app.get("/storage", dependencies=[guard])
    def storage() -> dict:
        gb = 1024 ** 3
        db = paths.db_path()
        return {
            "thumbnailCacheGb": round(paths.dir_size_bytes(paths.thumbs_dir()) / gb, 3),
            "indexGb": round((db.stat().st_size if db.exists() else 0) / gb, 3),
        }

    @app.delete("/storage/thumbnails", dependencies=[guard])
    def clear_thumbs() -> dict:
        shutil.rmtree(paths.thumbs_dir(), ignore_errors=True)
        paths.thumbs_dir().mkdir(parents=True, exist_ok=True)
        # Thumbnails exist only from ingest; a rescan rewrites the missing ones.
        state.indexer.start_rescan()
        return {"ok": True}

    # -- shell integration -------------------------------------------------

    @app.post("/reveal", dependencies=[guard])
    def reveal(body: IdsRequest) -> dict:
        opened = 0
        for image_id in body.ids[:8]:
            row = state.store.image_by_id(image_id)
            if(row is None):
                continue
            if(_spawn(["xdg-open", str(Path(row["path"]).parent)])):
                opened += 1
        return {"opened": opened}

    @app.post("/open", dependencies=[guard])
    def open_external(body: IdRequest) -> dict:
        row = state.store.image_by_id(body.id)
        if(row is None):
            raise HTTPException(status_code=404, detail="no such image")
        return {"opened": _spawn(["xdg-open", row["path"]])}

    # -- events ------------------------------------------------------------

    @app.get("/events", dependencies=[guard])
    async def events(request: Request) -> StreamingResponse:
        queue = state.events.subscribe()
        log.info("client subscribed to /events (%d live)", state.events.subscriber_count)

        async def stream():
            # No is_disconnected() poll here: starlette cancels this generator
            # when the client goes away, and the poll deadlocks under TestClient.
            try:
                snapshot = {"type": "index", **state.indexer.status.as_wire()}
                yield f"data: {json.dumps(snapshot)}\n\n"
                while(True):
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield f"data: {json.dumps(event)}\n\n"
            except asyncio.CancelledError:
                raise
            finally:
                state.events.unsubscribe(queue)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


def _spawn(argv: list[str]) -> bool:
    try:
        subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError as exc:
        log.warning("failed to spawn %s: %s", argv, exc)
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _bind(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    sock.set_inheritable(True)
    return sock


LOG_FILE = "sidecar.log"


class _TolerantStream:
    """A text stream whose write and flush never raise OSError.

    stderr here is a pipe somebody else reads. When that reader goes away,
    Windows answers the next flush with `OSError: [Errno 22]`, and tqdm, which
    flushes stderr from inside `from_pretrained`, turned a closed pipe into a
    model that could not load. Logging goes to `sidecar.log` as well, so a dead
    stderr loses nothing that matters.
    """

    def __init__(self, inner):
        self._inner = inner

    def write(self, text):
        try:
            return self._inner.write(text)
        except OSError:
            return len(text)

    def flush(self):
        try:
            self._inner.flush()
        except OSError:
            pass

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _harden_stdio() -> None:
    """UTF-8 on both streams, and a stderr that cannot break the process.

    The code page of a Windows console (cp1254 on a Turkish one) is not UTF-8,
    and the shell reads these pipes as UTF-8.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass  # not a TextIOWrapper: a test's capture, or already replaced
    sys.stderr = _TolerantStream(sys.stderr)


def _setup_logging(level: str) -> None:
    """stderr as always, plus `sidecar.log` in the data dir.

    The desktop shell keeps the sidecar's stderr in memory only, so a problem on
    someone else's machine used to leave nothing to read. 1 MB x 3 files, so it
    cannot grow without bound.
    """
    from logging.handlers import RotatingFileHandler

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]  # stdout is the handshake
    try:
        handlers.append(RotatingFileHandler(
            paths.data_dir() / LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8",
        ))
    except OSError:
        pass  # a read-only data dir must not stop the app from starting
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )
    logging.captureWarnings(True)

    def crashed(exc_type, exc, tb):
        logging.getLogger("picsearch").critical("uncaught exception", exc_info=(exc_type, exc, tb))

    sys.excepthook = crashed
    threading.excepthook = lambda a: crashed(a.exc_type, a.exc_value, a.exc_traceback)


def _log_startup(state: "AppState") -> None:
    """The facts a bug report needs, in one place at the top of the log."""
    import platform

    import numpy as np

    from . import __version__

    matrix = state.vectors.matrix
    log.info(
        "picsearch %s on %s, python %s, data %s", __version__, platform.platform(),
        platform.python_version(), paths.data_dir(),
    )
    log.info(
        "model %s: %d images, %d vectors, non-finite vector values: %d",
        state.model_id, state.store.image_count(), state.vectors.size,
        int(matrix.size - np.count_nonzero(np.isfinite(matrix))),
    )
    try:
        log.info("trash backend: %s", system.trash_backend().__module__)
    except Exception as exc:
        log.warning("trash backend: %s", exc)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="picsearch sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 picks an ephemeral port")
    parser.add_argument("--model", default=None)
    parser.add_argument("--parent-pid", type=int, default=None)
    parser.add_argument("--log-level", default="info")
    parser.add_argument("--scan-on-start", action="store_true")
    args = parser.parse_args(argv)

    _harden_stdio()
    _setup_logging(args.log_level)

    state = AppState(model_id=args.model)
    _log_startup(state)
    app = create_app(state)
    system.start_parent_watchdog(args.parent_pid)

    sock = _bind(args.host, args.port)
    port = sock.getsockname()[1]

    # Exactly one JSON line, before serving. Rust reads this and nothing else.
    sys.stdout.write(json.dumps({"port": port, "token": state.token}) + "\n")
    sys.stdout.flush()

    if(args.scan_on_start):
        state.indexer.start_rescan()

    import uvicorn

    server = uvicorn.Server(uvicorn.Config(
        app, log_level=args.log_level, access_log=False, lifespan="on",
        # `/events` never ends on its own; without a bound SIGTERM waited for the
        # client to hang up, which the app's own webview never does.
        timeout_graceful_shutdown=2,
    ))
    server.run(sockets=[sock])
    return 0


if(__name__ == "__main__"):
    raise SystemExit(main())
