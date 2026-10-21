#!/bin/sh
# Install Kybern GPUIX (the GPUI desktop client) on macOS next to the Tauri app.
#
#   curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh
#
#   ... | sh -s -- --version 0.10.0    pin a release instead of latest
#   ... | sh -s -- --no-open            install without launching the app
#   KYBERN_APP_DIR=~/Applications ...  install somewhere other than /Applications
#
# Kybern GPUIX ships for Apple Silicon (aarch64) and Intel (x86_64) Macs, ad-hoc
# signed and not notarized. This script picks this Mac's build and fetches the
# same signed archive the in-app updater uses, so nothing is quarantined and the
# app opens directly. Later updates arrive through the app.
set -eu

REPO="${KYBERN_REPO:-Tresnanda/kybern}"
VERSION="${KYBERN_VERSION:-latest}"
DEST="${KYBERN_APP_DIR:-/Applications}"
OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift ;;
    --version=*) VERSION="${1#--version=}" ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "this installer is for macOS" >&2; exit 1; }
# A shell running under Rosetta reports x86_64 on an Apple Silicon Mac; install the native build there.
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64)
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH=aarch64; else ARCH=x86_64; fi ;;
  *) echo "Kybern GPUIX needs an Apple Silicon or Intel Mac" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

if [ "$VERSION" = "latest" ]; then
  # Newest release that already carries the GPUIX archive. A release that is
  # still being published is skipped instead of failing the install.
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" \
    | grep -o "\"browser_download_url\": *\"[^\"]*/kybern-gpuix_[^\"/]*_${ARCH}\\.app\\.tar\\.gz\"" \
    | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$URL" ] || { echo "no published Kybern GPUIX build for this Mac ($ARCH) found for $REPO" >&2; exit 1; }
else
  VERSION="${VERSION#v}"
  URL="https://github.com/$REPO/releases/download/v$VERSION/kybern-gpuix_${VERSION}_${ARCH}.app.tar.gz"
fi

if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  echo "==> /Applications is not writable; installing to $DEST"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> downloading $(basename "$URL")"
curl -fL --progress-bar -o "$TMP/app.tar.gz" "$URL"
tar -xzf "$TMP/app.tar.gz" -C "$TMP"
[ -d "$TMP/Kybern GPUIX.app" ] || { echo "the archive did not contain Kybern GPUIX.app" >&2; exit 1; }

if pgrep -xq "Kybern GPUIX"; then
  echo "==> closing the running Kybern GPUIX"
  osascript -e 'tell application "Kybern GPUIX" to quit' >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$DEST/Kybern GPUIX.app"
mv "$TMP/Kybern GPUIX.app" "$DEST/Kybern GPUIX.app"
# Nothing here is quarantined; this only guards against a future archive that carries the flag.
xattr -dr com.apple.quarantine "$DEST/Kybern GPUIX.app" 2>/dev/null || true

echo "==> installed $DEST/Kybern GPUIX.app"
[ "$OPEN" = "1" ] && open -a "$DEST/Kybern GPUIX.app"
exit 0
