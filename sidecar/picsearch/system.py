"""Everything that differs between the operating systems the app ships on.

Kept in one module so the rest of the sidecar never branches on
`sys.platform` itself. Four things live here:

* **Is a pid alive.** `os.kill(pid, 0)` is the POSIX idiom and it is *not* one
  on Windows: there signal 0 is `CTRL_C_EVENT`, so the probe either raises an
  error nobody catches or delivers a Ctrl-C. The parent watchdog would then die
  on its first tick and the orphan it exists to prevent would come back.
* **Where tesseract is.** The UB-Mannheim installer, which is what everyone on
  Windows uses, does not put itself on PATH.
* **What to tell the user to run.** A `pacman` command is noise on Ubuntu and
  gibberish on Windows.
* **Where user fonts go and how the OS learns about them.** fontconfig on
  Linux, the HKCU registry and `AddFontResourceW` on Windows.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

WINDOWS = sys.platform == "win32"

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Process liveness
# ---------------------------------------------------------------------------

def pid_alive(pid: int) -> bool:
    if(WINDOWS):
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _pid_alive_windows(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if(not handle):
        # ERROR_ACCESS_DENIED means it exists and belongs to someone else.
        return ctypes.get_last_error() == 5
    try:
        # A process handle is signalled once the process has exited.
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def start_parent_watchdog(parent_pid: int | None = None, interval: float = 1.0) -> None:
    """Exit hard when the process we belong to disappears.

    Rust also kills the child on window-destroy and on panic, but the happy
    path alone is not enough: this is what survives `pkill -9` on Tauri, and an
    orphan holding VRAM is the failure this whole design guards against.

    `--parent-pid` exists because Tauri spawns us through `uv`, so our direct
    parent is not the process whose death matters. Watching *liveness of a pid*
    rather than comparing `getppid()` is what makes that case work — an earlier
    version compared ppid and killed the sidecar the instant it started, since
    `uv`'s pid never equals Tauri's.
    """
    target = parent_pid if parent_pid is not None else os.getppid()
    # Reparenting is only meaningful when we are watching our own parent.
    watch_reparent = parent_pid is None

    def watch() -> None:
        while(True):
            time.sleep(interval)
            if(not pid_alive(target)):
                log.warning("watched process %s is gone; exiting", target)
                os._exit(0)
            if(watch_reparent and os.getppid() != target):
                log.warning("reparented away from %s; exiting", target)
                os._exit(0)

    threading.Thread(target=watch, name="picsearch-parent-watchdog", daemon=True).start()


# ---------------------------------------------------------------------------
# Trash
# ---------------------------------------------------------------------------

def trash_backend():
    """send2trash's function, or an error when it could delete for good.

    Without pywin32 send2trash silently falls back to the old SHFileOperation
    call on Windows, which deletes permanently whenever the Recycle Bin cannot
    take the file. The modern one (IFileOperation, pywin32) fails instead. So a
    Windows install that lost pywin32 refuses to delete rather than lose files.
    """
    from send2trash import send2trash

    if(WINDOWS and send2trash.__module__ != "send2trash.win.modern"):
        raise RuntimeError(
            "the Recycle Bin API (pywin32) is not installed, so a delete could skip the bin; "
            "nothing was deleted"
        )
    return send2trash


def move_to_trash(path: Path) -> None:
    """Move one file to the OS trash. Raises when it cannot.

    The only place the sidecar deletes a user's file, and it never falls back to
    a permanent delete: a caller that gets an exception reports the file as not
    moved. One function so tests can replace it.
    """
    trash_backend()(str(path))


# ---------------------------------------------------------------------------
# File manager
# ---------------------------------------------------------------------------

def _spawn(argv: list[str] | str) -> bool:
    try:
        subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError as exc:
        log.warning("failed to spawn %s: %s", argv, exc)
        return False


def open_file(path: Path) -> bool:
    """Open a file in its default app."""
    if(WINDOWS):
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]  # Windows only
            return True
        except OSError as exc:
            log.warning("failed to open %s: %s", path, exc)
            return False
    return _spawn(["xdg-open", str(path)])


def reveal_files(files: list[Path]) -> int:
    """Show files in the file manager with them selected. Returns windows opened.

    Linux asks the file manager over D-Bus (`FileManager1.ShowItems`), which
    Dolphin, Nautilus, Nemo and Thunar all answer: one call, every file
    highlighted, one window per folder. Without that service it falls back to
    opening the folders, unselected. Windows Explorer selects one file per
    window, so it gets the first file of each folder.
    """
    by_dir: dict[Path, list[Path]] = {}
    for f in files:
        by_dir.setdefault(f.parent, []).append(f)
    if(WINDOWS):
        # One string, not a list: explorer parses its own command line and
        # does not understand the quoting `subprocess.list2cmdline` produces.
        return sum(_spawn(f'explorer /select,"{group[0]}"') for group in by_dir.values())
    gdbus = shutil.which("gdbus")
    if(gdbus is not None and files):
        # as_uri percent-encodes quotes and commas, so no name can break the literal.
        uris = "[" + ", ".join(f"'{f.as_uri()}'" for f in files) + "]"
        try:
            done = subprocess.run(
                [gdbus, "call", "--session", "--dest", "org.freedesktop.FileManager1",
                 "--object-path", "/org/freedesktop/FileManager1",
                 "--method", "org.freedesktop.FileManager1.ShowItems", uris, ""],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
            if(done.returncode == 0):
                return len(by_dir)
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("FileManager1.ShowItems failed: %s", exc)
    return sum(_spawn(["xdg-open", str(d)]) for d in by_dir)


# ---------------------------------------------------------------------------
# Tesseract
# ---------------------------------------------------------------------------

def _windows_tesseract_candidates() -> list[Path]:
    roots = [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]
    local = os.environ.get("LOCALAPPDATA")
    if(local):
        roots.append(os.path.join(local, "Programs"))
    return [Path(root) / "Tesseract-OCR" / "tesseract.exe" for root in roots if root]


def find_tesseract(binary: str = "tesseract") -> str | None:
    """PATH first, then the places the Windows installers use."""
    found = shutil.which(binary)
    if(found is not None or not WINDOWS or binary != "tesseract"):
        return found
    for candidate in _windows_tesseract_candidates():
        if(candidate.is_file()):
            return str(candidate)
    return None


def _linux_family() -> str:
    """'arch', 'debian', 'fedora' or '' — read from os-release, never guessed."""
    try:
        text = Path("/etc/os-release").read_text()
    except OSError:
        return ""
    ids: list[str] = []
    for line in text.splitlines():
        key, _, value = line.partition("=")
        if(key in ("ID", "ID_LIKE")):
            ids.extend(value.strip().strip('"').split())
    for family in ("arch", "debian", "ubuntu", "fedora"):
        if(family in ids):
            return "debian" if family == "ubuntu" else family
    return ""


def tesseract_install_hint(langs: list[str] | None = None) -> str:
    """The command that installs tesseract plus `langs` (639-2 codes) here."""
    langs = langs or ["eng"]
    if(WINDOWS):
        # The UB-Mannheim installer offers every language as a checkbox.
        return "winget install UB-Mannheim.TesseractOCR (tick your languages in the installer)"
    if(sys.platform == "darwin"):
        return "brew install tesseract tesseract-lang"
    family = _linux_family()
    if(family == "arch"):
        return "sudo pacman -S tesseract " + " ".join("tesseract-data-" + c for c in langs)
    if(family == "debian"):
        return "sudo apt install tesseract-ocr " + " ".join("tesseract-ocr-" + c for c in langs)
    if(family == "fedora"):
        return "sudo dnf install tesseract " + " ".join("tesseract-langpack-" + c for c in langs)
    return "install tesseract and its " + "+".join(langs) + " language data"


def tesseract_langs_hint(langs: list[str]) -> str:
    """The command that adds language data to an existing install."""
    if(WINDOWS):
        return "re-run the Tesseract installer and tick " + ", ".join(langs)
    if(sys.platform == "darwin"):
        return "brew install tesseract-lang"
    family = _linux_family()
    if(family == "arch"):
        return "sudo pacman -S " + " ".join("tesseract-data-" + c for c in langs)
    if(family == "debian"):
        return "sudo apt install " + " ".join("tesseract-ocr-" + c for c in langs)
    if(family == "fedora"):
        return "sudo dnf install " + " ".join("tesseract-langpack-" + c for c in langs)
    return "install the tesseract " + "+".join(langs) + " language data"


# ---------------------------------------------------------------------------
# User fonts
# ---------------------------------------------------------------------------

def user_fonts_dir() -> Path:
    """Where the app puts fonts it installs. No admin rights on either OS.

    Linux gets its own subfolder, so nothing outside it is ever ours. Windows
    has one per-user Fonts folder shared with its own "Install for me"; there
    `fonts.py` prefixes every file instead.
    """
    override = os.environ.get("PICSEARCH_FONTS_DIR")
    if(override):
        return Path(override)
    if(WINDOWS):
        return Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts"
    data = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(data) / "fonts" / "picsearch"


# HKCU, not HKLM: a per-user install needs no admin and is what Windows itself
# writes for "Install for me".
_FONTS_KEY = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"


def register_fonts(files: list[Path]) -> None:
    """Tell the OS about font files just written into `user_fonts_dir()`."""
    if(WINDOWS):
        _windows_fonts(files, add=True)
        return
    _fc_cache()


def unregister_fonts(files: list[Path]) -> None:
    """The reverse of `register_fonts`, called *before* the files are deleted:
    Windows will not let go of a file that is still loaded."""
    if(WINDOWS):
        _windows_fonts(files, add=False)


def fonts_removed() -> None:
    if(not WINDOWS):
        _fc_cache()


def _fc_cache() -> None:
    # Skipped where missing: fontconfig rescans on its own schedule anyway, this
    # only makes the font visible to newly started apps right away.
    binary = shutil.which("fc-cache")
    if(binary is None):
        return
    try:
        subprocess.run([binary, "-f", str(user_fonts_dir())], timeout=30, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("fc-cache failed: %s", exc)


def _windows_fonts(files: list[Path], add: bool) -> None:
    import ctypes
    import winreg

    gdi32 = ctypes.windll.gdi32
    # Create, not open: a profile that never had a per-user font has no such key.
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _FONTS_KEY, 0, winreg.KEY_SET_VALUE) as key:
        for path in files:
            # The value name is display only; the file stem keeps it unique.
            name = f"{path.stem} (TrueType)"
            if(add):
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, str(path))
                gdi32.AddFontResourceW(str(path))
            else:
                gdi32.RemoveFontResourceW(str(path))
                try:
                    winreg.DeleteValue(key, name)
                except FileNotFoundError:
                    pass
    # HWND_BROADCAST, WM_FONTCHANGE, SMTO_ABORTIFHUNG: running apps re-read fonts.
    ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001D, 0, 0, 0x0002, 1000, None)
