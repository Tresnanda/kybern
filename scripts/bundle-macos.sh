#!/usr/bin/env bash
# Build kybern-app + kybernd in release and assemble dist/kybern.app plus a DMG.
#
# Usage: scripts/bundle-macos.sh
#   SKIP_BUILD=1      reuse target/release binaries instead of running cargo
#   CARGO_TARGET_DIR  honoured if set
#
# Requires: cargo, iconutil, codesign, hdiutil (all ship with macOS + Xcode CLT)
# and one SVG rasterizer: rsvg-convert (brew install librsvg), sips, or qlmanage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bundle-macos.sh must run on macOS" >&2
  exit 1
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
DIST="$ROOT/dist"
APP="$DIST/kybern.app"
BUILD="$DIST/.build"
VERSION="$(grep -m1 '^version' "$ROOT/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) ARCH="$(uname -m)" ;;
esac
DMG="$DIST/kybern-$VERSION-$ARCH-apple-darwin.dmg"

# 1. Build ---------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> cargo build --release -p kybern-app -p kybern-daemon"
  cargo build --release -p kybern-app -p kybern-daemon
fi
for bin in kybern-app kybernd; do
  if [[ ! -x "$TARGET_DIR/release/$bin" ]]; then
    echo "missing $TARGET_DIR/release/$bin" >&2
    exit 1
  fi
done

# 2. Assemble the bundle ---------------------------------------------------------
echo "==> assembling $APP"
rm -rf "$APP" "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD"
cp "$TARGET_DIR/release/kybern-app" "$APP/Contents/MacOS/kybern-app"
# The app looks for kybernd next to its own executable before falling back to PATH.
cp "$TARGET_DIR/release/kybernd" "$APP/Contents/MacOS/kybernd"
chmod +x "$APP/Contents/MacOS/kybern-app" "$APP/Contents/MacOS/kybernd"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>kybern-app</string>
  <key>CFBundleIconFile</key>
  <string>kybern.icns</string>
  <key>CFBundleIdentifier</key>
  <string>dev.kybern.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>kybern</string>
  <key>CFBundleDisplayName</key>
  <string>kybern</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# 3. Icon ------------------------------------------------------------------------
# Rasterize assets/icon.svg into an .iconset and pack it with iconutil.
ICONSET="$BUILD/kybern.iconset"
mkdir -p "$ICONSET"
SVG="$ROOT/assets/icon.svg"

rasterize() { # rasterize <size> <out.png>
  local size="$1" out="$2"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$SVG" -o "$out"
  elif sips -s format png -z "$size" "$size" "$SVG" --out "$out" >/dev/null 2>&1; then
    :
  elif command -v qlmanage >/dev/null 2>&1; then
    local tmp; tmp="$(mktemp -d)"
    qlmanage -t -s "$size" -o "$tmp" "$SVG" >/dev/null 2>&1
    mv "$tmp/icon.svg.png" "$out"
    rm -rf "$tmp"
  else
    echo "no SVG rasterizer found; install librsvg (brew install librsvg)" >&2
    exit 1
  fi
}

echo "==> rendering icon"
for size in 16 32 128 256 512; do
  rasterize "$size" "$ICONSET/icon_${size}x${size}.png"
  rasterize "$((size * 2))" "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/kybern.icns"

# 4. Sign (ad hoc; no Developer ID, no notarization) -----------------------------
echo "==> codesign (ad hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 5. DMG -------------------------------------------------------------------------
echo "==> creating $DMG"
STAGE="$BUILD/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "kybern" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"

rm -rf "$BUILD"
echo "==> done"
echo "    $APP"
echo "    $DMG"
