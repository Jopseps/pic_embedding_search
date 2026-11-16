"""Live folder watching.

`watchdog` observers on every enabled folder, feeding the same ingest path a
manual scan uses. Drop a screenshot into a watched folder and it shows up in
the grid a couple of seconds later without anyone pressing rescan.

Three decisions shape this file:

* **Events are debounced into batches, never ingested one at a time.** Copying
  400 files produces 400 create events and, on most editors and sync clients, a
  create plus several modifies per file while the bytes are still arriving.
  Ingesting on each one would read half-written files and spend the GPU on
  batches of one. Events accumulate into a set; `DEBOUNCE_SEC` of quiet flushes
  them as a single batch. `MAX_WAIT_SEC` is the ceiling for a folder that never
  goes quiet — a screen recorder, a sync client mid-transfer — which would
  otherwise never flush at all.

* **The watcher accepts exactly what `walk_images` would have walked.**
  `index.indexable_under` is that rule, and it is shared rather than
  re-implemented: a file the watcher ingests that a scan would not walk gets
  deleted again by `_prune_missing` on the next rescan, so the image would
  appear and then vanish later for no visible reason.

* **A rename is not a delete plus a create.** The pixels did not change, so the
  embedding, the OCR text and the thumbnails are all still valid and all hang
  off `image_id`. `Indexer.move_path` repoints the row; re-ingesting would
  re-run the GPU for a file that only moved.

The ingest slot is single-occupancy. When a scan or an OCR backfill is already
running, a flush puts its paths back and retries on the next tick rather than
running two GPU batches against one embedder.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Sequence
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import imaging, paths
from .index import Indexer, indexable_under, walk_images
from .store import Store

log = logging.getLogger(__name__)

# Quiet time before a batch flushes. Long enough to swallow an editor's
# write-then-rewrite, short enough that a dropped screenshot feels immediate.
DEBOUNCE_SEC = 2.0
# A folder under continuous writes never goes quiet; flush anyway past this.
MAX_WAIT_SEC = 30.0
TICK_SEC = 0.25


class FolderWatcher:
    """Watches the enabled folders and feeds `Indexer`.

    Event intake (`touch`, `remove`, `moved`) is separate from `flush()` so the
    debounce logic can be tested without a real observer — filesystem event
    delivery timing is the least deterministic thing that could be put in a
    test suite.
    """

    def __init__(
        self,
        store: Store,
        indexer: Indexer,
        debounce: float = DEBOUNCE_SEC,
        max_wait: float = MAX_WAIT_SEC,
    ):
        self.store = store
        self.indexer = indexer
        self.debounce = debounce
        self.max_wait = max_wait

        self._roots: list[tuple[Path, bool]] = []
        self._observer = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._ingest: set[str] = set()
        self._forget: set[str] = set()
        self._moves: list[tuple[str, str]] = []
        self._first: float = 0.0
        self._last: float = 0.0

    # -- lifecycle -----------------------------------------------------------

    @property
    def running(self) -> bool:
        t = self._thread
        return t is not None and t.is_alive()

    def start(self) -> None:
        """Attach observers and start the debounce loop. Idempotent."""
        if(self.running):
            self.sync()
            return
        self._stop.clear()
        self._observer = Observer()
        self.sync()
        self._observer.start()
        self._thread = threading.Thread(
            target=self._loop, name="picsearch-watch", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        observer = self._observer
        if(observer is not None):
            observer.unschedule_all()
            observer.stop()
            observer.join(timeout)
            self._observer = None
        t = self._thread
        if(t is not None):
            t.join(timeout)
            self._thread = None

    def sync(self) -> list[tuple[Path, bool]]:
        """Re-attach observers to the folders currently enabled in the DB.

        Called whenever the folder list changes, so adding a folder in Settings
        starts watching it without a restart.
        """
        roots: list[tuple[Path, bool]] = []
        for row in self.store.list_folders():
            if(not row["enabled"]):
                continue
            root = Path(str(row["path"])).expanduser()
            if(not root.is_dir()):
                log.warning("watched folder is not on disk, skipping: %s", root)
                continue
            roots.append((root, bool(row["recursive"])))

        with self._lock:
            self._roots = roots

        observer = self._observer
        if(observer is not None):
            observer.unschedule_all()
            handler = _Handler(self)
            for root, recursive in roots:
                try:
                    observer.schedule(handler, str(root), recursive=recursive)
                except OSError as exc:
                    # Almost always inotify watch exhaustion on a huge tree.
                    log.warning("cannot watch %s: %s", root, exc)
        return roots

    # -- what counts ---------------------------------------------------------

    def roots(self) -> list[tuple[Path, bool]]:
        with self._lock:
            return list(self._roots)

    def accepts(self, path: Path | str) -> bool:
        """True when a scan of some watched folder would have walked this file."""
        p = Path(path)
        return any(indexable_under(p, root, recursive) for root, recursive in self.roots())

    def accepts_dir(self, path: Path | str) -> bool:
        """True when this directory can hold files a scan would walk."""
        p = Path(path)
        for root, recursive in self.roots():
            try:
                rel = p.relative_to(root)
            except ValueError:
                continue
            if(any(part.startswith(".") for part in rel.parts)):
                continue
            # A non-recursive folder has no interest in anything below itself.
            if(not recursive and rel.parts):
                continue
            return True
        return False

    # -- event intake --------------------------------------------------------

    def _mark(self) -> None:
        now = time.monotonic()
        if(not self._first):
            self._first = now
        self._last = now

    def touch(self, path: Path | str) -> None:
        """A file was created or written."""
        if(not self.accepts(path)):
            return
        with self._lock:
            key = str(path)
            self._ingest.add(key)
            self._forget.discard(key)
            self._mark()

    def remove(self, path: Path | str) -> None:
        """A file went away."""
        if(not imaging.is_supported(Path(path))):
            return
        with self._lock:
            key = str(path)
            self._forget.add(key)
            self._ingest.discard(key)
            self._mark()

    def moved(self, src: Path | str, dest: Path | str) -> None:
        """A file was renamed. Either end may be outside the watched folders."""
        src_in = self.accepts(src)
        dest_in = self.accepts(dest)
        if(not src_in and not dest_in):
            return
        with self._lock:
            if(src_in and dest_in):
                self._moves.append((str(src), str(dest)))
            elif(src_in):
                # Moved out of the library.
                self._forget.add(str(src))
            else:
                self._ingest.add(str(dest))
            self._mark()

    def touch_dir(self, path: Path | str) -> None:
        """A directory appeared or was moved in. Walk it for images.

        Recursive observers report the files inside too, but not for a move:
        `mv ~/downloads/album ~/Pictures/` is a single event for the directory.
        Everything found here is unchanged-checked at ingest, so walking a
        directory that was already reported costs one stat per file.
        """
        if(not self.accepts_dir(path)):
            return
        root = Path(path)
        found = [str(p) for p in walk_images(root, recursive=True) if self.accepts(p)]
        if(not found):
            return
        with self._lock:
            self._ingest.update(found)
            self._mark()

    def remove_dir(self, path: Path | str) -> None:
        """A directory went away. Some backends report only this, not its files."""
        rows = self.store.conn().execute(
            "SELECT path FROM images WHERE path LIKE ? ESCAPE '\\'",
            (paths.like_subtree(Path(path)),),
        ).fetchall()
        if(not rows):
            return
        with self._lock:
            for row in rows:
                self._forget.add(str(row["path"]))
            self._mark()

    def move_dir(self, src: Path | str, dest: Path | str) -> None:
        """A directory was renamed: repoint every row under it, then walk."""
        rows = self.store.conn().execute(
            "SELECT path FROM images WHERE path LIKE ? ESCAPE '\\'",
            (paths.like_subtree(Path(src)),),
        ).fetchall()
        with self._lock:
            for row in rows:
                old = str(row["path"])
                new = str(Path(dest) / Path(old).relative_to(Path(src)))
                self._moves.append((old, new))
            self._mark()
        # Anything that was never indexed under `src` still has to be ingested,
        # which is also the whole answer when the source was outside the library.
        self.touch_dir(dest)

    # -- flushing ------------------------------------------------------------

    def pending(self) -> int:
        with self._lock:
            return len(self._ingest) + len(self._forget) + len(self._moves)

    def due(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            if(not (self._ingest or self._forget or self._moves)):
                return False
            return (now - self._last) >= self.debounce or (now - self._first) >= self.max_wait

    def flush(self) -> tuple[int, int, int]:
        """Apply everything queued. Returns (ingested, forgotten, moved).

        Moves run first: a rename that also produced a create event for the
        destination is then a no-op at ingest, because the row already sits at
        the new path with the same mtime and size.
        """
        with self._lock:
            ingest = sorted(self._ingest)
            forget = sorted(self._forget)
            moves = list(self._moves)
            self._ingest.clear()
            self._forget.clear()
            self._moves.clear()
            self._first = 0.0
            self._last = 0.0

        moved = 0
        for src, dest in moves:
            if(self.indexer.move_path(Path(src), Path(dest))):
                moved += 1
            else:
                # Nothing was indexed at the source, so this is a new file.
                ingest.append(dest)

        forgotten = self.indexer.forget_paths([Path(p) for p in forget])

        report = self.indexer.ingest_paths([Path(p) for p in ingest])
        if(report is None):
            # The ingest slot is taken. Keep the paths and try on the next tick
            # — dropping them would lose the images until a manual rescan.
            self._requeue(ingest)
            return 0, forgotten, moved
        return report.ingested, forgotten, moved

    def _requeue(self, paths_in: Sequence[str]) -> None:
        with self._lock:
            self._ingest.update(paths_in)
            self._mark()
            # Deferred work is already overdue; do not restart the quiet timer.
            self._first = 0.0

    def _loop(self) -> None:
        while(not self._stop.is_set()):
            self._stop.wait(TICK_SEC)
            if(self._stop.is_set()):
                break
            try:
                self.indexer.rescan_if_pending()
            except Exception:  # pragma: no cover - a watcher must not die
                log.exception("pending rescan failed to start")
            if(not self.due()):
                continue
            try:
                ingested, forgotten, moved = self.flush()
            except Exception:  # pragma: no cover - a watcher must not die
                log.exception("watch flush failed")
                continue
            if(ingested or forgotten or moved):
                log.info(
                    "watch: %d ingested, %d removed, %d moved", ingested, forgotten, moved
                )


class _Handler(FileSystemEventHandler):
    """Adapter from watchdog's callbacks to `FolderWatcher`'s intake.

    Does no work of its own — these callbacks run on the observer's thread and
    everything real happens at flush time.
    """

    def __init__(self, watcher: FolderWatcher):
        self.watcher = watcher

    def dispatch(self, event) -> None:
        # watchdog's dispatch thread does not survive an exception: one bad event
        # would stop all watching while `FolderWatcher.running` still says True.
        try:
            super().dispatch(event)
        except Exception:
            log.exception("watch event failed: %s", event)

    def on_created(self, event) -> None:
        if(event.is_directory):
            self.watcher.touch_dir(event.src_path)
        else:
            self.watcher.touch(event.src_path)

    def on_modified(self, event) -> None:
        if(not event.is_directory):
            self.watcher.touch(event.src_path)

    def on_deleted(self, event) -> None:
        if(event.is_directory):
            self.watcher.remove_dir(event.src_path)
        else:
            self.watcher.remove(event.src_path)

    def on_moved(self, event) -> None:
        if(event.is_directory):
            self.watcher.move_dir(event.src_path, event.dest_path)
        else:
            self.watcher.moved(event.src_path, event.dest_path)
