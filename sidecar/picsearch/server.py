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
directly — `ocrText`/`snippet` are present-and-null until step 8, and `score`
is *absent* (not null) when browsing, because types.ts declares it optional.
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
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from . import config, paths
from .embed import Embedder, spec_for
from .index import Indexer
from .search import DEFAULT_LIMIT, Searcher, SearchParams, VectorIndex, hydrate
from .store import Store

log = logging.getLogger("picsearch.server")

TOKEN_HEADER = "X-PicSearch-Token"


# ---------------------------------------------------------------------------
# Request bodies. Responses are dicts straight from search.hydrate.
# ---------------------------------------------------------------------------

class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SimilarRequest(BaseModel):
    # api.ts posts snake_case here while responses are camelCase; both spellings
    # are accepted rather than "fixing" the frontend.
    model_config = ConfigDict(populate_by_name=True)
    image_id: int


class IdsRequest(Camel):
    ids: list[int]


class IdRequest(Camel):
    id: int


class FolderRequest(Camel):
    path: str | None = None
    recursive: bool = True


class SettingsRequest(Camel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


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
    ):
        self.token = secrets.token_urlsafe(32)
        self.store = Store(db)
        self.settings = config.load()
        self.model_id = model_id or self.settings.get("modelId")
        self.spec = spec_for(self.model_id)
        # Injectable so tests can drive the whole API without loading weights.
        self.embedder = embedder if embedder is not None else Embedder(self.model_id)
        self.vectors = VectorIndex.load(self.store, self.model_id, self.spec.dim)
        self.events = EventBus()
        self.indexer = Indexer(
            self.store,
            self.embedder,
            on_event=self.events.publish,
            on_vector=self._on_vector,
        )
        self.searcher = Searcher(self.store, self.vectors, self.embedder)
        self.started = time.time()

    def _on_vector(self, image_id: int, vector) -> None:
        try:
            self.vectors.add(image_id, vector)
        except ValueError:
            log.warning("vector for image %s does not fit the active index", image_id)

    def switch_model(self, model_id: str) -> None:
        spec = spec_for(model_id)
        self.embedder.switch(model_id)
        self.model_id = model_id
        self.spec = spec
        self.vectors = VectorIndex.load(self.store, model_id, spec.dim)
        self.searcher.vectors = self.vectors


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def _token_of(request: Request) -> str:
    return request.app.state.picsearch.token


async def require_token(request: Request) -> None:
    supplied = request.headers.get(TOKEN_HEADER)
    if(supplied is None or not secrets.compare_digest(supplied, _token_of(request))):
        raise HTTPException(status_code=401, detail="missing or invalid token")


