"""OCR: engine registry, language mapping, text extraction.

Screenshots carry text that no embedding model retrieves reliably. "build
failed" is a phrase, not a picture — SigLIP has no way to read it off the
pixels. OCR fills that gap, and `search.py` fuses the two ranked lists with RRF.

Three engines mirror `src/lib/catalog.ts`, and swapping between them is a user
preference, so this registry is the whole extension point: adding an engine is
one class here plus one entry there. Only **tesseract** is expected to be
present (the binary, not a Python package); `rapidocr` and `easyocr` are lazy
imports that raise `OcrUnavailable` with an actionable message when they are
selected without being installed.

Two decisions worth knowing:

* **Languages arrive as ISO 639-1** (`["en", "tr"]`) because that is what the
  UI's language checkboxes emit. Each engine maps them to its own spelling —
  tesseract wants 639-2 (`eng+tur`), easyocr wants the 639-1 codes back.
  Requested languages the engine has no data for are **dropped with a warning,
  never raised**: a missing `tur.traineddata` has to degrade to English OCR, not
  turn every screenshot in the library into an error row.

* **`langs_key` is the *effective* language string, not the requested one.**
  It is what gets written to `ocr_text.langs`, and `Indexer` re-OCRs any image
  whose stored `(engine, langs)` no longer matches the live engine. Storing the
  effective spelling means installing `tesseract-data-tur` later flips the key
  from `eng` to `eng+tur` and the next rescan picks the Turkish text up on its
  own. Storing the requested spelling would have re-OCR'd the library on every
  scan while the data was missing, and never once it arrived.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from collections.abc import Sequence
from functools import lru_cache
from io import BytesIO
from typing import Protocol

from PIL import Image

from . import system

log = logging.getLogger(__name__)

# A dense 4K screenshot yields a few KB; anything past this is noise from a
# failed recognition pass and there is no reason to carry it in SQLite.
MAX_TEXT_CHARS = 20_000

DEFAULT_LANGS = ("en", "tr")
DEFAULT_ENGINE_ID = "tesseract"


class OcrUnavailable(RuntimeError):
    """The engine cannot run here — not installed, or no language data."""


class OcrError(RuntimeError):
    """The engine ran and failed on this particular image."""


class OcrEngine(Protocol):
    id: str
    langs_key: str

    def read(self, image: Image.Image) -> str: ...


def canonical_langs(langs: Sequence[str] | None) -> tuple[str, ...]:
    """Lowercased, de-duplicated, sorted.

    Sorting is what stops `["tr", "en"]` and `["en", "tr"]` from reading as a
    settings change and re-OCRing the whole library.
    """
    if(not langs):
        langs = DEFAULT_LANGS
    return tuple(sorted({str(code).strip().lower() for code in langs if str(code).strip()}))


def clean_text(raw: str) -> str:
    """Collapse the whitespace OCR engines emit around layout."""
    lines = [line.rstrip() for line in raw.replace("\r\n", "\n").split("\n")]
    kept: list[str] = []
    for line in lines:
        stripped = line.strip()
        if(stripped):
            kept.append(re.sub(r"[ \t]{2,}", " ", stripped))
    text = "\n".join(kept)
    return text[:MAX_TEXT_CHARS]


# ---------------------------------------------------------------------------
# Tesseract — the default. The binary is a system package, not a wheel.
# ---------------------------------------------------------------------------

@lru_cache(maxsize=4)
def tesseract_langs(binary: str) -> frozenset[str]:
    """What `tesseract --list-langs` reports. Cached; it shells out."""
    try:
        proc = subprocess.run(
            [binary, "--list-langs"], capture_output=True, timeout=20.0, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("tesseract --list-langs failed: %s", exc)
        return frozenset()
    # The first line is a header ("List of available languages ...").
    lines = proc.stdout.decode("utf-8", "replace").splitlines()
    return frozenset(line.strip() for line in lines[1:] if line.strip())


class TesseractEngine:
    """Shells out to the `tesseract` binary. No Python dependency at all.

    Crisp UI and terminal text is exactly what Tesseract 5's LSTM engine is
    best at, and `-l tur+eng` is a first-class feature rather than a model swap.
    The cost is CPU-only inference, which is why `index.py` runs it on a thread
    pool: the subprocess releases the GIL, so OCR overlaps GPU embedding.
    """

    id = "tesseract"
    # ISO 639-1 (what the UI emits) -> ISO 639-2/T (what tesseract names its
    # traineddata files). Extending the UI list means extending this map.
    LANG_MAP = {
        "en": "eng", "tr": "tur", "de": "deu",
        "es": "spa", "fr": "fra", "ja": "jpn",
    }
    # Page segmentation 3 = fully automatic, no orientation detection. Screens
    # are never rotated, and OSD costs a second per image.
    PSM = "3"

    def __init__(
        self,
        langs: Sequence[str] | None = None,
        binary: str = "tesseract",
        timeout: float = 60.0,
    ):
        found = system.find_tesseract(binary)
        if(found is None):
            raise OcrUnavailable(
                "tesseract is not installed — " + system.tesseract_install_hint()
            )
        self.binary = found
        self.timeout = timeout
        installed = tesseract_langs(found)

        wanted = [self.LANG_MAP[code] for code in canonical_langs(langs) if code in self.LANG_MAP]
        usable = [code for code in wanted if code in installed]
        missing = [code for code in wanted if code not in installed]
        if(missing):
            log.warning(
                "tesseract has no language data for %s — %s;"
                " OCR runs with %s until then",
                "+".join(missing), system.tesseract_langs_hint(missing),
                "+".join(usable) or "nothing",
            )
        if(not usable):
            if("eng" in installed):
                usable = ["eng"]
            elif(installed):
                usable = [sorted(installed)[0]]
            else:
                raise OcrUnavailable("tesseract has no language data installed")
        self.langs = tuple(usable)
        self.langs_key = "+".join(usable)

    def read(self, image: Image.Image) -> str:
        buf = BytesIO()
        # Grayscale halves the bytes through the pipe and costs nothing in
        # accuracy; compress_level=1 because this PNG lives for milliseconds.
        image.convert("L").save(buf, format="PNG", compress_level=1)
        try:
            proc = subprocess.run(
                [self.binary, "stdin", "stdout", "-l", self.langs_key, "--psm", self.PSM],
                input=buf.getvalue(),
                capture_output=True,
                timeout=self.timeout,
                # Tesseract's OpenMP pool fights the ingest thread pool and ends
                # up slower than single-threaded. This is a known one. Extends the
                # environment: replacing it dropped TESSDATA_PREFIX (SYSTEMROOT on Windows).
                env={**os.environ, "OMP_THREAD_LIMIT": "1"},
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise OcrError(f"tesseract timed out after {self.timeout}s") from exc
        except OSError as exc:
            raise OcrError(f"tesseract failed to run: {exc}") from exc
        if(proc.returncode != 0):
            tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            raise OcrError(tail[-1] if tail else f"tesseract exited {proc.returncode}")
        return clean_text(proc.stdout.decode("utf-8", "replace"))


# ---------------------------------------------------------------------------
# RapidOCR — optional, `uv sync --extra ocr`
# ---------------------------------------------------------------------------

class RapidOcrEngine:
    """ONNX PP-OCR. Stronger than tesseract on photos and messy layouts.

    Its default recognition model is PP-OCRv4 Chinese+English, whose dictionary
    has no `ş ğ ı İ` — Turkish comes back with the diacritics mangled or
    dropped. That is why tesseract is the default engine here despite this one
    being the nicer library. Swapping in a Latin recognition model would fix it
    and is a separate piece of work.
    """

    id = "rapidocr"

    def __init__(self, langs: Sequence[str] | None = None):
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as exc:
            raise OcrUnavailable(
                "rapidocr is not installed — run `uv sync --extra ocr` in sidecar/"
            ) from exc
        self._engine = RapidOCR()
        self.requested = canonical_langs(langs)
        # Not a lie by omission: the bundled model is what it is, and the key
        # records that rather than the languages the user asked for.
        self.langs = ("en",)
        self.langs_key = "ppocr-ch"

    def read(self, image: Image.Image) -> str:
        import numpy as np

        result, _elapsed = self._engine(np.asarray(image.convert("RGB")))
        if(not result):
            return ""
        return clean_text("\n".join(str(line[1]) for line in result))


# ---------------------------------------------------------------------------
# EasyOCR — optional, not declared as a dependency
# ---------------------------------------------------------------------------

class EasyOcrEngine:
    """PyTorch OCR, 80+ languages including Turkish. Heavy: its own model zoo."""

    id = "easyocr"
    # easyocr speaks ISO 639-1 already, with a handful of exceptions that do not
    # appear in the UI's language list.
    LANG_MAP = {"en": "en", "tr": "tr", "de": "de", "es": "es", "fr": "fr", "ja": "ja"}

    def __init__(self, langs: Sequence[str] | None = None):
        try:
            import easyocr
        except ImportError as exc:
            raise OcrUnavailable(
                "easyocr is not installed — `uv add easyocr` in sidecar/ (large: pulls its"
                " own detection and recognition weights)"
            ) from exc
        codes = [self.LANG_MAP[c] for c in canonical_langs(langs) if c in self.LANG_MAP] or ["en"]
        self.langs = tuple(codes)
        self.langs_key = "+".join(codes)
        self._reader = easyocr.Reader(list(codes), verbose=False)

    def read(self, image: Image.Image) -> str:
        import numpy as np

        lines = self._reader.readtext(np.asarray(image.convert("RGB")), detail=0)
        return clean_text("\n".join(str(line) for line in lines))


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ENGINES: dict[str, type] = {
    "rapidocr": RapidOcrEngine,
    "tesseract": TesseractEngine,
    "easyocr": EasyOcrEngine,
}


def build(engine_id: str, langs: Sequence[str] | None = None) -> OcrEngine:
    """Construct one engine by id. Raises rather than falling back."""
    try:
        cls = ENGINES[engine_id]
    except KeyError as exc:
        known = ", ".join(sorted(ENGINES))
        raise KeyError(f"unknown OCR engine {engine_id!r}; known: {known}") from exc
    return cls(langs)


def install_hint(engine_id: str | None, langs: Sequence[str] | None = None) -> str | None:
    """What the user has to install for the configured OCR to work fully.

    None when nothing is missing. Only tesseract gets a hint: it is the
    default, and the other engines are opt-in extras whose users installed
    them on purpose.
    """
    if((engine_id or DEFAULT_ENGINE_ID) != "tesseract"):
        return None
    wanted = [
        TesseractEngine.LANG_MAP[code] for code in canonical_langs(langs)
        if code in TesseractEngine.LANG_MAP
    ]
    binary = system.find_tesseract()
    if(binary is None):
        return (
            "Tesseract is not installed, so text inside screenshots is not searchable."
            " Install it with: " + system.tesseract_install_hint(wanted)
        )
    missing = [code for code in wanted if code not in tesseract_langs(binary)]
    if(missing):
        return (
            f"Tesseract has no {'+'.join(missing)} language data."
            " Add it with: " + system.tesseract_langs_hint(missing)
        )
    return None


def resolve(engine_id: str | None, langs: Sequence[str] | None = None) -> OcrEngine | None:
    """Best-effort construction, for startup.

    Falls back through the registry and finally returns `None`, which disables
    OCR. A user whose saved engine is no longer installed gets a degraded app
    with a warning in the log, not a sidecar that refuses to boot.
    """
    order = [engine_id or DEFAULT_ENGINE_ID]
    if(DEFAULT_ENGINE_ID not in order):
        order.append(DEFAULT_ENGINE_ID)
    order += [eid for eid in ENGINES if eid not in order]

    for candidate in order:
        try:
            engine = build(candidate, langs)
        except (KeyError, OcrUnavailable) as exc:
            log.warning("OCR engine %r unavailable: %s", candidate, exc)
            continue
        except Exception as exc:  # a broken install should not take the app down
            log.warning("OCR engine %r failed to initialise: %s", candidate, exc)
            continue
        if(candidate != (engine_id or DEFAULT_ENGINE_ID)):
            log.warning("falling back to OCR engine %r", candidate)
        log.info("OCR engine %s (%s)", engine.id, engine.langs_key)
        return engine

    log.warning("no OCR engine is available; screenshots will not be searchable by their text")
    return None
