#!/usr/bin/env bash
# One-command release build on Linux, from a fresh clone:
#
#   scripts/build-linux.sh                    # check, install, test, package, collect
#   scripts/build-linux.sh --skip-tests       # straight to packaging
#   scripts/build-linux.sh --bundles deb      # anything unrecognised goes to `tauri build`
#
# Steps: prerequisites -> npm ci -> tests -> scripts/package.mjs -> release/.
#
# The packaging itself is package.mjs, not this file: it fetches the pinned uv,
# applies the tauri.bundle.conf.json overlay and, on Arch, builds the .deb only
# (an Arch-built AppImage fails in linuxdeploy and needs a too-new glibc).
#
# Sidecar tests run in sidecar/.venv-build with CPU torch, exactly as CI does.
# Never in sidecar/.venv: syncing the cpu group there would swap out the dev
# environment's CUDA torch, and the next `tauri dev` would re-download 3 GB.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

skip_tests=0
skip_install=0
extra=()
for arg in "$@"; do
    case "$arg" in
        --skip-tests) skip_tests=1 ;;
        --skip-install) skip_install=1 ;;
        -h|--help)
            sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) extra+=("$arg") ;;
    esac
done

step(){
    printf '\n\033[1m==> %s\033[0m\n' "$1"
}

warn(){
    printf '\033[33mwarning:\033[0m %s\n' "$1"
}

die(){
    printf '\033[31merror:\033[0m %s\n' "$1" >&2
    exit 1
}

have(){
    command -v "$1" >/dev/null 2>&1
}

distro=""
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    distro="$(. /etc/os-release && echo "${ID:-} ${ID_LIKE:-}")"
fi
arch_linux=0
if [[ -f /etc/arch-release ]]; then
    arch_linux=1
fi

system_deps_hint(){
    case " $distro " in
        *" arch "*)
            echo "sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 librsvg pkgconf"
            ;;
        *" debian "*|*" ubuntu "*)
            echo "sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf"
            ;;
        *" fedora "*|*" rhel "*)
            echo "sudo dnf install webkit2gtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel patchelf && sudo dnf group install c-development"
            ;;
        *)
            echo "install the WebKitGTK 4.1, GTK 3 and librsvg development packages (see https://v2.tauri.app/start/prerequisites/)"
            ;;
    esac
}

tesseract_hint(){
    case " $distro " in
        *" arch "*) echo "sudo pacman -S tesseract tesseract-data-eng tesseract-data-tur" ;;
        *" debian "*|*" ubuntu "*) echo "sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur" ;;
        *" fedora "*|*" rhel "*) echo "sudo dnf install tesseract tesseract-langpack-tur" ;;
        *) echo "install tesseract with English and Turkish language data" ;;
    esac
}

# -- prerequisites ------------------------------------------------------------

step "Checking prerequisites"
missing=()

if have node; then
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( node_major < 22 )); then
        missing+=("Node 22+ (found $(node -v)) - https://nodejs.org or your version manager")
    fi
else
    missing+=("Node 22+ - https://nodejs.org or your version manager")
fi
if ! have npm; then
    missing+=("npm - ships with Node")
fi
if ! have cargo || ! have rustc; then
    missing+=("Rust stable - curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh")
fi
if ! have uv; then
    missing+=("uv - curl -LsSf https://astral.sh/uv/install.sh | sh")
fi
if ! have pkg-config; then
    missing+=("pkg-config and the WebKitGTK headers - $(system_deps_hint)")
elif ! pkg-config --exists webkit2gtk-4.1 gtk+-3.0 librsvg-2.0; then
    missing+=("WebKitGTK 4.1 / GTK 3 / librsvg headers - $(system_deps_hint)")
fi
# Only the AppImage needs patchelf, and Arch never builds one.
if (( arch_linux == 0 )) && ! have patchelf; then
    missing+=("patchelf (for the AppImage) - $(system_deps_hint)")
fi

if (( ${#missing[@]} > 0 )); then
    printf '\033[31mmissing:\033[0m\n' >&2
    for m in "${missing[@]}"; do
        printf '  - %s\n' "$m" >&2
    done
    exit 1
fi

if ! have tesseract; then
    warn "tesseract not found; the OCR tests will skip. $(tesseract_hint)"
fi
echo "node $(node -v), $(rustc --version), $(uv --version)"

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
echo "building PicSearch $version"

# -- dependencies ---------------------------------------------------------------

if (( skip_install == 0 )); then
    step "Installing npm dependencies"
    npm ci
elif [[ ! -d node_modules ]]; then
    die "--skip-install given but node_modules/ does not exist"
fi

# -- tests ----------------------------------------------------------------------

if (( skip_tests == 0 )); then
    step "Frontend: typecheck + vitest"
    npm run typecheck
    npm test

    step "Sidecar: ruff + pytest (CPU torch, sidecar/.venv-build)"
    (
        cd sidecar
        export UV_PROJECT_ENVIRONMENT="$root/sidecar/.venv-build"
        export UV_NO_SYNC=1
        uv sync --frozen --no-default-groups --group dev --group cpu
        uv run --no-sync ruff check .
        uv run --no-sync pytest -q
    )
fi

# -- package --------------------------------------------------------------------

step "Packaging"
stamp="$(mktemp)"
trap 'rm -f "$stamp"' EXIT
node scripts/package.mjs ${extra[@]+"${extra[@]}"}

# -- collect --------------------------------------------------------------------

step "Collecting into release/"
bundle="src-tauri/target/release/bundle"
rm -rf release
mkdir -p release
# Built this run and for this version only: bundle/ keeps every earlier build,
# and on Arch an old appimage/ directory from somewhere else would ship stale.
while IFS= read -r -d '' file; do
    cp -- "$file" release/
done < <(find "$bundle" -maxdepth 2 -type f -newer "$stamp" -name "*_${version}_*" \
    \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) -print0 2>/dev/null)

shopt -s nullglob
built=(release/*)
shopt -u nullglob
if (( ${#built[@]} == 0 )); then
    die "tauri build finished but no bundle for $version was written under $bundle"
fi
(
    cd release
    sha256sum -- * > SHA256SUMS
)

echo
ls -lh release
if (( arch_linux == 1 )); then
    deb=("$root"/release/*.deb)
    echo
    echo "Arch: install it with"
    echo "  cd packaging/arch && PICSEARCH_DEB=${deb[0]} makepkg -si"
fi
