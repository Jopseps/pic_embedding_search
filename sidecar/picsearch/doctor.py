"""`uv run python -m picsearch.doctor` — why the app is not working.

Everything a fresh clone gets wrong is invisible from inside the UI. Tesseract
missing, `tessdata` without `tur`, torch quietly on the CPU, a `config.toml`
naming an engine that is not installed, zero watched folders — all of them
produce the same symptom, an empty grid, and none of them say so. This prints
the state of each one next to the exact command that fixes it.

Deliberately shallow. It never loads the model and never spawns the server, so
it costs a couple of seconds and no VRAM, and it can be run while the app is
open. It is also **read only**: it does not run `uv sync`, does not rewrite
`config.toml`, never calls sudo, and does not create an index if none exists.
Every repair is printed for a human to run.

Exit code is 1 when something is actually broken and 0 when the app should
work, so it can gate CI later without changing shape.
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import config, embed, ocr, paths, system
from .store import Store

GOOD = "good"
WARN = "warn"
BAD = "bad"

# mark, ANSI colour
MARKS = {GOOD: ("✓", "32"), WARN: ("!", "33"), BAD: ("✗", "31")}

LABEL_WIDTH = 13

# `parents[2]` is the repo root when running from a checkout: this file is
# <root>/sidecar/picsearch/doctor.py. Installed as a wheel there is no root, so
# every use of it is gated on package.json existing.
REPO_ROOT = Path(__file__).resolve().parents[2]


class Report:
    """Prints as it goes and remembers how bad it was."""

    def __init__(self, color: bool = True):
        self.color = color
        self.bad = 0
        self.warn = 0

    def paint(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def section(self, title: str) -> None:
        print("\n" + self.paint(title, "1"))

    def line(self, level: str, label: str, detail: str = "", fix: str = "") -> None:
        mark, code = MARKS[level]
        print(f"  {self.paint(mark, code)} {label.ljust(LABEL_WIDTH)} {detail}".rstrip())
        if(fix):
            print(f"    {self.paint('→ ' + fix, '36')}")
        if(level == BAD):
            self.bad += 1
        elif(level == WARN):
            self.warn += 1

    def note(self, text: str) -> None:
        """Context, not a verdict. Never counts toward the exit code."""
        print(f"    {self.paint(text, '90')}")

    def summary(self) -> int:
        print()
        if(self.bad):
            print(self.paint(f"{self.bad} broken, {self.warn} warnings", "31"))
        elif(self.warn):
            print(self.paint(f"looks runnable — {self.warn} warnings", "33"))
        else:
            print(self.paint("all good", "32"))
        return 1 if self.bad else 0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def version_of(binary: str, *args: str) -> str | None:
    """First line of `<binary> --version`, or None when it is not on PATH."""
    found = shutil.which(binary)
    if(found is None):
        return None
    try:
        proc = subprocess.run(
            [found, *(args or ("--version",))], capture_output=True, timeout=15.0, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = (proc.stdout or proc.stderr).decode("utf-8", "replace").strip()
    return text.splitlines()[0] if text else found


def human(n_bytes: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if(n_bytes < 1024 or unit == "GB"):
            return f"{n_bytes:.1f} {unit}" if unit != "B" else f"{int(n_bytes)} B"
        n_bytes /= 1024
    return f"{n_bytes:.1f} GB"


def hf_cache_dir() -> Path:
    """The shared HuggingFace hub cache, honouring the standard overrides."""
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(var)
        if(value):
            return Path(value).expanduser()
    home = os.environ.get("HF_HOME")
    if(home):
        return Path(home).expanduser() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def weights_dir(hf_id: str) -> Path | None:
    """Where `hf_id` is cached, or None if nothing has been downloaded.

    A `snapshots/<rev>/` with anything in it is the marker. An empty repo dir
    is what an interrupted download leaves behind, and it must not read as a
    hit — the app would then look broken rather than "still downloading".
    """
    repo = hf_cache_dir() / ("models--" + hf_id.replace("/", "--"))
    snapshots = repo / "snapshots"
    if(not snapshots.is_dir()):
        return None
    for snapshot in snapshots.iterdir():
        if(snapshot.is_dir() and any(snapshot.iterdir())):
            return repo
    return None


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

def check_toolchain(r: Report) -> None:
    r.section("Toolchain")
    for binary, fix in (
        ("uv", "https://docs.astral.sh/uv/getting-started/installation/"),
        ("node", "install Node 22+"),
        ("rustc", "https://rustup.rs"),
    ):
        version = version_of(binary)
        if(version is None):
            r.line(BAD, binary, "not on PATH", fix)
        else:
            r.line(GOOD, binary, version)

    r.line(GOOD, "python", sys.version.split()[0])

    if((REPO_ROOT / "package.json").is_file()):
        if((REPO_ROOT / "node_modules").is_dir()):
            r.line(GOOD, "node_modules", "installed")
        else:
            r.line(BAD, "node_modules", "missing — the desktop shell cannot start", "npm install")


def check_gpu(r: Report) -> None:
    r.section("GPU")
    try:
        import torch
    except ImportError as exc:
        r.line(BAD, "torch", str(exc), "cd sidecar && uv sync")
        return

    r.line(GOOD, "torch", torch.__version__)
    if(torch.cuda.is_available()):
        props = torch.cuda.get_device_properties(0)
        vram = human(props.total_memory)
        r.line(GOOD, "cuda", f"{torch.cuda.get_device_name(0)}, {vram}, CUDA {torch.version.cuda}")
    else:
        built = torch.version.cuda
        r.line(
            WARN, "cuda", "not available — embedding falls back to the CPU, roughly 20x slower",
            "check the NVIDIA driver"
            + (f"; this torch was built against CUDA {built}" if built else ""),
        )


def check_model(r: Report, settings: dict) -> None:
    r.section("Model")
    model_id = str(settings.get("modelId") or embed.DEFAULT_MODEL_ID)
    try:
        spec = embed.spec_for(model_id)
    except KeyError as exc:
        r.line(BAD, "modelId", str(exc), f"set modelId in {paths.config_path()}")
        return

    r.line(GOOD, "modelId", f"{spec.model_id} — {spec.dim}d, {spec.hf_id}")
    if(not spec.multilingual):
        r.line(WARN, "languages", "this model is English-only, so Turkish queries will not work")

    cached = weights_dir(spec.hf_id)
    if(cached is None):
        r.line(
            WARN, "weights", "not downloaded yet — the first index will fetch them (~3 GB)",
            f"cache: {hf_cache_dir()}",
        )
    else:
        r.line(GOOD, "weights", f"cached, {human(paths.dir_size_bytes(cached / "blobs"))}")


def check_ocr(r: Report, settings: dict) -> ocr.OcrEngine | None:
    """Reports OCR health and returns the engine the sidecar would actually use."""
    r.section("OCR")
    requested = ocr.canonical_langs(settings.get("ocrLangs"))
    lang_map = ocr.TesseractEngine.LANG_MAP

    binary = system.find_tesseract()
    if(binary is None):
        r.line(
            BAD, "tesseract", "not installed — screenshots will not be searchable by their text",
            system.tesseract_install_hint(),
        )
    else:
        installed = ocr.tesseract_langs(binary)
        version = version_of(binary) or "installed"
        r.line(GOOD, "tesseract", f"{version} — {len(installed)} language(s) installed")

        unknown = [code for code in requested if code not in lang_map]
        if(unknown):
            r.line(
                WARN, "langs", f"no tesseract mapping for {', '.join(unknown)}",
                "extend TesseractEngine.LANG_MAP in ocr.py",
            )
        missing = [lang_map[c] for c in requested if c in lang_map and lang_map[c] not in installed]
        if(missing):
            r.line(
                WARN, "langs", f"requested {'+'.join(missing)}, no data installed",
                system.tesseract_langs_hint(missing),
            )
            r.note("the next rescan re-reads every screenshot on its own once it is installed")

    engine = ocr.resolve(settings.get("ocrEngineId"), settings.get("ocrLangs"))
    configured = str(settings.get("ocrEngineId") or ocr.DEFAULT_ENGINE_ID)
    if(engine is None):
        r.line(BAD, "engine", "no OCR engine is available", "install tesseract, see above")
    elif(engine.id != configured):
        r.line(
            WARN, "engine", f"config says {configured!r}, falling back to {engine.id!r}"
            f" ({engine.langs_key})",
            f"pick {engine.id} in Settings, or edit ocrEngineId in {paths.config_path()}",
        )
    else:
        r.line(GOOD, "engine", f"{engine.id} — {engine.langs_key}")
    return engine


def check_config(r: Report, settings: dict) -> None:
    r.section("Config")
    path = paths.config_path()
    if(path.exists()):
        r.line(GOOD, "config.toml", str(path))
    else:
        r.line(GOOD, "config.toml", "not written yet — running on defaults")
    for key in sorted(settings):
        r.note(f"{key} = {settings[key]!r}")


def check_index(r: Report, settings: dict, engine: ocr.OcrEngine | None) -> None:
    r.section("Index")
    db = paths.db_path()
    if(not db.exists()):
        # Not an error on a fresh install, and the doctor does not create one.
        r.line(
            WARN, "index.db", "no index yet",
            "open the app and add a folder in Settings",
        )
        return

    store = Store(db)
    try:
        conn = store.conn()
        images = store.image_count()
        screenshots = conn.execute(
            "SELECT COUNT(*) FROM images WHERE is_screenshot = 1"
        ).fetchone()[0]
        r.line(GOOD, "index.db", f"{human(db.stat().st_size)}, {images} images, "
               f"{screenshots} screenshots")

        model_id = str(settings.get("modelId") or embed.DEFAULT_MODEL_ID)
        vectors = store.embedding_count(model_id)
        if(images and vectors < images):
            r.line(
                WARN, "vectors", f"{vectors}/{images} for {model_id} — {images - vectors} "
                "images are not searchable yet",
                "rescan; indexing resumes where it stopped",
            )
        else:
            r.line(GOOD, "vectors", f"{vectors} for {model_id}")

        with_text = len(store.ocr_ids())
        rows = conn.execute("SELECT COUNT(*) FROM ocr_text").fetchone()[0]
        if(engine is None):
            r.line(WARN, "ocr", f"{with_text} images with text, engine unavailable")
        else:
            pending = len(store.images_missing_ocr(engine.id, engine.langs_key))
            detail = f"{with_text} with text, {rows - with_text} read but blank"
            if(pending):
                r.line(WARN, "ocr", f"{detail}, {pending} not read with {engine.langs_key} yet",
                       "rescan, or wait for the background backfill")
            else:
                r.line(GOOD, "ocr", detail)

        folders = store.list_folders()
        if(not folders):
            r.line(
                BAD, "folders", "none watched — the grid will be empty no matter what",
                "add one in Settings, or POST /folders",
            )
        for row in folders:
            folder = Path(str(row["path"])).expanduser()
            count = store.folder_count(str(row["path"]))
            scope = "recursive" if row["recursive"] else "top level"
            if(folder.is_dir()):
                r.line(GOOD, "folder", f"{folder} — {count} images, {scope}")
            else:
                r.line(
                    WARN, "folder", f"{folder} — gone from disk, still holding {count} rows",
                    "remove it in Settings",
                )
    finally:
        store.close()


def check_storage(r: Report) -> None:
    r.section("Storage")
    data = paths.data_dir()
    thumbs = paths.thumbs_dir()
    r.line(GOOD, "data", f"{data}, thumbnails {human(paths.dir_size_bytes(thumbs))}")
    usage = shutil.disk_usage(data)
    level = WARN if usage.free < 5 * 1024**3 else GOOD
    r.line(level, "free space", f"{human(usage.free)} on {data.anchor or '/'}")


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def run(color: bool = True) -> int:
    # `ocr.resolve()` logs its own fallback warnings, which would interleave
    # with the report that exists to state them properly. Report wins.
    logging.getLogger("picsearch").setLevel(logging.ERROR)

    r = Report(color=color)
    settings = config.load()

    check_toolchain(r)
    check_gpu(r)
    check_model(r, settings)
    engine = check_ocr(r, settings)
    check_config(r, settings)
    check_index(r, settings, engine)
    check_storage(r)
    return r.summary()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="picsearch.doctor",
        description="Check that everything the sidecar needs is present. Read only.",
    )
    parser.add_argument("--no-color", action="store_true", help="plain output")
    args = parser.parse_args(argv)
    color = not args.no_color and sys.stdout.isatty() and not os.environ.get("NO_COLOR")
    return run(color=color)


if(__name__ == "__main__"):
    raise SystemExit(main())
