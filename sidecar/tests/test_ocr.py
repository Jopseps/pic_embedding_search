"""OCR engine registry and the tesseract adapter.

The registry-parity test is the important one everywhere: if the ids here and in
`src/lib/catalog.ts` drift, the settings dropdown selects an engine the backend
does not have.

The tesseract tests skip when the binary is absent rather than being gated
behind an env var — there is nothing to download, so on a machine that has it
they should always run.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from picsearch import ocr
from picsearch.ocr import (
    DEFAULT_ENGINE_ID,
    ENGINES,
    MAX_TEXT_CHARS,
    OcrUnavailable,
    TesseractEngine,
    build,
    canonical_langs,
    clean_text,
    resolve,
    tesseract_langs,
)

CATALOG_TS = Path(__file__).resolve().parents[2] / "src" / "lib" / "catalog.ts"

needs_tesseract = pytest.mark.skipif(
    shutil.which("tesseract") is None, reason="tesseract is not installed"
)


def render(lines: list[str], size: tuple[int, int] = (900, 320)) -> Image.Image:
    """A synthetic screenshot. Pillow's default font is scalable since 10.1."""
    font = ImageFont.load_default(size=44)
    img = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((30, 40 + i * 80), line, fill="black", font=font)
    return img


# -- registry parity --------------------------------------------------------

def parse_catalog_engines() -> tuple[list[str], str]:
    text = CATALOG_TS.read_text(encoding="utf-8")
    block = text.split("OCR_ENGINES", 1)[1].split("];", 1)[0]
    ids = re.findall(r'id:\s*"([^"]+)"', block)
    default = re.search(r'DEFAULT_OCR_ENGINE_ID\s*=\s*"([^"]+)"', text)
    assert default is not None
    return ids, default.group(1)


def test_engine_ids_match_catalog_ts():
    ids, _default = parse_catalog_engines()
    assert set(ids) == set(ENGINES), (
        "ocr.py ENGINES and src/lib/catalog.ts disagree on engine ids"
    )


def test_default_engine_matches_catalog_ts():
    _ids, default = parse_catalog_engines()
    assert default == DEFAULT_ENGINE_ID


def test_build_rejects_an_unknown_engine():
    with pytest.raises(KeyError):
        build("apple-vision", ["en"])


# -- languages --------------------------------------------------------------

def test_canonical_langs_sorts_and_dedupes():
    # ["tr","en"] and ["en","tr"] must produce the same key, or a settings
    # round-trip reads as a change and re-OCRs the whole library.
    assert canonical_langs(["tr", "en"]) == canonical_langs(["en", "TR", "tr"]) == ("en", "tr")


def test_canonical_langs_falls_back_to_the_default_pair():
    assert canonical_langs([]) == ("en", "tr")
    assert canonical_langs(None) == ("en", "tr")


# -- text cleanup -----------------------------------------------------------

def test_clean_text_drops_blank_lines_and_collapses_runs():
    assert clean_text("  build   failed  \n\n\n  at line 3\n") == "build failed\nat line 3"


def test_clean_text_caps_length():
    assert len(clean_text("x" * (MAX_TEXT_CHARS + 500))) == MAX_TEXT_CHARS


# -- resolve() degrades, never raises ---------------------------------------

class Broken:
    id = "broken"

    def __init__(self, langs=None):
        raise OcrUnavailable("nope")


class Fake:
    id = "fake"

    def __init__(self, langs=None):
        self.langs_key = "fake"

    def read(self, image):
        return "fake"


def test_resolve_falls_back_past_an_unavailable_engine(monkeypatch):
    monkeypatch.setattr(ocr, "ENGINES", {"broken": Broken, "fake": Fake})
    monkeypatch.setattr(ocr, "DEFAULT_ENGINE_ID", "fake")
    engine = resolve("broken", ["en"])
    assert engine is not None and engine.id == "fake"


def test_resolve_returns_none_when_nothing_is_installed(monkeypatch):
    monkeypatch.setattr(ocr, "ENGINES", {"broken": Broken})
    monkeypatch.setattr(ocr, "DEFAULT_ENGINE_ID", "broken")
    # No OCR is a degraded app, not a sidecar that refuses to boot.
    assert resolve("broken", ["en"]) is None


def test_resolve_survives_an_engine_that_raises_something_unexpected(monkeypatch):
    class Exploding:
        id = "exploding"

        def __init__(self, langs=None):
            raise ValueError("a broken install, not a missing one")

    monkeypatch.setattr(ocr, "ENGINES", {"exploding": Exploding, "fake": Fake})
    monkeypatch.setattr(ocr, "DEFAULT_ENGINE_ID", "fake")
    assert resolve("exploding", ["en"]) is not None


# -- tesseract --------------------------------------------------------------

@needs_tesseract
def test_tesseract_reads_rendered_text():
    engine = TesseractEngine(["en"])
    text = engine.read(render(["ERROR: build failed", "npm run tauri dev"]))
    assert "build failed" in text
    assert "tauri" in text


@needs_tesseract
def test_tesseract_only_asks_for_language_data_that_exists():
    installed = tesseract_langs(shutil.which("tesseract"))
    # "ja" and "tr" may or may not be installed here; whichever survive must be
    # ones tesseract actually has, or every call would exit non-zero.
    engine = TesseractEngine(["en", "tr", "ja"])
    assert set(engine.langs_key.split("+")) <= installed


@needs_tesseract
def test_tesseract_langs_key_ignores_the_order_it_was_given():
    assert TesseractEngine(["tr", "en"]).langs_key == TesseractEngine(["en", "tr"]).langs_key


@needs_tesseract
def test_tesseract_returns_empty_text_for_a_blank_image():
    # The empty string is a real answer — index.py stores it as the "OCR ran,
    # found nothing" marker so the image is not read again on every rescan.
    assert TesseractEngine(["en"]).read(Image.new("RGB", (600, 400), "white")) == ""


def test_tesseract_says_what_to_install_when_the_binary_is_missing():
    with pytest.raises(OcrUnavailable, match="not on PATH"):
        TesseractEngine(["en"], binary="tesseract-that-does-not-exist")
