#!/bin/sh
# Install the Kybern desktop app on macOS without the Gatekeeper prompt.
#
#   curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-mac-install.sh | sh
#
#   ... | sh -s -- --version 0.2.0     pin a release instead of latest
#   ... | sh -s -- --no-open            install without launching the app
#   KYBERN_APP_DIR=~/Applications ...  install somewhere other than /Applications
#
# The app is ad-hoc signed and not notarized. macOS only warns about files a
# browser downloaded (they carry a quarantine flag); this script fetches the
# same signed app archive the in-app updater uses, so nothing is flagged and
# the app opens directly. Later updates arrive through the app itself.
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
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "this installer is for macOS; see the release page for other platforms" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  MANIFEST="https://github.com/$REPO/releases/latest/download/latest.json"
  URL="$(curl -fsSL "$MANIFEST" | sed -n 's/.*"url": *"\([^"]*darwin-'"$ARCH"'[^"]*\.app\.tar\.gz\)".*/\1/p' | head -n 1)"
  [ -n "$URL" ] || { echo "no macOS $ARCH build in the latest release" >&2; exit 1; }
else
  VERSION="${VERSION#v}"
  URL="https://github.com/$REPO/releases/download/v$VERSION/kybern-$VERSION-$ARCH-apple-darwin.app.tar.gz"
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
[ -d "$TMP/kybern.app" ] || { echo "the archive did not contain kybern.app" >&2; exit 1; }

if pgrep -xq kybern; then
  echo "==> closing the running kybern"
  osascript -e 'tell application "kybern" to quit' >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$DEST/kybern.app"
mv "$TMP/kybern.app" "$DEST/kybern.app"
# Nothing here is quarantined; this only guards against a future archive that carries the flag.
xattr -dr com.apple.quarantine "$DEST/kybern.app" 2>/dev/null || true

echo "==> installed $DEST/kybern.app"
[ "$OPEN" = "1" ] && open -a "$DEST/kybern.app"
exit 0
