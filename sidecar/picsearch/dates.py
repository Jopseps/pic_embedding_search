"""When a photo was taken, and what to sort its name by.

The date is resolved once, at index time, and stored in `images.taken_at` so a
single indexed column serves sorting, the date filters, the timeline and
`/counts`. Precedence:

1. **EXIF** `DateTimeOriginal` (then `DateTimeDigitized`, then `DateTime`).
2. **Filename** — `Screenshot_20260530_213645.png`, `IMG_20260530_213645.jpg`,
   `IMG-20260530-WA0012.jpg`, `signal-2026-05-30-213645.jpg`, and any other
   plausible `YYYY-MM-DD` / `YYYYMMDD` with an optional time after it.
3. **File mtime**, which every file has.

Everything is stored as a *naive local wall-clock* ISO string
(`2026-05-30T21:36:45`). EXIF and filenames are local time already; mtime is a
UTC epoch and is converted here. The frontend's `new Date(naive)` reads it back
as local, and the SQL date filters compare against `'now','localtime'`.

Before this module, 299 of 299 rows in a real library were NULL: PNGs carry no
EXIF, and the EXIF read looked for `DateTimeOriginal` in IFD0, where Pillow
never puts it — it lives in the Exif sub-IFD.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image

# Bump when the rules below change. The sidecar re-derives every row's date on
# start when the stored version differs — no GPU, and no rescan needed, since
# an unchanged file would otherwise never be looked at again.
DATE_RULES_VERSION = 1

EXIF_IFD = 0x8769
EXIF_DATETIME_ORIGINAL = 36867
EXIF_DATETIME_DIGITIZED = 36868
EXIF_DATETIME = 306

MIN_YEAR = 1990

SOURCES = ("exif", "filename", "mtime")

# A year, a month and a day, optionally followed by an hour, minute and
# optional second (plus phone-style milliseconds). Separators are optional so
# the compact `20260530_213645` and the spelled-out `2026-05-30 at 21.36.45`
# both parse. The lookarounds keep a date from being cut out of a longer run
# of digits, which is what stops a hash or a counter from reading as a date.
FILENAME_DATE_RE = re.compile(
    r"(?<!\d)(?P<y>(?:19|20)\d{2})[-_.]?(?P<mo>\d{2})[-_.]?(?P<d>\d{2})"
    r"(?:(?:[-_ T.]|\s+at\s+)?(?P<h>\d{2})[-_.:h]?(?P<mi>\d{2})"
    r"(?:[-_.:m]?(?P<s>\d{2}))?(?:\d{3})?)?(?!\d)",
    re.IGNORECASE,
)

DIGITS_RE = re.compile(r"\d+")


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0, tzinfo=None).isoformat()


def _plausible(dt: datetime) -> bool:
    """A date in a filename that is before digital photos or in the future is a
    number that happens to look like a date."""
    return MIN_YEAR <= dt.year and dt <= datetime.now() + timedelta(days=366)


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def _parse_exif_text(raw: object) -> str | None:
    text = str(raw).strip().rstrip("\x00")
    # EXIF spells it "2026:03:14 14:22:00". Cameras with an unset clock write
    # "0000:00:00 00:00:00", which is not a date.
    try:
        dt = datetime.strptime(text[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    return _iso(dt) if _plausible(dt) else None


def from_exif(path: Path | str) -> str | None:
    """EXIF capture time as naive local ISO-8601, or None. Never raises."""
    try:
        with Image.open(path) as img:
            # Pillow's PNG `getexif()` decodes the whole image looking for an
            # eXIf chunk after the pixel data. Screenshots are most of a
            # library and carry none, and the startup refresh would decode
            # every one of them — only a chunk before IDAT is read.
            if(img.format == "PNG" and "exif" not in img.info):
                return None
            exif = img.getexif()
            sub = exif.get_ifd(EXIF_IFD) if exif else {}
    except Exception:
        return None
    if(not exif):
        return None
    # Cameras write DateTimeOriginal into the Exif sub-IFD; a few tools put it
    # in IFD0. DateTime (306) is last — it is the *modification* time.
    order = (
        (sub, EXIF_DATETIME_ORIGINAL), (exif, EXIF_DATETIME_ORIGINAL),
        (sub, EXIF_DATETIME_DIGITIZED), (exif, EXIF_DATETIME),
    )
    for tags, tag in order:
        raw = tags.get(tag)
        if(not raw):
            continue
        parsed = _parse_exif_text(raw)
        if(parsed is not None):
            return parsed
    return None


def from_filename(name: str) -> tuple[datetime, bool] | None:
    """`(datetime, has_time)` for the first plausible date in a filename."""
    for m in FILENAME_DATE_RE.finditer(name):
        has_time = m.group("h") is not None
        try:
            dt = datetime(
                int(m.group("y")), int(m.group("mo")), int(m.group("d")),
                int(m.group("h") or 0), int(m.group("mi") or 0), int(m.group("s") or 0),
            )
        except ValueError:
            # `20261399` or a time of `2599` — try the next candidate rather
            # than give up on the name.
            continue
        if(_plausible(dt)):
            return dt, has_time
    return None


def from_mtime(mtime: float) -> datetime | None:
    if(mtime <= 0):
        return None
    try:
        return datetime.fromtimestamp(mtime)
    except (OverflowError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

def resolve_without_exif(name: str, mtime: float) -> tuple[str | None, str | None]:
    """Filename, then mtime. What a rename re-derives: EXIF did not change."""
    local = from_mtime(mtime)
    named = from_filename(name)
    if(named is not None):
        dt, has_time = named
        # `IMG-20260530-WA0012` names the day only. When the file was written
        # that same day its mtime has the real time, and photos from one day
        # should not all collapse onto midnight.
        if(not has_time and local is not None and local.date() == dt.date()):
            dt = local
        return _iso(dt), "filename"
    if(local is not None):
        return _iso(local), "mtime"
    return None, None


def resolve(path: Path | str, mtime: float) -> tuple[str | None, str | None]:
    """`(taken_at, date_source)`. `date_source` is one of `SOURCES` or None."""
    exif = from_exif(path)
    if(exif is not None):
        return exif, "exif"
    return resolve_without_exif(Path(path).name, mtime)


def name_key(name: str) -> str:
    """Natural sort key: case-folded, digit runs zero-padded, so `img2` sorts
    before `img10`. Stored in a column because `ORDER BY` has to run in SQL —
    browse is paginated."""
    return DIGITS_RE.sub(lambda m: m.group().zfill(20), name.casefold())
