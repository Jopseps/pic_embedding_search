"""User preferences, persisted to ~/.config/pic-search/config.toml.

Mirrors the `Settings` interface in src/lib/types.ts. Watched folders live in
SQLite, not here — they carry per-folder state the UI edits constantly.
"""

from __future__ import annotations

import logging
import tomllib
from typing import Any

from .paths import config_path

log = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "modelId": "siglip2-so400m-patch14-384",
    # The model being embedded in the background, if a swap is in flight.
    # `modelId` stays on the model that still answers searches until coverage
    # reaches 100%, so a sidecar killed mid-swap comes back searching rather
    # than blank, and resumes the backfill where it stopped.
    "pendingModelId": None,
    # tesseract, not rapidocr: it is the only engine that speaks `tur+eng`, and
    # its binary is a system package rather than a 450 MB wheel. See ocr.py.
    "ocrEngineId": "tesseract",
    "ocrLangs": ["en", "tr"],
    "theme": "dark",
    "density": 1,
    # Appearance and accessibility. The sidecar never reads these — they are
    # here because config.toml is the only thing that survives a restart, and a
    # scale the user has to set again on every launch is not an accessibility
    # setting. `fontId` names a font that has to be installed; nothing is
    # bundled and nothing is fetched.
    "fontId": "jetbrains-mono",
    "uiScale": 100,
    "reduceMotion": False,
    "highContrast": False,
    # Colour. A hue in OKLCH degrees for the accent, and a hue plus a strength
    # percent for the trace of chroma the greys carry. The sidecar never reads
    # these either — same reason as above, config.toml is what survives a
    # restart. `tintStrength` 100 is what the app shipped with, 0 is neutral.
    "accentHue": 255,
    "tintHue": 250,
    "tintStrength": 100,
    # Grid look, px at 100% UI scale.
    "selectionBorder": 3,
    "cellRadius": 6,
    # Gestures: how long a press has to last to select, and how far a pointer
    # may drift and still count as a click.
    "holdMs": 400,
    "dragSlop": 5,
    # Search. `pageSize` and `searchDebounceMs` belong to the frontend;
    # `textWeight` is read here, by `Searcher.search` — with `sortedSearchKeep`
    # below, the only settings in this file the sidecar acts on. 50 weights the
    # two ranked legs of the hybrid search equally, which is exactly the
    # unweighted RRF.
    "pageSize": 200,
    "searchDebounceMs": 220,
    "textWeight": 50,
    # Order and grouping. `sort` is the browse order and is sent with every
    # request; a query starts at relevance regardless, and whatever it is
    # switched to is session-only. `sortedSearchKeep` is read here: how many of
    # the best matches a query keeps when it is re-sorted by date, name or size.
    "sort": "date-desc",
    "groupBy": "month",
    "sortedSearchKeep": 100,
}

ALLOWED = set(DEFAULTS)


def load() -> dict[str, Any]:
    settings = dict(DEFAULTS)
    path = config_path()
    if(not path.exists()):
        return settings
    try:
        with open(path, "rb") as fh:
            raw = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        log.warning("config.toml unreadable (%s); using defaults", exc)
        return settings
    for key, value in (raw.get("settings") or {}).items():
        if(key in ALLOWED):
            settings[key] = value
    return settings


def save(settings: dict[str, Any]) -> dict[str, Any]:
    merged = {**load(), **{k: v for k, v in settings.items() if k in ALLOWED}}
    config_path().write_text(_dump(merged), encoding="utf-8")
    return merged


def _dump(settings: dict[str, Any]) -> str:
    """Minimal TOML writer — the schema is five flat keys, tomli-w is not worth
    a dependency for it."""
    lines = ["# pic-search settings. Managed by the app; hand edits are read back.", "[settings]"]
    for key in sorted(settings):
        # TOML has no null. A key whose value is None is simply absent, and
        # `load()` puts the default back — which for `pendingModelId` is
        # exactly "no swap in flight".
        if(settings[key] is None):
            continue
        lines.append(f"{key} = {_value(settings[key])}")
    return "\n".join(lines) + "\n"


def _value(value: Any) -> str:
    if(isinstance(value, bool)):
        return "true" if value else "false"
    if(isinstance(value, (int, float))):
        return str(value)
    if(isinstance(value, (list, tuple))):
        return "[" + ", ".join(_value(v) for v in value) + "]"
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
