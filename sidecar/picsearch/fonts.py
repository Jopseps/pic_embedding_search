"""The Install button on the UI fonts in Settings.

Nothing is bundled. A click downloads the font's files from the google/fonts
repository, pinned to one commit, checks each against a stored SHA-256, and puts
them in the user's own font folder (`system.user_fonts_dir`). No admin rights,
no package manager. Every file is named `PicSearch-…`, which is how Remove knows
a file is ours: on Windows the folder is shared with fonts the user installed.

Progress is published as `font-download` events, shaped like `model-download`.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import system

log = logging.getLogger(__name__)

COMMIT = "869789e84da92782c144d83d69b64cec54905b5f"
BASE_URL = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/"
PREFIX = "PicSearch-"


@dataclass(frozen=True)
class FontFile:
    name: str      # written as PREFIX + name
    url_path: str  # under BASE_URL
    sha256: str
    size: int


# Keep the ids in lockstep with FONTS in src/lib/catalog.ts. Only the weights the
# UI uses (400/500/600) are needed; a variable font covers them in one file.
REGISTRY: dict[str, list[FontFile]] = {
    "jetbrains-mono": [
        FontFile("JetBrainsMono[wght].ttf", "jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
                 "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda", 187208),
    ],
    "fira-code": [
        FontFile("FiraCode[wght].ttf", "firacode/FiraCode%5Bwght%5D.ttf",
                 "9335b082b3c7850d98a64b584f3417f65355f3471278bb5eeb8c6c0e8657aeeb", 260364),
    ],
    "cascadia-code": [
        FontFile("CascadiaCode[wght].ttf", "cascadiacode/CascadiaCode%5Bwght%5D.ttf",
                 "30f2e14a5c389b346b1fce110c4ddcf0dc5ce8265faf5eca2ab7323f49dba590", 727940),
    ],
    "ibm-plex-mono": [
        FontFile("IBMPlexMono-Regular.ttf", "ibmplexmono/IBMPlexMono-Regular.ttf",
                 "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46", 135580),
        FontFile("IBMPlexMono-Medium.ttf", "ibmplexmono/IBMPlexMono-Medium.ttf",
                 "a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755", 136704),
        FontFile("IBMPlexMono-SemiBold.ttf", "ibmplexmono/IBMPlexMono-SemiBold.ttf",
                 "d3c38e55c78f5b0f28009fddba4834ec503278936a5986032424c9bd2d23aa46", 140216),
        FontFile("IBMPlexMono-Bold.ttf", "ibmplexmono/IBMPlexMono-Bold.ttf",
                 "ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be", 137784),
    ],
}

CHUNK = 64 * 1024


def _path(f: FontFile) -> Path:
    return system.user_fonts_dir() / (PREFIX + f.name)


def installed(font_id: str) -> bool:
    """Installed *by the app*. A font from pacman or the user is not ours."""
    return all(_path(f).is_file() for f in REGISTRY[font_id])


def status() -> list[dict[str, Any]]:
    return [
        {
            "id": font_id,
            "installed": installed(font_id),
            "sizeBytes": sum(f.size for f in files),
        }
        for font_id, files in REGISTRY.items()
    ]


def fetch(url: str) -> Iterator[bytes]:
    """The one network call. Tests replace it."""
    import httpx

    with httpx.stream("GET", url, follow_redirects=True, timeout=30) as res:
        res.raise_for_status()
        yield from res.iter_bytes(CHUNK)


def install(font_id: str, progress: Callable[[int], None] = lambda done: None) -> None:
    """Download, verify, then move into place. A bad file never lands: each is
    written aside and only renamed in once its size and hash check out."""
    files = REGISTRY[font_id]
    folder = system.user_fonts_dir()
    folder.mkdir(parents=True, exist_ok=True)
    done = 0
    written: list[Path] = []
    try:
        for f in files:
            tmp = folder / (PREFIX + f.name + ".part")
            digest = hashlib.sha256()
            size = 0
            with open(tmp, "wb") as out:
                for chunk in fetch(BASE_URL + f.url_path):
                    size += len(chunk)
                    if(size > f.size):
                        break
                    digest.update(chunk)
                    out.write(chunk)
                    done += len(chunk)
                    progress(done)
            if(size != f.size or digest.hexdigest() != f.sha256):
                tmp.unlink(missing_ok=True)
                raise ValueError(f"{f.name} did not match its checksum")
            written.append(tmp)
        for tmp in written:
            os.replace(tmp, tmp.with_suffix(""))
    finally:
        # Whatever is left as `.part` failed or was interrupted.
        for f in files:
            (folder / (PREFIX + f.name + ".part")).unlink(missing_ok=True)
    placed = [_path(f) for f in files]
    try:
        system.register_fonts(placed)
    except Exception:
        # "Installed by the app" must never mean half installed.
        for p in placed:
            p.unlink(missing_ok=True)
        raise
    log.info("installed font %s", font_id)


def remove(font_id: str) -> None:
    """Delete only our own files. Raises PermissionError on Windows while a
    running app still holds the font; the caller says to restart."""
    paths = [p for p in (_path(f) for f in REGISTRY[font_id]) if p.exists()]
    system.unregister_fonts(paths)
    for p in paths:
        p.unlink()
    system.fonts_removed()
    log.info("removed font %s", font_id)


class Installs:
    """One font install at a time, reported as `font-download` events."""

    def __init__(self, publish: Callable[[str, dict], None]):
        self._publish = publish
        self._lock = threading.Lock()
        self._current: dict[str, Any] | None = None

    @property
    def current(self) -> dict[str, Any] | None:
        with self._lock:
            return None if self._current is None else dict(self._current)

    def active(self, font_id: str | None = None) -> bool:
        current = self.current
        return current is not None and (font_id is None or current["fontId"] == font_id)

    def start(self, font_id: str) -> bool:
        """False when an install is already running."""
        total = sum(f.size for f in REGISTRY[font_id])
        with self._lock:
            if(self._current is not None):
                return False
            self._current = {"fontId": font_id, "done": 0, "total": total, "state": "downloading"}
        threading.Thread(
            target=self._run, args=(font_id,), name="font-install", daemon=True
        ).start()
        return True

    def _emit(self, **fields: Any) -> None:
        with self._lock:
            if(self._current is not None):
                self._current.update(fields)
            payload = dict(self._current) if self._current is not None else dict(fields)
        self._publish("font-download", payload)

    def _run(self, font_id: str) -> None:
        try:
            install(font_id, progress=lambda done: self._emit(done=done))
            self._emit(state="done")
        except Exception as exc:
            log.exception("install of font %s failed", font_id)
            self._emit(state="error", message=str(exc) or type(exc).__name__)
        with self._lock:
            self._current = None
