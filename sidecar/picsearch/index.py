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

from . import imaging, paths
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
                yield p


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

    def start_rescan(self, folders: Sequence[tuple[Path, bool]] | None = None) -> bool:
        """Kick off a scan in the background. False if one is already running."""
        with self._lock:
            if(self.running):
                return False
            self._stop.clear()
            targets = folders if folders is not None else self._enabled_folders()
            self._thread = threading.Thread(
                target=self._run_scan, args=(targets,), name="picsearch-ingest", daemon=True
            )
            self._thread.start()
            return True

    def stop(self) -> None:
        self._stop.set()

    def pause(self, paused: bool) -> None:
        self.status.paused = paused
        if(paused):
            self._pause.set()
        else:
            self._pause.clear()
        self._emit("index", self.status.as_wire())

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

        self.status = IndexStatus(total=len(candidates), running=True)
        self._emit("index", self.status.as_wire())
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
                while(self._pause.is_set() and not self._stop.is_set()):
                    time.sleep(0.15)

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
                remaining = max(0, len(candidates) - i)
                self.status.eta_sec = (
                    (remaining / self.status.rate) if self.status.rate > 0 else 0.0
                )
                if(i % 10 == 0 or i == len(candidates)):
                    self._emit("index", self.status.as_wire())

            report.embedded += self._flush(batch_ids, batch_imgs)
            report.ocred += self._ocr_drain(pending, report.errors)

        if(prune and not self._stop.is_set()):
            report.removed = self._prune_missing(targets, seen)

        # Screenshots indexed before OCR existed — or before the engine or its
        # languages changed — are read here. A rescan is already an explicit
        # user action, and unchanged files cost nothing above.
        if(not self._stop.is_set()):
            report.ocred += self.ocr_missing()

        self.status.running = False
        self.status.current_file = ""
        self._emit("index", self.status.as_wire())
        self._emit("scan-complete", {
            "scanned": report.scanned,
            "ingested": report.ingested,
            "skipped": report.skipped,
            "embedded": report.embedded,
            "ocred": report.ocred,
            "removed": report.removed,
            "errors": len(report.errors),
        })
        return report

    def _ingest_one(self, path: Path) -> Ingested | None:
        """Returns the work left for the batches, or None when the file is unchanged."""
        st = path.stat()
        if(self.store.is_unchanged(str(path), st.st_mtime, st.st_size)):
            # The fast path. No decode, no hashing, and above all no GPU.
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

        image_id = self.store.upsert_image(
            path=str(path),
            mtime=st.st_mtime,
            size_bytes=st.st_size,
            width=width,
            height=height,
            mime=imaging.mime_for(path),
            phash=ph,
            sha256=sha,
            taken_at=imaging.taken_at(path),
            is_screenshot=is_screenshot,
        )
        return Ingested(image_id, small, ocr_image)

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
                while(self._pause.is_set() and not self._stop.is_set()):
                    time.sleep(0.15)
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
            if(self.running):
                return False
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run_ocr_backfill, name="picsearch-ocr-backfill", daemon=True
            )
            self._thread.start()
            return True

    def _run_ocr_backfill(self) -> None:
        self.status.running = True
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

    def _flush(self, ids: list[int], images: list[Image.Image]) -> int:
        if(not ids):
            return 0
        vectors = self.embedder.embed_pil(images)
        self.store.put_embeddings(self.embedder.model_id, zip(ids, vectors, strict=True))
        if(self.on_vector is not None):
            for image_id, vec in zip(ids, vectors, strict=True):
                self.on_vector(image_id, vec)
        for img in images:
            img.close()
        return len(ids)

    def _prune_missing(self, targets: Sequence[tuple[Path, bool]], seen: set[str]) -> int:
        """Drop rows for files that vanished from a scanned root."""
        roots = [str(Path(root).resolve()) for root, _rec in targets]
        if(not roots):
            return 0
        gone: list[int] = []
        for row in self.store.conn().execute("SELECT id, path FROM images"):
            p = row["path"]
            if(p in seen):
                continue
            if(not any(p == r or p.startswith(r.rstrip("/") + "/") for r in roots)):
                continue
            if(not Path(p).exists()):
                gone.append(int(row["id"]))
        if(gone):
            self.store.delete_images(gone)
        return len(gone)

    # -- backfill for model swaps ------------------------------------------

    def embed_missing(self, model_id: str | None = None, limit: int | None = None) -> int:
        """Embed every image lacking a row for `model_id`. Drives the model swap."""
        model = model_id or self.embedder.model_id
        ids = self.store.images_missing_embedding(model, limit=limit)
        done = 0
        for start in range(0, len(ids), BATCH_SIZE):
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
            done += self._flush(batch_ids, batch_imgs)
            self._emit("reindex", {
                "active": True,
                "progress": round(100.0 * done / max(1, len(ids)), 1),
                "modelName": model,
            })
        self._emit("reindex", {"active": False, "progress": 100.0, "modelName": model})
        return done
