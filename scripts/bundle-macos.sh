#!/usr/bin/env bash
# Build the desktop app with its bundled kybernd sidecar, sign the app ad hoc,
# and write a DMG.
#
# Usage: scripts/bundle-macos.sh
#   SKIP_BUILD=1                reuse the last self-contained `pnpm tauri build`
#   CARGO_TARGET_DIR            honoured if set
#   TAURI_SIGNING_PRIVATE_KEY   when set, also writes the signed updater
#                               tarball (kybern-<v>-<arch>-apple-darwin.app.tar.gz
#                               + .sig) that latest.json points at
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

# 4. Updater tarball -------------------------------------------------------------------
TARBALL="$DIST/kybern-$VERSION-$ARCH-apple-darwin.app.tar.gz"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "==> $TARBALL (+ .sig)"
  rm -f "$TARBALL" "$TARBALL.sig"
  (cd "$DIST" && COPYFILE_DISABLE=1 tar -czf "$TARBALL" kybern.app)
  (cd apps/desktop && node node_modules/@tauri-apps/cli/tauri.js signer sign "$TARBALL")
else
  echo "==> TAURI_SIGNING_PRIVATE_KEY is unset; skipping the updater tarball"
fi

# 5. DMG -----------------------------------------------------------------------------
echo "==> $DMG"
rm -f "$DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/kybern.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/If macOS blocks kybern.txt" <<'NOTE'
kybern is not notarized by Apple, so macOS may block the first launch with
"Apple could not verify kybern is free of malware".

To allow it once:
  1. Click Done (not Move to Trash).
  2. Open System Settings > Privacy & Security, scroll to Security,
     and click "Open Anyway" next to "kybern was blocked to protect your Mac".
  3. Confirm with Open Anyway and your password or Touch ID.

Updates installed by the app itself are never blocked. To skip the dialog
entirely, install from the terminal instead:
  curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-mac-install.sh | sh
NOTE
hdiutil create -volname "kybern" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "done: $DMG"
