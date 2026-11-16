"""Folder scan and ingest.

The rule that shapes this file: **a rescan must skip unchanged files without
touching the GPU.** Users rescan constantly, and re-embedding a 5000-image
library because someone clicked a button is the difference between a tool and a
toy. The skip key is `(path, mtime, size_bytes)`.

Per new or changed file: decode, EXIF, sha256 + pHash, width/height, screenshot
heuristic, 256/512 px WebP thumbnails, then embed in batches on the GPU.

Ingest runs on one bounded background thread so the HTTP API stays responsive.

**OCR runs on a side thread pool, not in the scan loop.** It is CPU-bound and
costs 0.5-2 s per screenshot, which would turn a 30 s scan into minutes if it
were serial. The engines shell out (tesseract) or drop into ONNX/torch, all of
which release the GIL, so OCR overlaps GPU embedding almost for free. The pool
is bounded and drained back into the scan loop so that at most `OCR_INFLIGHT`
full-resolution grayscale copies are alive at once.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from . import dates, imaging, paths
from .embed import BATCH_SIZE, Embedder
from .ocr import OcrEngine, OcrError
from .store import Store

log = logging.getLogger(__name__)

# Full-size decodes are held only long enough to thumbnail; what goes into the
# embed batch is downscaled first so a batch of 32 stays around 50 MB, not 1 GB.
EMBED_MAX_EDGE = 768

# Leave a core for the scan loop itself. Tesseract runs with OMP_THREAD_LIMIT=1
# (see ocr.py) precisely so this number means what it says.
OCR_WORKERS = max(1, min(4, (os.cpu_count() or 2) - 1))
OCR_INFLIGHT = OCR_WORKERS * 2

EventSink = Callable[[str, dict], None]
# (image_id, engine id, effective langs, the running read). The engine identity
# rides along because it may be swapped out before the future is drained.
PendingOcr = tuple[int, str, str, "Future[str]"]


@dataclass
class Ingested:
    """What one new file leaves behind for the batched work that follows."""

    image_id: int
    small: Image.Image
    # Full-resolution grayscale, present only for screenshots when OCR is on.
    # OCR must never read `small`: 768 px makes body text unreadable.
    ocr_image: Image.Image | None = None


@dataclass
class IndexStatus:
    current: int = 0
    total: int = 0
    rate: float = 0.0
    eta_sec: float = 0.0
    paused: bool = False
    current_file: str = ""
    running: bool = False
    errors: list[str] = field(default_factory=list)

    def as_wire(self) -> dict:
        return {
            "current": self.current,
            "total": self.total,
            "rate": round(self.rate, 2),
            "etaSec": round(self.eta_sec, 1),
            "paused": self.paused,
            "currentFile": self.current_file,
            "running": self.running,
        }


@dataclass
class ScanReport:
    scanned: int = 0
    ingested: int = 0
    skipped: int = 0
    embedded: int = 0
    ocred: int = 0
    removed: int = 0
    errors: list[str] = field(default_factory=list)


def storable(path: Path | str) -> bool:
    """False for a name that is not valid UTF-8 (Python reads its bytes as lone
    surrogates). SQLite cannot bind such a string, so a row for it can never be
    written — the file is skipped up front rather than decoded and thumbnailed
    first, on every rescan."""
    try:
        str(path).encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def walk_images(root: Path, recursive: bool = True) -> Iterator[Path]:
    """Yield supported image files, skipping dotdirs and the thumbnail cache."""
    root = Path(root)
    if(not root.is_dir()):
        return
    thumbs = paths.thumbs_dir().resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if(here.resolve() == thumbs):
            dirnames[:] = []
            continue
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        if(not recursive):
            dirnames[:] = []
        for name in sorted(filenames):
            if(name.startswith(".")):
                continue
            p = here / name
            if(imaging.is_supported(p)):
                if(not storable(p)):
                    log.warning("skipping %r: the file name is not valid UTF-8", str(p))
                    continue
                yield p


def indexable_under(path: Path, root: Path, recursive: bool = True) -> bool:
    """True when `walk_images(root, recursive)` would have yielded `path`.

    The watcher must apply exactly this rule and nothing looser. A file it
    ingests that a scan would not walk — inside a dotdir, or below a folder
    watched non-recursively — is deleted again by `_prune_missing` on the next
    rescan. The image appears instantly and then vanishes an hour later, which
    is a far worse bug than never appearing.
    """
    path = Path(path)
    try:
        rel = path.relative_to(Path(root))
    except ValueError:
        return False
    parts = rel.parts
    if(not parts):
        return False
    if(not recursive and len(parts) > 1):
        return False
    if(any(part.startswith(".") for part in parts)):
        return False
    # Writing a thumbnail is itself a filesystem event. Watching a folder that
    # contains the cache would otherwise ingest its own output forever.
    if(paths.thumbs_dir().resolve() in path.resolve().parents):
        return False
    return imaging.is_supported(path) and storable(path)


class Indexer:
    """Owns ingest. One instance per process, shared by the API and the watcher."""

    def __init__(
        self,
        store: Store,
        embedder: Embedder,
        ocr: OcrEngine | None = None,
        on_event: EventSink | None = None,
        on_vector: Callable[[int, "object"], None] | None = None,
    ):
        self.store = store
        self.embedder = embedder
        self.ocr = ocr
        self.on_event = on_event
        self.on_vector = on_vector
        self.status = IndexStatus()
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._rescan_pending = False

    # -- events -------------------------------------------------------------

    def _emit(self, kind: str, payload: dict) -> None:
        if(self.on_event is not None):
            try:
                self.on_event(kind, payload)
            except Exception:
                log.exception("event sink raised")

    # -- background driver --------------------------------------------------

    @property
    def running(self) -> bool:
        t = self._thread
        return t is not None and t.is_alive()

    def _claim(self) -> bool:
        """Take the ingest slot, or report that something else already has it.

        `self.running` covers the background thread; `status.running` covers a
        synchronous ingest on somebody else's thread, which is what the watcher
        does. Both are needed — two ingests at once would interleave progress
        events and run two GPU batches against one embedder.
        """
        with self._lock:
            if(self.running or self.status.running):
                return False
            self.status.running = True
            return True

    def start_rescan(self, folders: Sequence[tuple[Path, bool]] | None = None) -> bool:
        """Kick off a scan in the background. False if one is already running."""
        with self._lock:
            if(self.running or self.status.running):
                # Remembered, not dropped: a folder added while the watcher was
                # mid-batch was otherwise never scanned. `rescan_if_pending` runs it.
                self._rescan_pending = True
                return False
            self._rescan_pending = False
            self._stop.clear()
            targets = folders if folders is not None else self._enabled_folders()
            self._thread = threading.Thread(
                target=self._run_scan, args=(targets,), name="picsearch-ingest", daemon=True
            )
            self._thread.start()
            return True

    def rescan_if_pending(self) -> bool:
        """Start the scan that `start_rescan` had to turn away, once the slot is free."""
        return self._rescan_pending and self.start_rescan()

    def stop(self) -> None:
        self._stop.set()

    def pause(self, paused: bool) -> None:
        self.status.paused = paused
        if(paused):
            self._pause.set()
        else:
            self._pause.clear()
        self._emit("index", self.status.as_wire())

    def _wait_while_paused(self) -> None:
        # Polled rather than waited on: `stop()` has to be able to cut it short.
        while(self._pause.is_set() and not self._stop.is_set()):
            time.sleep(0.15)

    def join(self, timeout: float | None = None) -> None:
        t = self._thread
        if(t is not None):
            t.join(timeout)

    def _run_scan(self, targets: Sequence[tuple[Path, bool]]) -> None:
        try:
            self.scan(targets)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("scan failed")
            self._emit("error", {"message": str(exc)})

    def _enabled_folders(self) -> list[tuple[Path, bool]]:
        return [
            (Path(r["path"]), bool(r["recursive"]))
            for r in self.store.list_folders()
            if r["enabled"]
        ]

    # -- the scan itself ----------------------------------------------------

    def scan(
        self, targets: Sequence[tuple[Path, bool]] | None = None, prune: bool = True
    ) -> ScanReport:
        """Synchronous full walk. Safe to call directly; tests do."""
        targets = list(targets) if targets is not None else self._enabled_folders()
        report = ScanReport()

        candidates: list[Path] = []
        seen: set[str] = set()
        for root, recursive in targets:
            for p in walk_images(Path(root), recursive):
                key = str(p)
                if(key in seen):
                    continue
                seen.add(key)
                candidates.append(p)

        self.status = IndexStatus(
            total=len(candidates), running=True, paused=self._pause.is_set()
        )
        self._emit("index", self.status.as_wire())
        # `running` must come down however this ends: an exception out of the GPU
        # batch left it set, and every later scan, watcher flush and swap
        # then reported "busy" until the sidecar was restarted.
        try:
            self._ingest_many(candidates, report)

            if(prune and not self._stop.is_set()):
                report.removed = self._prune_missing(targets, seen)

            # A row is written before its batch is embedded, so a crash between
            # the two leaves a row the fast path skips forever. This is the only
            # place that notices. It is one query when nothing is missing.
            if(not self._stop.is_set()):
                report.embedded += self.embed_missing(emit=False)

            # Screenshots indexed before OCR existed — or before the engine or its
            # languages changed — are read here. A rescan is already an explicit
            # user action, and unchanged files cost nothing above.
            if(not self._stop.is_set()):
                report.ocred += self.ocr_missing()
        finally:
            self.status.running = False
            self.status.current_file = ""
        self._emit("index", self.status.as_wire())
        self._emit("scan-complete", self._complete_payload(report))
        return report

    def _ingest_many(self, candidates: Sequence[Path], report: ScanReport) -> None:
        """The ingest loop itself, shared by the folder scan and the watcher.

        Progress, GPU batching and the bounded OCR pool all live here, so a
        watcher batch behaves exactly like a very small scan: same events, same
        batch size, same ceiling on full-resolution decodes in flight.

        The caller owns `self.status` — it sets the total and clears `running`
        — because a scan counts a walk this does not know about.
        """
        total = len(candidates)
        started = time.monotonic()

        batch_ids: list[int] = []
        batch_imgs: list[Image.Image] = []
        pending: deque[PendingOcr] = deque()

        with ThreadPoolExecutor(
            max_workers=OCR_WORKERS, thread_name_prefix="picsearch-ocr"
        ) as pool:
            for i, path in enumerate(candidates, start=1):
                if(self._stop.is_set()):
                    break
                self._wait_while_paused()

                report.scanned += 1
                self.status.current = i
                self.status.current_file = path.name

                try:
                    outcome = self._ingest_one(path)
                except Exception as exc:
                    msg = f"{path}: {exc}"
                    log.warning("ingest failed %s", msg)
                    report.errors.append(msg)
                    continue

                if(outcome is None):
                    report.skipped += 1
                else:
                    report.ingested += 1
                    batch_ids.append(outcome.image_id)
                    batch_imgs.append(outcome.small)
                    if(outcome.ocr_image is not None):
                        self._ocr_submit(pool, pending, outcome.image_id, outcome.ocr_image)
                        if(len(pending) >= OCR_INFLIGHT):
                            report.ocred += self._ocr_drain(
                                pending, report.errors, keep=OCR_WORKERS
                            )
                    if(len(batch_imgs) >= BATCH_SIZE):
                        report.embedded += self._flush(batch_ids, batch_imgs)
                        batch_ids, batch_imgs = [], []

                elapsed = time.monotonic() - started
                self.status.rate = (i / elapsed) if elapsed > 0 else 0.0
                remaining = max(0, total - i)
                self.status.eta_sec = (
                    (remaining / self.status.rate) if self.status.rate > 0 else 0.0
                )
                if(i % 10 == 0 or i == total):
                    self._emit("index", self.status.as_wire())

            report.embedded += self._flush(batch_ids, batch_imgs)
            report.ocred += self._ocr_drain(pending, report.errors)

    def _complete_payload(self, report: ScanReport) -> dict:
        return {
            "scanned": report.scanned,
            "ingested": report.ingested,
            "skipped": report.skipped,
            "embedded": report.embedded,
            "ocred": report.ocred,
            "removed": report.removed,
            "errors": len(report.errors),
        }

    def _ingest_one(self, path: Path) -> Ingested | None:
        """Returns the work left for the batches, or None when the file is unchanged."""
        st = path.stat()
        if(self.store.is_unchanged(str(path), st.st_mtime, st.st_size)):
            # The fast path. No hashing and above all no GPU. Only a purged
            # thumbnail cache costs a decode, and then no pixel is re-embedded.
            self._restore_thumbnails(path)
            return None

        with imaging.open_image(path) as img:
            width, height = img.size
            sha = imaging.sha256_file(path)
            ph = imaging.phash(img)
            is_screenshot = imaging.is_screenshot(path, width, height)

            for size in imaging.THUMB_SIZES:
                imaging.write_thumbnail(img, paths.thumb_path(sha, size), size)

            small = img.copy()
            small.thumbnail((EMBED_MAX_EDGE, EMBED_MAX_EDGE), Image.Resampling.LANCZOS)
            # Full resolution, taken before the file handle closes.
            ocr_image = (
                img.convert("L") if (is_screenshot and self.ocr is not None) else None
            )

        taken_at, date_source = dates.resolve(path, st.st_mtime)
        image_id = self.store.upsert_image(
            path=str(path),
            mtime=st.st_mtime,
            size_bytes=st.st_size,
            width=width,
            height=height,
            mime=imaging.mime_for(path),
            phash=ph,
            sha256=sha,
            taken_at=taken_at,
            date_source=date_source,
            is_screenshot=is_screenshot,
        )
        return Ingested(image_id, small, ocr_image)

    def _restore_thumbnails(self, path: Path) -> None:
        """Rewrite thumbnails that are gone from disk. Thumbnails exist only from
        ingest, so after "clear thumbnail cache" nothing else would ever bring
        the grid back."""
        row = self.store.image_by_path(str(path))
        if(row is None):
            return
        wanted = {n: paths.thumb_path(row["sha256"], n) for n in imaging.THUMB_SIZES}
        if(all(p.exists() for p in wanted.values())):
            return
        with imaging.open_image(path) as img:
            for size, dest in wanted.items():
                imaging.write_thumbnail(img, dest, size)

    # -- watcher entry points ------------------------------------------------

    def ingest_paths(self, paths_in: Sequence[Path]) -> ScanReport | None:
        """Ingest an explicit set of files, skipping the folder walk.

        `None` means the ingest slot was busy and the caller should hold the
        paths and try again — the watcher does exactly that. Returning an empty
        report instead would silently drop the files.

        Unchanged files still cost nothing: `_ingest_one` runs the same
        `(path, mtime, size)` check, so a burst of `modify` events on a file
        nobody touched skips the GPU just as a rescan does.
        """
        seen: dict[str, Path] = {}
        for p in paths_in:
            path = Path(p)
            if(path.is_file()):
                seen.setdefault(str(path), path)
        candidates = list(seen.values())
        if(not candidates):
            return ScanReport()
        if(not self._claim()):
            return None

        report = ScanReport()
        try:
            self.status = IndexStatus(
                total=len(candidates), running=True, paused=self._pause.is_set()
            )
            self._emit("index", self.status.as_wire())
            self._ingest_many(candidates, report)
        finally:
            self.status.running = False
            self.status.current_file = ""
        self._emit("index", self.status.as_wire())
        self._emit("scan-complete", self._complete_payload(report))
        return report

    def forget_paths(self, paths_in: Sequence[Path]) -> int:
        """Drop rows for files that are gone. Thumbnails stay on disk.

        Thumbnails are content-addressed by sha256, so a duplicate elsewhere in
        the library may still need them and a file that comes back costs no
        re-encode. The cache is a cache — Settings reports its size and can
        purge it.
        """
        gone: list[int] = []
        for p in paths_in:
            path = Path(p)
            if(not storable(path)):
                continue   # never indexed, and SQLite cannot bind the name
            # Deleted and recreated between the event and now — a save-by-
            # replace does this, and dropping the row would lose the image.
            if(path.exists()):
                continue
            row = self.store.image_by_path(str(path))
            if(row is not None):
                gone.append(int(row["id"]))
        if(gone):
            self.store.delete_images(gone)
        return len(gone)

    def drop_folder_images(self, root: str) -> int:
        """Drop the rows under a folder that is no longer watched. Files and
        thumbnails stay; `delete_images` takes the vectors, OCR text and
        collection membership with the rows.

        Call after the folder row is gone: a photo that a remaining watched
        folder still covers (nested roots, respecting its recursive flag) stays,
        by the same `indexable_under` rule the scan and the watcher use.
        """
        remaining = self._enabled_folders()
        gone: list[int] = []
        rows = self.store.conn().execute(
            "SELECT id, path FROM images WHERE path LIKE ? ESCAPE '\\'",
            (paths.like_subtree(root),),
        ).fetchall()
        for row in rows:
            p = Path(row["path"])
            if(not any(indexable_under(p, r, rec) for r, rec in remaining)):
                gone.append(int(row["id"]))
        return self.store.delete_images(gone)

    def move_path(self, src: Path, dest: Path) -> bool:
        """Follow a rename in place. False when there was no row at `src`.

        Nothing is verified about the destination on purpose: if the file was
        modified as well as moved, its stored `(mtime, size)` no longer match
        and the next scan re-ingests it. The cheap path stays cheap and the
        expensive path stays correct.
        """
        return self.store.move_image(str(src), str(dest)) is not None

    # -- OCR ----------------------------------------------------------------

    def set_ocr(self, engine: OcrEngine | None) -> None:
        """Swap the engine live. The next scan re-reads whatever it changed."""
        self.ocr = engine

    def _ocr_submit(
        self,
        pool: ThreadPoolExecutor,
        pending: deque[PendingOcr],
        image_id: int,
        image: Image.Image,
    ) -> None:
        engine = self.ocr
        if(engine is None):
            image.close()
            return

        def task() -> str:
            try:
                return engine.read(image)
            finally:
                image.close()

        # The engine's identity travels with the future. `set_ocr()` can land
        # between submit and drain — PUT /settings does exactly that — and
        # stamping this text with the *new* engine's id would make a stale row
        # look current to images_missing_ocr, which would then never re-read it.
        pending.append((image_id, engine.id, engine.langs_key, pool.submit(task)))

    def _ocr_drain(
        self,
        pending: deque[PendingOcr],
        errors: list[str] | None = None,
        keep: int = 0,
    ) -> int:
        """Write finished OCR results, blocking until only `keep` are in flight.

        A failure writes no row at all, so the next scan retries it. Success
        writes a row even when the text is empty — that empty row is the marker
        for "OCR ran and found nothing", and without it every rescan would read
        every text-free screenshot again forever.
        """
        done = 0
        while(len(pending) > keep):
            image_id, engine_id, langs_key, future = pending.popleft()
            try:
                text = future.result()
            except OcrError as exc:
                msg = f"OCR failed for image {image_id}: {exc}"
                log.warning("%s", msg)
                if(errors is not None):
                    errors.append(msg)
                continue
            except Exception as exc:
                msg = f"OCR crashed for image {image_id}: {exc}"
                log.exception("%s", msg)
                if(errors is not None):
                    errors.append(msg)
                continue
            self.store.put_ocr(image_id, engine_id, langs_key, text)
            done += 1
        return done

    def ocr_missing(self, limit: int | None = None) -> int:
        """OCR every screenshot lacking text from the *current* engine and langs."""
        engine = self.ocr
        if(engine is None):
            return 0
        ids = self.store.images_missing_ocr(engine.id, engine.langs_key, limit=limit)
        if(not ids):
            return 0

        log.info("OCR backfill: %d screenshots with %s (%s)", len(ids), engine.id,
                 engine.langs_key)
        self.status.total = len(ids)
        self.status.current = 0
        self.status.rate = 0.0
        self.status.eta_sec = 0.0
        self._emit("index", self.status.as_wire())

        started = time.monotonic()
        done = 0
        errors: list[str] = []
        pending: deque[PendingOcr] = deque()
        with ThreadPoolExecutor(
            max_workers=OCR_WORKERS, thread_name_prefix="picsearch-ocr"
        ) as pool:
            for n, image_id in enumerate(ids, start=1):
                if(self._stop.is_set()):
                    break
                self._wait_while_paused()
                row = self.store.image_by_id(image_id)
                if(row is None):
                    continue
                try:
                    with imaging.open_image(row["path"]) as img:
                        prepared = img.convert("L")
                except Exception as exc:
                    log.warning("OCR decode failed %s: %s", row["path"], exc)
                    continue

                self.status.current = n
                self.status.current_file = Path(row["path"]).name
                # Counts submissions, so it runs up to OCR_INFLIGHT ahead of
                # what is actually written. Over 200 screenshots that is noise,
                # and a progress bar that never moves is worse.
                elapsed = time.monotonic() - started
                self.status.rate = (n / elapsed) if elapsed > 0 else 0.0
                self.status.eta_sec = (
                    ((len(ids) - n) / self.status.rate) if self.status.rate > 0 else 0.0
                )
                self._ocr_submit(pool, pending, image_id, prepared)
                if(len(pending) >= OCR_INFLIGHT):
                    done += self._ocr_drain(pending, errors, keep=OCR_WORKERS)
                if(n % 10 == 0 or n == len(ids)):
                    self._emit("index", self.status.as_wire())
            done += self._ocr_drain(pending, errors)
        return done

    def start_ocr_backfill(self) -> bool:
        """Background `ocr_missing()`. False if ingest is already busy."""
        with self._lock:
            # `status.running` too: a watcher batch holds the slot on its own thread.
            if(self.running or self.status.running):
                return False
            self.status.running = True
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run_ocr_backfill, name="picsearch-ocr-backfill", daemon=True
            )
            self._thread.start()
            return True

    def _run_ocr_backfill(self) -> None:
        done = 0
        try:
            done = self.ocr_missing()
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("OCR backfill failed")
            self._emit("error", {"message": str(exc)})
        finally:
            self.status.running = False
            self.status.current_file = ""
            self._emit("index", self.status.as_wire())
            self._emit("scan-complete", {
                "scanned": 0, "ingested": 0, "skipped": 0, "embedded": 0,
                "ocred": done, "removed": 0, "errors": 0,
            })

    def _flush(
        self, ids: list[int], images: list[Image.Image], embedder=None, notify: bool = True
    ) -> int:
        """`embedder` overrides the resident one; `notify` gates `on_vector`.

        Both exist for the model swap. That backfill embeds with the *incoming*
        model while the live `VectorIndex` still belongs to the outgoing one —
        feeding it vectors from a different model would either raise on the dim
        check or, if the dims happened to match, quietly poison every search
        until promotion. The new vectors are picked up wholesale by
        `VectorIndex.load` when the swap completes.
        """
        if(not ids):
            return 0
        engine = embedder if embedder is not None else self.embedder
        vectors = engine.embed_pil(images)
        self.store.put_embeddings(engine.model_id, zip(ids, vectors, strict=True))
        if(notify and self.on_vector is not None):
            for image_id, vec in zip(ids, vectors, strict=True):
                self.on_vector(image_id, vec)
        for img in images:
            img.close()
        return len(ids)

    def _prune_missing(self, targets: Sequence[tuple[Path, bool]], seen: set[str]) -> int:
        """Drop rows for files that vanished from a scanned root."""
        # Unresolved, because stored paths come from the unresolved walk — a
        # symlinked root otherwise never matches. A root that is not there (an
        # unmounted drive) walked nothing, so "not seen" would read as "deleted"
        # and drop every row, its collections and its vectors with it.
        roots = [str(Path(root)) for root, _rec in targets if Path(root).is_dir()]
        if(not roots):
            return 0
        # A mounted-but-empty root is what an unplugged drive's mount point
        # looks like. Pruning it would drop every row under it, so it keeps them.
        # Accepted cost: a folder the user really emptied keeps its rows until
        # they remove the folder in Settings.
        guarded: list[str] = []
        for r in roots:
            prefix = paths.subtree_prefix(r)
            if(any(p.startswith(prefix) for p in seen)):
                continue
            held = self.store.conn().execute(
                "SELECT 1 FROM images WHERE path LIKE ? ESCAPE '\\' LIMIT 1",
                (paths.like_subtree(r),),
            ).fetchone()
            if(held is not None):
                guarded.append(prefix)
                msg = (
                    f"{r} looks empty; its photos were kept. "
                    "Remove the folder in Settings if this is intended."
                )
                log.warning("%s", msg)
                self._emit("error", {"message": msg})
        gone: list[int] = []
        for row in self.store.conn().execute("SELECT id, path FROM images"):
            p = row["path"]
            if(p in seen):
                continue
            if(any(p.startswith(g) for g in guarded)):
                continue
            if(not any(p == r or p.startswith(paths.subtree_prefix(r)) for r in roots)):
                continue
            if(not Path(p).exists()):
                gone.append(int(row["id"]))
        if(gone):
            self.store.delete_images(gone)
        return len(gone)

    # -- backfill for model swaps ------------------------------------------

    def embed_missing(
        self,
        model_id: str | None = None,
        limit: int | None = None,
        embedder=None,
        emit: bool = True,
    ) -> int:
        """Embed every image lacking a row for `model_id`. Drives the model swap.

        `embedder` is the model doing the work, which during a swap is *not*
        the resident one — see `_flush`. One pass only; `run_model_backfill`
        is what loops until coverage is actually complete.
        """
        engine = embedder if embedder is not None else self.embedder
        model = model_id or engine.model_id
        ids = self.store.images_missing_embedding(model, limit=limit)
        total = len(ids)
        done = 0
        started = time.monotonic()
        for start in range(0, total, BATCH_SIZE):
            if(self._stop.is_set()):
                break
            self._wait_while_paused()
            chunk = ids[start:start + BATCH_SIZE]
            batch_ids: list[int] = []
            batch_imgs: list[Image.Image] = []
            for image_id in chunk:
                row = self.store.image_by_id(image_id)
                if(row is None):
                    continue
                try:
                    with imaging.open_image(row["path"]) as img:
                        small = img.copy()
                        small.thumbnail((EMBED_MAX_EDGE, EMBED_MAX_EDGE), Image.Resampling.LANCZOS)
                except Exception as exc:
                    log.warning("backfill decode failed %s: %s", row["path"], exc)
                    continue
                batch_ids.append(image_id)
                batch_imgs.append(small)
            # The live vector index belongs to the outgoing model during a swap.
            done += self._flush(batch_ids, batch_imgs, embedder=engine, notify=embedder is None)
            if(emit):
                self._emit("reindex", self._reindex_payload(model, done, total, started))
        return done

    def _reindex_payload(self, model: str, done: int, total: int, started: float) -> dict:
        """Real numbers, not an estimate from a constant: the rate is measured
        from the batches that have actually landed."""
        elapsed = max(1e-6, time.monotonic() - started)
        rate = done / elapsed
        remaining = max(0, total - done)
        return {
            "active": True,
            "progress": round(100.0 * done / max(1, total), 1),
            "modelName": model,
            "current": done,
            "total": total,
            "rate": round(rate, 2),
            "etaSec": int(remaining / rate) if rate > 0 else 0,
        }

    def run_model_backfill(self, model_id: str, embedder, on_done=None) -> int:
        """Embed the whole library with `model_id`, then hand back.

        **It loops.** The watcher keeps ingesting while this runs, and a file
        that lands mid-swap is embedded with the *outgoing* model only — so a
        single pass finishes with coverage at 99.9% and the promotion never
        fires. Each pass re-asks the store what is still missing; the loop ends
        when the answer is nothing.
        """
        total_done = 0
        try:
            while(not self._stop.is_set()):
                done = self.embed_missing(model_id, embedder=embedder)
                total_done += done
                if(not self.store.images_missing_embedding(model_id, limit=1)):
                    break
                if(done == 0):
                    # Nothing embeddable but rows still missing — every one of
                    # them failed to decode. Looping would spin forever.
                    log.warning(
                        "model backfill stalled: %d images cannot be embedded with %s",
                        len(self.store.images_missing_embedding(model_id)), model_id,
                    )
                    break
        finally:
            self._emit("reindex", {
                "active": False, "progress": 100.0, "modelName": model_id,
                "current": total_done, "total": total_done, "rate": 0.0, "etaSec": 0,
            })
            if(on_done is not None):
                on_done()
        return total_done

    def start_model_backfill(self, model_id: str, embedder, on_done=None) -> bool:
        """Background `run_model_backfill`. False if the ingest slot is busy."""
        with self._lock:
            if(self.running or self.status.running):
                return False
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run_model_backfill,
                args=(model_id, embedder, on_done),
                name="picsearch-model-backfill",
                daemon=True,
            )
            self._thread.start()
            return True

    def _run_model_backfill(self, model_id: str, embedder, on_done) -> None:
        self.status.running = True
        try:
            self.run_model_backfill(model_id, embedder, on_done)
        except Exception:
            log.exception("model backfill failed")
        finally:
            self.status.running = False