async def require_token_or_query(request: Request, t: str | None = Query(default=None)) -> None:
    """`<img src>` cannot set headers, so bytes routes also take `?t=`."""
    supplied = request.headers.get(TOKEN_HEADER) or t
    if(supplied is None or not secrets.compare_digest(supplied, _token_of(request))):
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
        yield

    app = FastAPI(
        title="picsearch sidecar", version="0.1.0",
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
            "indexing": state.indexer.status.as_wire(),
            "uptimeSec": round(time.time() - state.started, 1),
        }

    # -- search ------------------------------------------------------------

    @app.get("/search", dependencies=[guard])
    def search(
        q: str = "",
        view: str | None = None,
        collection: str | None = None,
        date: str | None = None,
        dims: str | None = None,
        folder: list[str] = Query(default_factory=list),
        type: list[str] = Query(default_factory=list),
        limit: int = DEFAULT_LIMIT,
        cursor: str | None = None,
    ) -> dict:
        params = SearchParams(
            q=q, view=view, collection=collection, date=date, dims=dims,
            folders=list(folder), types=list(type),
            limit=max(1, min(limit, 1000)), cursor=cursor,
        )
        return state.searcher.search(params)

    @app.post("/search/similar", dependencies=[guard])
    def similar(body: SimilarRequest) -> dict:
        return state.searcher.similar(body.image_id)

    @app.get("/images/{image_id}", dependencies=[guard])
    def image_detail(image_id: int) -> dict:
        items = hydrate(state.store, [image_id])
        if(not items):
            raise HTTPException(status_code=404, detail="no such image")
        item = items[0]
        item["ocrText"] = state.store.get_ocr(image_id)
        return item

    @app.delete("/images", dependencies=[guard])
    def delete_images(body: IdsRequest) -> dict:
        """Removes rows and thumbnails. Originals on disk are never touched."""
        removed = state.store.delete_images(body.ids)
        state.vectors.remove(body.ids)
        return {"removed": removed}

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
        state.indexer.start_rescan()
        return {"path": str(path), "count": state.store.folder_count(str(path)),
                "recursive": body.recursive}

    @app.delete("/folders", dependencies=[guard])
    def remove_folder(path: str) -> dict:
        state.store.remove_folder(path)
        return {"ok": True}

    @app.patch("/folders", dependencies=[guard])
    def patch_folder(body: FolderRequest) -> dict:
        if(not body.path):
            raise HTTPException(status_code=400, detail="path is required")
        state.store.set_folder_recursive(body.path, body.recursive)
        return {"ok": True}

    @app.post("/rescan", dependencies=[guard])
    def rescan() -> dict:
        return {"started": state.indexer.start_rescan()}

    # -- settings ----------------------------------------------------------

    @app.get("/settings", dependencies=[guard])
    def get_settings() -> dict:
        return {**state.settings, "modelId": state.model_id}

    @app.put("/settings", dependencies=[guard])
    def put_settings(body: SettingsRequest) -> dict:
        incoming = body.model_dump(by_alias=True, exclude_none=True)
        wanted = incoming.get("modelId")
        if(wanted is not None and wanted != state.model_id):
            # Reject unknown ids before anything is persisted, as a 400 — a
            # bare KeyError here reaches the frontend as an opaque 500.
            try:
                spec_for(wanted)
            except KeyError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        state.settings = config.save(incoming)
        if(wanted is not None and wanted != state.model_id):
            state.switch_model(wanted)
        return {**state.settings, "modelId": state.model_id}

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
# Parent watchdog
# ---------------------------------------------------------------------------

def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def start_parent_watchdog(parent_pid: int | None = None, interval: float = 1.0) -> None:
    """Exit hard when the process we belong to disappears.

    Rust also kills the child on window-destroy and on panic, but the happy
    path alone is not enough: this is what survives `pkill -9` on Tauri, and an
    orphan holding VRAM is the failure this whole design guards against.

    `--parent-pid` exists because Tauri spawns us through `uv`, so our direct
    parent is not the process whose death matters. Watching *liveness of a pid*
    rather than comparing `getppid()` is what makes that case work — an earlier
    version compared ppid and killed the sidecar the instant it started, since
    `uv`'s pid never equals Tauri's.
    """
    target = parent_pid if parent_pid is not None else os.getppid()
    # Reparenting is only meaningful when we are watching our own parent.
    watch_reparent = parent_pid is None

    def watch() -> None:
        while(True):
            time.sleep(interval)
            if(not _pid_alive(target)):
                log.warning("watched process %s is gone; exiting", target)
                os._exit(0)
            if(watch_reparent and os.getppid() != target):
                log.warning("reparented away from %s; exiting", target)
                os._exit(0)

    threading.Thread(target=watch, name="picsearch-parent-watchdog", daemon=True).start()


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="picsearch sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 picks an ephemeral port")
    parser.add_argument("--model", default=None)
    parser.add_argument("--parent-pid", type=int, default=None)
    parser.add_argument("--log-level", default="info")
    parser.add_argument("--scan-on-start", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,  # stdout carries the handshake line and nothing else
    )

    state = AppState(model_id=args.model)
    app = create_app(state)
    start_parent_watchdog(args.parent_pid)

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
    ))
    server.run(sockets=[sock])
    return 0


if(__name__ == "__main__"):
    raise SystemExit(main())
