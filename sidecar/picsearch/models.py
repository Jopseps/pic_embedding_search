"""Model weights on disk: what is downloaded, how big, fetching one, deleting one.

Weights live in the standard HuggingFace hub cache, shared with every other
tool on the machine. Nothing here touches the index: a model's vectors stay in
the library database when its files are deleted, so switching back needs a
download but no re-index.
"""

from __future__ import annotations

import logging
import os
import shutil
import stat
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import embed
from .doctor import hf_cache_dir, weights_dir

log = logging.getLogger(__name__)

# What `from_pretrained` actually fetches. A repo that also carries .bin,
# .onnx or .msgpack copies would otherwise inflate the total and the bar would
# stop at 40%.
FETCHED_SUFFIXES = (".safetensors", ".json", ".model", ".txt", ".py", ".tiktoken")

POLL_SEC = 0.5


def repo_dir(hf_id: str) -> Path:
    return hf_cache_dir() / ("models--" + hf_id.replace("/", "--"))


def repo_bytes(hf_id: str) -> int:
    """Bytes the cached repo holds: every regular file, symlinks not followed.

    On Linux `blobs/` holds the files and `snapshots/` symlinks into them, so
    following links would count everything twice. On Windows without symlink
    rights huggingface_hub *moves* each finished blob into `snapshots/`, so
    counting `blobs/` alone fell back to zero as every file completed and the
    progress bar ran backwards. Regular files only is right on both.
    In-flight downloads are `*.incomplete` regular files in `blobs/`.
    """
    total = 0
    for dirpath, _dirnames, filenames in os.walk(repo_dir(hf_id)):
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except OSError:
                continue
            if(stat.S_ISREG(st.st_mode)):
                total += st.st_size
    return total


def expected_bytes(hf_id: str) -> int:
    """The download size, or 0 when the hub cannot be asked."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(hf_id, files_metadata=True)
    except Exception as exc:
        log.warning("could not size %s: %s", hf_id, exc)
        return 0
    total = 0
    for sibling in info.siblings or []:
        if(sibling.rfilename.endswith(FETCHED_SUFFIXES) and sibling.size):
            total += sibling.size
    return total


def has_weights(model_id: str) -> bool:
    return weights_dir(embed.spec_for(model_id).hf_id) is not None


def status(model_id: str) -> dict[str, Any]:
    spec = embed.spec_for(model_id)
    downloaded = has_weights(model_id)
    return {
        "id": spec.model_id,
        "downloaded": downloaded,
        "sizeBytes": repo_bytes(spec.hf_id) if downloaded else 0,
    }


def delete(model_id: str) -> int:
    """Remove a model's cached files. Returns the bytes freed.

    Only the files. The caller refuses the model that is serving or loading;
    this does not know about either.
    """
    spec = embed.spec_for(model_id)
    freed = repo_bytes(spec.hf_id)

    def writable(func, path, _exc):
        # Windows: a read-only file blocks its own removal.
        os.chmod(path, stat.S_IWRITE)
        func(path)

    for target in (repo_dir(spec.hf_id), hf_cache_dir() / ".locks" / repo_dir(spec.hf_id).name):
        if(target.exists()):
            shutil.rmtree(target, onexc=writable)
    log.info("deleted %s (%d bytes)", spec.hf_id, freed)
    return freed


class Downloads:
    """One model download at a time, reporting progress as events.

    `publish(kind, payload)` is the event bus. `then` runs on the worker
    thread after a successful download, `failed` after an unsuccessful one.
    """

    def __init__(self, publish: Callable[[str, dict], None]):
        self._publish = publish
        self._lock = threading.Lock()
        self._current: dict[str, Any] | None = None

    @property
    def current(self) -> dict[str, Any] | None:
        with self._lock:
            return None if self._current is None else dict(self._current)

    def active(self, model_id: str | None = None) -> bool:
        current = self.current
        return current is not None and (model_id is None or current["modelId"] == model_id)

    def start(
        self,
        model_id: str,
        then: Callable[[], None] | None = None,
        failed: Callable[[], None] | None = None,
    ) -> bool:
        """False when a download is already running (the caller asks again later)."""
        embed.spec_for(model_id)
        with self._lock:
            if(self._current is not None):
                return False
            self._current = {"modelId": model_id, "done": 0, "total": 0, "state": "downloading"}
        threading.Thread(
            target=self._run, args=(model_id, then, failed), name="model-download", daemon=True
        ).start()
        return True

    def _emit(self, **fields: Any) -> None:
        with self._lock:
            if(self._current is not None):
                self._current.update(fields)
            payload = dict(self._current) if self._current is not None else dict(fields)
        self._publish("model-download", payload)

    def _run(self, model_id: str, then, failed) -> None:
        spec = embed.spec_for(model_id)
        stop = threading.Event()
        ok = False
        try:
            total = 0 if weights_dir(spec.hf_id) is not None else expected_bytes(spec.hf_id)
            self._emit(total=total, done=0, state="downloading")

            def watch() -> None:
                while(not stop.wait(POLL_SEC)):
                    done = repo_bytes(spec.hf_id)
                    self._emit(done=min(done, total) if total else done)

            threading.Thread(target=watch, name="model-download-watch", daemon=True).start()

            from huggingface_hub import snapshot_download
            from huggingface_hub.utils import disable_progress_bars

            disable_progress_bars()
            snapshot_download(spec.hf_id, allow_patterns=[f"*{s}" for s in FETCHED_SUFFIXES])
            ok = True
        except Exception as exc:
            log.exception("download of %s failed", spec.hf_id)
            stop.set()
            self._emit(state="error", message=str(exc) or type(exc).__name__)
        finally:
            stop.set()
        if(ok):
            size = repo_bytes(spec.hf_id)
            self._emit(done=size, total=size, state="done")
        with self._lock:
            self._current = None
        # After the slot is free, so `then` may start another download.
        callback = then if ok else failed
        if(callback is not None):
            try:
                callback()
            except Exception:
                log.exception("after-download step for %s raised", model_id)
