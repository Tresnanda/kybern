#!/usr/bin/env bash
# Package Kybern GPUIX (apps/gpuix) for Linux and sign its updater artifact:
# dist/kybern-gpuix_<version>_<arch>.AppImage plus its minisign .sig (what
# latest.json's linux-<arch>-gpuix entry points at, signed with the updater key), and the .deb and .rpm beside it (arch x86_64, or
# aarch64 for local container checks).
#
# Usage: scripts/bundle-gpuix-linux.sh
#   KYBERN_GPUIX_TARGET         x86_64-unknown-linux-gnu (default on x86_64) or
#                               aarch64-unknown-linux-gnu (local checks; no release lane)
#   KYBERN_BIN_DIR              the folder holding that arch's kybernd and kybern
#                               (releases pass dist's static musl binaries); defaults
#                               to $CARGO_TARGET_DIR/release
#   APPIMAGETOOL, APPIMAGE_RUNTIME
#                               appimagetool and the AppImage type2-runtime for that
#                               arch (desktop.yml downloads pinned copies)
#   TAURI_SIGNING_PRIVATE_KEY   required unless SKIP_SIGN=1 (the updater key)
#
# Requires: the patched native addon for that target (apps/gpuix/native/update.sh
# with the same KYBERN_GPUIX_TARGET), bun, dpkg-deb and dpkg-shlibdeps (dpkg-dev),
# rpmbuild (rpm), desktop-file-validate (desktop-file-utils, optional) and
# `pnpm install` in apps/gpuix (mermaid and the Tauri CLI's
# updater signer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "bundle-gpuix-linux.sh must run on Linux" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) HOST=x86_64-unknown-linux-gnu ;;
  aarch64) HOST=aarch64-unknown-linux-gnu ;;
  *) HOST=unknown ;;
esac
TARGET="${KYBERN_GPUIX_TARGET:-$HOST}"
case "$TARGET" in
  x86_64-unknown-linux-gnu) ARCH=x86_64 BUN_ARCH=x64 ;;
  aarch64-unknown-linux-gnu) ARCH=aarch64 BUN_ARCH=arm64 ;;
  *) echo "unsupported GPUIX target: $TARGET" >&2; exit 1 ;;
esac
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN_DIR="$(cd "${KYBERN_BIN_DIR:-$TARGET_DIR/release}" && pwd)"
DIST="$ROOT/dist"
VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
STEM="kybern-gpuix_${VERSION}_${ARCH}"
APPIMAGE="$DIST/$STEM.AppImage"

echo "==> packaging Kybern GPUIX $VERSION for $TARGET"
rm -rf apps/gpuix/dist
(cd apps/gpuix && KYBERN_BIN_DIR="$BIN_DIR" bun scripts/package-app.ts --arch "$BUN_ARCH")

mkdir -p "$DIST"
for ext in AppImage deb rpm; do
  rm -f "$DIST/$STEM.$ext" "$DIST/$STEM.$ext.sig"
  mv "apps/gpuix/dist/$STEM.$ext" "$DIST/$STEM.$ext"
  echo "==> $DIST/$STEM.$ext"
done

if [[ "${SKIP_SIGN:-0}" == "1" ]]; then
  echo "==> SKIP_SIGN=1; leaving the AppImage unsigned"
  exit 0
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
# Only the AppImage updates itself; deb and rpm installs are announced, not replaced.
(cd apps/gpuix && node node_modules/@tauri-apps/cli/tauri.js signer sign "$APPIMAGE")
(cd apps/gpuix && bun scripts/verify-archive.ts "$APPIMAGE")
echo "done: $APPIMAGE"
