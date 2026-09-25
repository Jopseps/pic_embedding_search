"""XDG path resolution.

Every writable location the sidecar touches resolves through here. Nothing is
hardcoded to a user's home directory, and nothing is ever written into the
project directory at runtime.

Each root honours an environment override so tests can point the whole app at a
tmpdir without monkeypatching platformdirs.
"""

from __future__ import annotations

import os
from pathlib import Path

from platformdirs import user_cache_dir, user_config_dir, user_data_dir

APP_NAME = "pic-search"

ENV_DATA_DIR = "PICSEARCH_DATA_DIR"
ENV_CONFIG_DIR = "PICSEARCH_CONFIG_DIR"
ENV_CACHE_DIR = "PICSEARCH_CACHE_DIR"


def _resolve(env_var: str, fallback: str) -> Path:
    override = os.environ.get(env_var)
    if(override):
        root = Path(override).expanduser()
    else:
        root = Path(fallback)
    root.mkdir(parents=True, exist_ok=True)
    return root


def data_dir() -> Path:
    """~/.local/share/pic-search — index.db and thumbnails."""
    return _resolve(ENV_DATA_DIR, user_data_dir(APP_NAME))


def config_dir() -> Path:
    """~/.config/pic-search — config.toml."""
    return _resolve(ENV_CONFIG_DIR, user_config_dir(APP_NAME))


def cache_dir() -> Path:
    """~/.cache/pic-search — scratch. Model weights live in the HF cache."""
    return _resolve(ENV_CACHE_DIR, user_cache_dir(APP_NAME))


def subtree_prefix(path: str | Path) -> str:
    """`path` with one trailing separator: what every stored path under it
    starts with.

    The platform's separator, not `/`: stored paths are `str(Path(...))`, so on
    Windows they read `C:\\Users\\…`, and a `/`-joined prefix silently matches
    nothing — no pruning, no folder filter, no directory rename.
    """
    return str(path).rstrip("/" + os.sep) + os.sep


def db_path() -> Path:
    return data_dir() / "index.db"


def config_path() -> Path:
    return config_dir() / "config.toml"


def thumbs_dir() -> Path:
    return data_dir() / "thumbs"


def thumb_path(sha256: str, size: int) -> Path:
    """Sharded as <sha[:2]>/<sha[2:4]>/<sha>_<size>.webp.

    Two levels of 256-way fan-out keeps any single directory small enough that
    listing it stays fast at library sizes well past what this app targets.
    """
    if(len(sha256) < 4):
        raise ValueError(f"sha256 too short to shard: {sha256!r}")
    return thumbs_dir() / sha256[:2] / sha256[2:4] / f"{sha256}_{size}.webp"


def ensure_thumb_parent(sha256: str, size: int) -> Path:
    p = thumb_path(sha256, size)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def dir_size_bytes(root: Path) -> int:
    total = 0
    if(not root.exists()):
        return 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                continue
    return total
