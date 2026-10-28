#!/usr/bin/env bash
# Package Kybern GPUIX (apps/gpuix) as a Windows x64 per-user installer and sign
# it for the updater: dist/kybern-gpuix_<version>_x64-setup.exe plus its minisign
# .sig, signed with the updater key. Runs in Git Bash on a
# Windows host (the CI job is `gpuix-windows` in desktop.yml).
#
# Usage: scripts/bundle-gpuix-windows.sh
#   KYBERN_BIN_DIR             the folder holding kybernd.exe and kybern.exe (releases
#                              pass dist's binaries); defaults to $CARGO_TARGET_DIR/release
#   CARGO_TARGET_DIR           honoured if set
#   TAURI_SIGNING_PRIVATE_KEY  required unless SKIP_SIGN=1 (the updater key)
#
# Requires: the patched native addon (apps/gpuix/native/update.sh on Windows with
# KYBERN_GPUIX_TARGET=x86_64-pc-windows-msvc), release builds of kybernd and kybern,
# bun, NSIS (`makensis` on PATH), Visual Studio's C++ redistributable folder, and
# `pnpm install` in apps/gpuix (the Tauri CLI's updater signer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) echo "bundle-gpuix-windows.sh must run in Git Bash on Windows" >&2; exit 1 ;;
esac

# Bun and Node are native Windows programs: hand them C:/… paths, not /c/… ones.
winpath() { (cd "$1" && pwd -W); }
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN_DIR="$(winpath "${KYBERN_BIN_DIR:-$TARGET_DIR/release}")"
DIST="$ROOT/dist"
VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
NAME="kybern-gpuix_${VERSION}_x64-setup.exe"

echo "==> packaging Kybern GPUIX $VERSION for x86_64-pc-windows-msvc"
rm -rf apps/gpuix/dist/windows
(cd apps/gpuix && KYBERN_BIN_DIR="$BIN_DIR" bun scripts/package-app.ts --windows)

echo "==> $DIST/$NAME"
mkdir -p "$DIST"
rm -f "$DIST/$NAME" "$DIST/$NAME.sig"
cp "apps/gpuix/dist/windows/$NAME" "$DIST/$NAME"

if [[ "${SKIP_SIGN:-0}" == "1" ]]; then
  echo "==> SKIP_SIGN=1; leaving the installer unsigned"
  exit 0
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
SIGN_FILE="$(winpath "$DIST")/$NAME"
(cd apps/gpuix && node node_modules/@tauri-apps/cli/tauri.js signer sign "$SIGN_FILE")
(cd apps/gpuix && bun scripts/verify-archive.ts "$SIGN_FILE")
echo "done: $DIST/$NAME"
