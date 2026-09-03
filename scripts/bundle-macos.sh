#!/usr/bin/env bash
# Build the desktop app with its bundled kybernd sidecar, sign the app ad hoc,
# and write a DMG.
#
# Usage: scripts/bundle-macos.sh
#   SKIP_BUILD=1      reuse the last self-contained `pnpm tauri build`
#   CARGO_TARGET_DIR  honoured if set
#
# Requires: cargo, node 22, pnpm, codesign, hdiutil (Xcode CLT).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bundle-macos.sh must run on macOS" >&2
  exit 1
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
DIST="$ROOT/dist"
VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) ARCH="$(uname -m)" ;;
esac
DMG="$DIST/kybern-$VERSION-$ARCH-apple-darwin.dmg"
BUNDLE_DIR="$TARGET_DIR/release/bundle/macos"

# 1. Build ---------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> pnpm tauri build with kybernd sidecar (apps/desktop)"
  (cd apps/desktop && pnpm install --frozen-lockfile && CARGO_TARGET_DIR="$TARGET_DIR" pnpm tauri build --bundles app)
fi
SRC_APP="$(ls -d "$BUNDLE_DIR"/*.app 2>/dev/null | head -n1 || true)"
if [[ -z "$SRC_APP" ]]; then
  echo "no .app under $BUNDLE_DIR; run pnpm tauri build first" >&2
  exit 1
fi
if [[ ! -x "$SRC_APP/Contents/MacOS/kybernd" ]]; then
  echo "Tauri app does not contain the kybernd sidecar" >&2
  exit 1
fi

# 2. Assemble ----------------------------------------------------------------------
APP="$DIST/kybern.app"
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$DIST"
cp -R "$SRC_APP" "$APP"

# 3. Sign (ad hoc) --------------------------------------------------------------------
echo "==> codesign (ad hoc)"
codesign --force --deep --sign - "$APP"

# 4. DMG -----------------------------------------------------------------------------
echo "==> $DMG"
rm -f "$DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/kybern.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "kybern" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "done: $DMG"
