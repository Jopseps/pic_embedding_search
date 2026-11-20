"""The "Check for updates" button in Settings > About.

One request to the GitHub releases API, only when the user asks (or has turned
on the startup check). `releases/latest` skips drafts and pre-releases, so a
release CI has built but nobody has published is never offered. Nothing is
downloaded: "Open release page" hands the fixed releases URL to the browser.
"""

from __future__ import annotations

import logging
import webbrowser
from typing import Any

from . import __version__

log = logging.getLogger(__name__)

LATEST_API = "https://api.github.com/repos/Jopseps/pic_embedding_search/releases/latest"
RELEASES_PAGE = "https://github.com/Jopseps/pic_embedding_search/releases/latest"


def parse_version(tag: str) -> tuple[int, ...]:
    """`v1.0.10` -> (1, 0, 10). Raises ValueError on anything that is not dotted
    integers: a tag like `1.1.0-beta` is refused rather than guessed at."""
    return tuple(int(part) for part in tag.strip().removeprefix("v").split("."))


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    # `1.1` and `1.1.0` are the same release; tuple order alone calls the first older.
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def fetch() -> Any:
    """The one network call. Tests replace it."""
    import httpx

    res = httpx.get(
        LATEST_API,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "PicSearch"},
        timeout=5,
        follow_redirects=True,
    )
    res.raise_for_status()
    return res.json()


def check() -> dict[str, Any]:
    """Never raises: offline, a rate limit, a bad body and an odd tag all come
    back as `ok: false`, which the UI shows as "could not check"."""
    try:
        latest = str(fetch()["tag_name"]).strip().removeprefix("v")
        available = is_newer(latest, __version__)
    except Exception as exc:
        log.info("update check failed: %s", exc)
        return {"current": __version__, "latest": None, "available": False, "ok": False}
    return {"current": __version__, "latest": latest, "available": available, "ok": True}


def open_release_page() -> bool:
    return bool(webbrowser.open(RELEASES_PAGE))
