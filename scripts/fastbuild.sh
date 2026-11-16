#!/usr/bin/env bash
# Quick rebuild + update of the installed app. No prereq checks, no npm ci,
# no tests, no release/ folder:
#
#   scripts/fastbuild.sh              # build .deb, reinstall picsearch-bin, open it
#   scripts/fastbuild.sh --no-run     # ... but do not launch afterwards
#   scripts/fastbuild.sh --no-install # build only: run src-tauri/target/release/picsearch
#
# The installed package is what the launcher entry starts, so this is the one
# that makes "build, then click PicSearch" show the new code. It is the same
# .deb -> PKGBUILD path as `npm run package` + packaging/arch, minus the checks.
# Use scripts/build-linux.sh for a checked release build.
#
# Arch only for the install step (makepkg/pacman). Asks for sudo once, at the
# pacman step.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

run=1
install=1
extra=()
for arg in "$@"; do
    case "$arg" in
        --no-run) run=0 ;;
        --no-install) install=0 ;;
        *) extra+=("$arg") ;;
    esac
done

# makepkg names the package after pkgver, so a stale one would install the new
# build under the old version.
pkgver="$(sed -n 's/^pkgver=//p' packaging/arch/PKGBUILD)"
appver="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
if (( install == 1 )) && [[ "$pkgver" != "$appver" ]]; then
    echo "packaging/arch/PKGBUILD has pkgver=$pkgver but tauri.conf.json says $appver: bump the PKGBUILD" >&2
    exit 1
fi

if [[ ! -d node_modules ]]; then
    npm install
fi

node scripts/fetch-uv.mjs
npx tauri build --bundles deb --config src-tauri/tauri.bundle.conf.json ${extra[@]+"${extra[@]}"}

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
deb="$root/src-tauri/target/release/bundle/deb/PicSearch_${version}_amd64.deb"
[[ -f "$deb" ]] || { echo "no .deb at $deb" >&2; exit 1; }

if (( install == 0 )); then
    echo "built $deb"
    echo "binary: src-tauri/target/release/picsearch"
    exit 0
fi

command -v makepkg >/dev/null || { echo "makepkg not found: install manually from $deb, or use --no-install" >&2; exit 1; }

# A running copy keeps the old binary in memory and its sidecar holds VRAM.
pkill -x picsearch 2>/dev/null || true

# -C wipes src/ first: makepkg would otherwise reuse the previous extraction of
# the .deb and reinstall the old build.
(cd packaging/arch && PICSEARCH_DEB="$deb" makepkg -fCsi --noconfirm)

echo "installed picsearch-bin $version"
if (( run == 1 )); then
    setsid -f picsearch >/dev/null 2>&1
fi
