"""Everything that differs between the operating systems the app ships on.

Kept in one module so the rest of the sidecar never branches on
`sys.platform` itself. Three things live here:

* **Is a pid alive.** `os.kill(pid, 0)` is the POSIX idiom and it is *not* one
  on Windows: there signal 0 is `CTRL_C_EVENT`, so the probe either raises an
  error nobody catches or delivers a Ctrl-C. The parent watchdog would then die
  on its first tick and the orphan it exists to prevent would come back.
* **Where tesseract is.** The UB-Mannheim installer, which is what everyone on
  Windows uses, does not put itself on PATH.
* **What to tell the user to run.** A `pacman` command is noise on Ubuntu and
  gibberish on Windows.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

WINDOWS = sys.platform == "win32"


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
