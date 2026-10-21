#!/usr/bin/env bash
# Package Kybern GPUIX (apps/gpuix) as a macOS app and write the updater
# tarball that latest.json points at: dist/kybern-gpuix_<version>_aarch64.app.tar.gz
# plus its minisign .sig, signed with the same key as the Tauri desktop app.
#
# Usage: scripts/bundle-gpuix.sh
#   KYBERN_BIN_DIR              the folder holding kybernd and kybern (releases
#                               pass dist's binaries); defaults to $CARGO_TARGET_DIR/release
#   CARGO_TARGET_DIR            honoured if set
#   TAURI_SIGNING_PRIVATE_KEY   required unless SKIP_SIGN=1 (the updater key)
#
# Requires: the patched native addon (apps/gpuix/native/update.sh), release
# builds of kybern and kybernd, bun, and `pnpm install` in apps/desktop (mermaid
# and the Tauri signer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "bundle-gpuix.sh must run on Apple Silicon macOS" >&2
  exit 1
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN_DIR="$(cd "${KYBERN_BIN_DIR:-$TARGET_DIR/release}" && pwd)"
DIST="$ROOT/dist"
VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
TARBALL="$DIST/kybern-gpuix_${VERSION}_aarch64.app.tar.gz"

echo "==> packaging Kybern GPUIX $VERSION"
rm -rf apps/gpuix/dist
(cd apps/gpuix && KYBERN_BIN_DIR="$BIN_DIR" bun scripts/package-app.ts)
APP="$ROOT/apps/gpuix/dist/Kybern GPUIX.app"

echo "==> $TARBALL"
mkdir -p "$DIST"
rm -f "$TARBALL" "$TARBALL.sig"
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$(dirname "$APP")" "Kybern GPUIX.app"

if [[ "${SKIP_SIGN:-0}" == "1" ]]; then
  echo "==> SKIP_SIGN=1; leaving the tarball unsigned"
  exit 0
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
(cd apps/desktop && node node_modules/@tauri-apps/cli/tauri.js signer sign "$TARBALL")
(cd apps/gpuix && bun scripts/verify-archive.ts "$TARBALL")
echo "done: $TARBALL"
