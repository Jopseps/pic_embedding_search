"""`python -m picsearch.prefetch` — download the active model's weights now.

Run by the packaged app's first-run setup, after the environment is built, so
the first index does not stall for minutes on a silent 1.5 GB download. It is
also the setup's smoke test: it imports torch and transformers and loads the
model once, which is exactly what the sidecar will do later.

Talks to the Rust shell over stdout, one line at a time:

    PROGRESS <done_bytes> <total_bytes>     total is 0 when unknown
    NOTE <text>                             something the user should read
    <anything else>                         a log line for the setup screen

Weights go to the standard HuggingFace cache, shared with every other tool.
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time

from . import config, embed, ocr, paths, system
from .doctor import hf_cache_dir, weights_dir

log = logging.getLogger(__name__)

# What `from_pretrained` actually fetches. A repo that also carries .bin,
# .onnx or .msgpack copies would otherwise inflate the total and the bar would
# stop at 40%.
FETCHED_SUFFIXES = (".safetensors", ".json", ".model", ".txt", ".py", ".tiktoken")


def say(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


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


def repo_bytes(hf_id: str) -> int:
    # `blobs/` only: `snapshots/` is symlinks into it, and getsize follows
    # them, so measuring the whole repo dir counts every byte twice.
    # In-flight downloads land in `blobs/` too, as `*.incomplete`.
    repo = hf_cache_dir() / ("models--" + hf_id.replace("/", "--"))
    return paths.dir_size_bytes(repo / "blobs")


def report_progress(hf_id: str, total: int, stop: threading.Event) -> None:
    while(not stop.wait(0.5)):
        done = repo_bytes(hf_id)
        # The cache dir holds a few KB of refs before any blob lands, and a
        # finished download can overshoot a total computed from the listing.
        say(f"PROGRESS {min(done, total) if total else done} {total}")


def fetch(model_id: str) -> None:
    import torch
    from transformers import AutoModel, AutoProcessor

    spec = embed.spec_for(model_id)
    cached = weights_dir(spec.hf_id) is not None
    say(f"{'Checking' if cached else 'Downloading'} {spec.hf_id}")

    total = 0 if cached else expected_bytes(spec.hf_id)
    stop = threading.Event()
    watcher = threading.Thread(target=report_progress, args=(spec.hf_id, total, stop), daemon=True)
    watcher.start()
    try:
        kwargs = {"trust_remote_code": spec.trust_remote_code}
        # float16 on the CPU halves the RAM this costs; it is loaded to prove
        # the files are complete and the environment can run it, then dropped.
        model = embed.load_pretrained(AutoModel, spec.hf_id, dtype=torch.float16, **kwargs)
        if(spec.kind != "jina"):
            embed.load_pretrained(AutoProcessor, spec.hf_id, **kwargs)
        del model
    finally:
        stop.set()
        watcher.join()

    done = repo_bytes(spec.hf_id)
    say(f"PROGRESS {done} {done}")
    say(f"{spec.hf_id} ready")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="download the active model's weights")
    parser.add_argument("--model", default=None, help="defaults to modelId in config.toml")
    parser.add_argument("--parent-pid", type=int, default=None, help="exit with this process")
    args = parser.parse_args(argv)
    if(args.parent_pid is not None):
        # An app killed mid-download must not leave this one fetching 1.5 GB.
        system.start_parent_watchdog(args.parent_pid)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    settings = config.load()
    model_id = args.model or str(settings.get("modelId") or embed.DEFAULT_MODEL_ID)
    start = time.monotonic()
    fetch(model_id)
    say(f"model check took {time.monotonic() - start:.0f}s")

    # Not part of the install — tesseract is a system package — but setup is
    # the one screen every new user reads, so this is where to say it.
    hint = ocr.install_hint(settings.get("ocrEngineId"), settings.get("ocrLangs"))
    if(hint is not None):
        say(f"NOTE {hint}")
    return 0


if(__name__ == "__main__"):
    raise SystemExit(main())

