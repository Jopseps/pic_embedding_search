"""Decoding, EXIF rotation, hashing, thumbnails — everything that touches pixels.

`index.py` orchestrates ingest; the per-file pixel work lives here so it can be
tested without a database and reused by `dupes.py`.
"""

from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

log = logging.getLogger(__name__)

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # pragma: no cover - HEIC support is optional
    log.debug("pillow-heif unavailable; HEIC/HEIF files will be skipped")

Image.MAX_IMAGE_PIXELS = 512_000_000

SUPPORTED_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".avif",
}

MIME_BY_SUFFIX = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
    ".heif": "image/heif", ".avif": "image/avif",
}

SCREENSHOT_DIR_RE = re.compile(r"screenshot|ekran|screen shot", re.IGNORECASE)

# Common panel and phone resolutions, both orientations are checked.
SCREEN_RESOLUTIONS: set[tuple[int, int]] = {
    (1280, 720), (1366, 768), (1440, 900), (1600, 900), (1680, 1050),
    (1920, 1080), (1920, 1200), (2048, 1152), (2240, 1400), (2256, 1504),
    (2560, 1440), (2560, 1600), (2880, 1620), (2880, 1800), (3024, 1964),
    (3072, 1920), (3200, 1800), (3440, 1440), (3456, 2234), (3840, 2160),
    (1080, 1920), (1170, 2532), (1179, 2556), (1284, 2778), (1290, 2796),
    (1440, 2560), (1440, 3120), (1440, 3200), (750, 1334), (828, 1792),
}


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_SUFFIXES


def mime_for(path: Path) -> str:
    return MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")


def open_image(path: Path | str) -> Image.Image:
    """RGB, EXIF-rotation applied. Everything downstream assumes both."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if(img.mode != "RGB"):
        img = img.convert("RGB")
    return img


def sha256_file(path: Path | str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while(True):
            block = fh.read(chunk)
            if(not block):
                break
            h.update(block)
    return h.hexdigest()


def is_screenshot(path: Path, width: int, height: int) -> bool:
    if(SCREENSHOT_DIR_RE.search(path.parent.name)):
        return True
    if(SCREENSHOT_DIR_RE.search(path.name)):
        return True
    return (width, height) in SCREEN_RESOLUTIONS or (height, width) in SCREEN_RESOLUTIONS


# ---------------------------------------------------------------------------
# Perceptual hash
# ---------------------------------------------------------------------------

_PHASH_SIZE = 32
_PHASH_LOW = 8


def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n)
    basis = np.cos(np.pi * (2 * k[None, :] + 1) * k[:, None] / (2 * n))
    scale = np.full((n, 1), np.sqrt(2.0 / n))
    scale[0, 0] = np.sqrt(1.0 / n)
    return (basis * scale).astype(np.float64)


_DCT = _dct_matrix(_PHASH_SIZE)


def phash(img: Image.Image) -> int:
    """64-bit DCT perceptual hash.

    This — not cosine — is the duplicate detector. SigLIP puts two entirely
    different screenshots of the same IDE at ~0.97; only pixel structure can
    tell "the same image twice" from "the same application twice".
    """
    small = img.convert("L").resize((_PHASH_SIZE, _PHASH_SIZE), Image.Resampling.LANCZOS)
    pixels = np.asarray(small, dtype=np.float64)
    coeffs = _DCT @ pixels @ _DCT.T
    low = coeffs[:_PHASH_LOW, :_PHASH_LOW].flatten()
    # Drop the DC term from the median: it dominates and flattens the hash.
    median = float(np.median(low[1:]))
    bits = low > median
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


# ---------------------------------------------------------------------------
# Thumbnails
# ---------------------------------------------------------------------------

THUMB_SIZES = (256, 512)


def write_thumbnail(img: Image.Image, dest: Path, size: int) -> None:
    """WebP, longest edge == `size`, aspect preserved. Generated at ingest only.

    Serving originals into the grid is the single biggest perf killer for this
    class of app, so nothing downstream is allowed to resize on demand.
    """
    thumb = img.copy()
    thumb.thumbnail((size, size), Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".webp.tmp")
    thumb.save(tmp, format="WEBP", quality=82, method=4)
    tmp.replace(dest)
