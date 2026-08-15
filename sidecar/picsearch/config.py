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
    # tesseract, not rapidocr: it is the only engine that speaks `tur+eng`, and
    # its binary is a system package rather than a 450 MB wheel. See ocr.py.
    "ocrEngineId": "tesseract",
    "ocrLangs": ["en", "tr"],
    "theme": "dark",
    "density": 1,
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
