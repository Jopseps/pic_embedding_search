"""The startup doctor.

Most of what `doctor.py` reports is a property of the host — whether rustc is
installed, whether this machine has a GPU — so these tests cover the parts that
are ours: the exit code contract, the read-only promise, and the checks that
read the index.

The read-only test is the one that matters. A diagnostic that creates the very
index it is reporting on would tell every fresh clone that it has an empty
library rather than no library, which is the opposite of the point.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from picsearch import doctor, paths
from picsearch.doctor import BAD, GOOD, WARN, Report, human, weights_dir
from picsearch.store import Store


def add_image(store: Store, path: str, *, screenshot: bool = False) -> int:
    return store.upsert_image(
        path=path, mtime=1.0, size_bytes=10, width=1920, height=1080,
        mime="image/png", phash=0, sha256=path, taken_at=None, is_screenshot=screenshot,
    )


# -- report bookkeeping -----------------------------------------------------

def test_only_bad_lines_fail_the_run(capsys):
    r = Report(color=False)
    r.line(GOOD, "fine")
    r.line(WARN, "iffy")
    assert r.summary() == 0
    assert r.warn == 1


def test_a_broken_check_exits_nonzero(capsys):
    r = Report(color=False)
    r.line(BAD, "broken", "detail", "the fix")
    assert r.summary() == 1
    assert "the fix" in capsys.readouterr().out


def test_notes_never_count(capsys):
    r = Report(color=False)
    r.note("context, not a verdict")
    assert r.summary() == 0


# -- helpers ----------------------------------------------------------------

def test_human_sizes():
    assert human(512) == "512 B"
    assert human(2 * 1024**3) == "2.0 GB"


def test_an_interrupted_download_does_not_read_as_cached(tmp_path, monkeypatch):
    # huggingface_hub creates the repo dir before it fetches anything. Treating
    # that as a hit would report "cached" for weights that are not there.
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    repo = tmp_path / "models--google--siglip2-base-patch16-224"
    (repo / "snapshots" / "abc123").mkdir(parents=True)
    assert weights_dir("google/siglip2-base-patch16-224") is None

    (repo / "snapshots" / "abc123" / "model.safetensors").write_bytes(b"x")
    assert weights_dir("google/siglip2-base-patch16-224") == repo


def test_weights_dir_is_none_when_nothing_was_ever_downloaded(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    assert weights_dir("google/siglip2-so400m-patch14-384") is None


# -- read only --------------------------------------------------------------

def test_it_does_not_create_an_index(xdg_tmp, capsys):
    doctor.check_index(Report(color=False), {"modelId": "siglip2-base-patch16-224"}, None)
    assert not paths.db_path().exists()
    assert "no index yet" in capsys.readouterr().out


def test_a_full_run_leaves_no_database_behind(xdg_tmp):
    doctor.run(color=False)
    assert not paths.db_path().exists()


def test_a_full_run_does_not_write_config(xdg_tmp):
    doctor.run(color=False)
    assert not paths.config_path().exists()


# -- index checks -----------------------------------------------------------

def test_no_watched_folders_is_a_failure(xdg_tmp, store, capsys):
    add_image(store, "/photos/a.jpg")
    r = Report(color=False)
    doctor.check_index(r, {"modelId": "siglip2-base-patch16-224"}, None)
    # An empty grid with no folders configured is the single most common
    # "nothing works" report, and it is not a warning — nothing can work.
    assert r.bad == 1
    assert "none watched" in capsys.readouterr().out


def test_a_folder_that_left_the_disk_is_reported(xdg_tmp, store, capsys):
    store.add_folder("/nowhere/at/all")
    r = Report(color=False)
    doctor.check_index(r, {}, None)
    out = capsys.readouterr().out
    assert "gone from disk" in out


def test_images_without_vectors_are_reported(xdg_tmp, store, capsys):
    store.add_folder(str(Path.home()))
    for i in range(3):
        add_image(store, f"/photos/{i}.jpg")
    r = Report(color=False)
    doctor.check_index(r, {"modelId": "siglip2-base-patch16-224"}, None)
    assert "0/3" in capsys.readouterr().out
    assert r.warn >= 1


class FakeEngine:
    id = "tesseract"
    langs_key = "eng"


def test_screenshots_awaiting_ocr_are_reported(xdg_tmp, store, capsys):
    store.add_folder(str(Path.home()))
    add_image(store, "/shots/a.png", screenshot=True)
    read = add_image(store, "/shots/b.png", screenshot=True)
    store.put_ocr(read, "tesseract", "eng", "build failed")
    r = Report(color=False)
    doctor.check_index(r, {}, FakeEngine())
    out = capsys.readouterr().out
    assert "1 with text" in out
    assert "1 not read with eng yet" in out


def test_a_blank_ocr_row_reads_as_read_not_pending(xdg_tmp, store, capsys):
    store.add_folder(str(Path.home()))
    image_id = add_image(store, "/shots/blank.png", screenshot=True)
    # The empty-string marker means "OCR ran, found nothing" — it must not show
    # up as work still to do, or the doctor reports a backlog that never drains.
    store.put_ocr(image_id, "tesseract", "eng", "")
    r = Report(color=False)
    doctor.check_index(r, {}, FakeEngine())
    out = capsys.readouterr().out
    assert "0 with text, 1 read but blank" in out
    assert "not read" not in out


# -- OCR ---------------------------------------------------------------------

def test_an_engine_that_falls_back_is_a_warning(xdg_tmp, monkeypatch, capsys):
    monkeypatch.setattr(doctor.ocr, "resolve", lambda engine_id, langs: FakeEngine())
    r = Report(color=False)
    engine = doctor.check_ocr(r, {"ocrEngineId": "rapidocr", "ocrLangs": ["en"]})
    assert engine is not None and engine.id == "tesseract"
    assert "falling back" in capsys.readouterr().out
    assert r.warn >= 1


def test_no_engine_at_all_is_a_failure(xdg_tmp, monkeypatch):
    monkeypatch.setattr(doctor.ocr, "resolve", lambda engine_id, langs: None)
    r = Report(color=False)
    assert doctor.check_ocr(r, {"ocrEngineId": "tesseract"}) is None
    assert r.bad >= 1


# -- smoke -------------------------------------------------------------------

@pytest.mark.parametrize("color", [True, False])
def test_a_full_run_returns_an_exit_code(xdg_tmp, color, capsys):
    assert doctor.run(color=color) in (0, 1)
    out = capsys.readouterr().out
    for section in ("Toolchain", "GPU", "Model", "OCR", "Config", "Index", "Storage"):
        assert section in out
