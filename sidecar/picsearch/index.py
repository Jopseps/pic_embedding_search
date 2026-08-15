"""Folder scan and ingest.

The rule that shapes this file: **a rescan must skip unchanged files without
touching the GPU.** Users rescan constantly, and re-embedding a 5000-image
library because someone clicked a button is the difference between a tool and a
toy. The skip key is `(path, mtime, size_bytes)`.

Per new or changed file: decode, EXIF, sha256 + pHash, width/height, screenshot
heuristic, 256/512 px WebP thumbnails, then embed in batches on the GPU.

Ingest runs on one bounded background thread so the HTTP API stays responsive.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from . import imaging, paths
from .embed import BATCH_SIZE, Embedder
from .store import Store

log = logging.getLogger(__name__)

# Full-size decodes are held only long enough to thumbnail; what goes into the
# embed batch is downscaled first so a batch of 32 stays around 50 MB, not 1 GB.
EMBED_MAX_EDGE = 768

EventSink = Callable[[str, dict], None]


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
        on_event: EventSink | None = None,
        on_vector: Callable[[int, "object"], None] | None = None,
    ):
        self.store = store
        self.embedder = embedder
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
                image_id, small = outcome
                report.ingested += 1
                batch_ids.append(image_id)
                batch_imgs.append(small)
                if(len(batch_imgs) >= BATCH_SIZE):
                    report.embedded += self._flush(batch_ids, batch_imgs)
                    batch_ids, batch_imgs = [], []

            elapsed = time.monotonic() - started
            self.status.rate = (i / elapsed) if elapsed > 0 else 0.0
            remaining = max(0, len(candidates) - i)
            self.status.eta_sec = (remaining / self.status.rate) if self.status.rate > 0 else 0.0
            if(i % 10 == 0 or i == len(candidates)):
                self._emit("index", self.status.as_wire())

        report.embedded += self._flush(batch_ids, batch_imgs)

        if(prune and not self._stop.is_set()):
            report.removed = self._prune_missing(targets, seen)

        self.status.running = False
        self.status.current_file = ""
        self._emit("index", self.status.as_wire())
        self._emit("scan-complete", {
            "scanned": report.scanned,
            "ingested": report.ingested,
            "skipped": report.skipped,
            "embedded": report.embedded,
            "removed": report.removed,
            "errors": len(report.errors),
        })
        return report

    def _ingest_one(self, path: Path) -> tuple[int, Image.Image] | None:
        """Returns (image_id, downscaled image) for new work, None when skipped."""
        st = path.stat()
        if(self.store.is_unchanged(str(path), st.st_mtime, st.st_size)):
            # The fast path. No decode, no hashing, and above all no GPU.
            return None

        with imaging.open_image(path) as img:
            width, height = img.size
            sha = imaging.sha256_file(path)
            ph = imaging.phash(img)

            for size in imaging.THUMB_SIZES:
                imaging.write_thumbnail(img, paths.thumb_path(sha, size), size)

            small = img.copy()
            small.thumbnail((EMBED_MAX_EDGE, EMBED_MAX_EDGE), Image.Resampling.LANCZOS)

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
            is_screenshot=imaging.is_screenshot(path, width, height),
        )
        return image_id, small

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
