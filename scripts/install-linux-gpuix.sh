#!/bin/sh
# Install Kybern GPUIX (the GPUI desktop client, beta on Linux) on x86_64 Linux
# next to the Tauri app.
#
#   curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-linux-install.sh | sh
#
#   ... | sh -s -- --appimage           the AppImage in ~/Applications, no root needed; it updates itself
#   ... | sh -s -- --deb | --rpm        force a package format
#   ... | sh -s -- --version 0.16.0     pin a release instead of latest
#   ... | sh -s -- --no-open            install without launching the app
#
# By default this installs the package for this distribution: the .deb with apt
# (Debian, Ubuntu and derivatives) or the .rpm with dnf or zypper (Fedora, RHEL,
# openSUSE), which asks for your password through sudo. Packages are updated by
# rerunning this script (the app announces new releases and shows the command).
# Anywhere else, or with --appimage, it installs the AppImage, which replaces
# itself when you choose Update in the app. Rerun the script to upgrade either.
set -eu

REPO="${KYBERN_REPO:-Tresnanda/kybern}"
VERSION="${KYBERN_VERSION:-latest}"
FORMAT=auto
OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --appimage) FORMAT=AppImage ;;
    --deb) FORMAT=deb ;;
    --rpm) FORMAT=rpm ;;
    --version) VERSION="$2"; shift ;;
    --version=*) VERSION="${1#--version=}" ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || { echo "this installer is for Linux; on macOS use kybern-gpuix-mac-install.sh" >&2; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "Kybern GPUIX for Linux is built for x86_64 only" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

if [ "$FORMAT" = auto ]; then
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then FORMAT=deb
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then FORMAT=rpm
  else FORMAT=AppImage
  fi
fi
if [ "$FORMAT" != AppImage ] && [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then
  echo "installing the $FORMAT needs root and sudo is missing; rerun as root or with --appimage" >&2
  exit 1
fi
SUDO=
[ "$(id -u)" = 0 ] || SUDO=sudo

if [ "$VERSION" = "latest" ]; then
  # Newest release that already carries this build. A release that is still
  # being published is skipped instead of failing the install.
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" \
    | grep -o "\"browser_download_url\": *\"[^\"]*/kybern-gpuix_[^\"/]*_x86_64\\.$FORMAT\"" \
    | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$URL" ] || { echo "no published Kybern GPUIX $FORMAT for Linux found for $REPO" >&2; exit 1; }
else
  VERSION="${VERSION#v}"
  URL="https://github.com/$REPO/releases/download/v$VERSION/kybern-gpuix_${VERSION}_x86_64.$FORMAT"
fi
FILE="$(basename "$URL")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> downloading $FILE"
curl -fL --progress-bar -o "$TMP/$FILE" "$URL"

case "$FORMAT" in
  deb)
    # apt reads the file as its unprivileged _apt user; a private mktemp folder would only earn a warning.
    chmod 755 "$TMP"; chmod 644 "$TMP/$FILE"
    $SUDO apt-get install -y "$TMP/$FILE"
    APP=/usr/bin/kybern-gpuix ;;
  rpm)
    if command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y "$TMP/$FILE"
    else $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/$FILE"
    fi
    APP=/usr/bin/kybern-gpuix ;;
  AppImage)
    DEST="${KYBERN_APP_DIR:-$HOME/Applications}"
    mkdir -p "$DEST"
    APP="$DEST/Kybern-GPUIX-x86_64.AppImage"
    chmod 755 "$TMP/$FILE"
    # Renamed over the old copy, so a running Kybern GPUIX keeps its mounted image.
    mv -f "$TMP/$FILE" "$APP"
    # A menu entry and icon, like the deb and rpm install, pointing at this file.
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
    mkdir -p "$DATA/applications" "$DATA/icons/hicolor/256x256/apps"
    (cd "$TMP" && "$APP" --appimage-extract dev.kybern.gpuix.png >/dev/null 2>&1) \
      && cp -L "$TMP/squashfs-root/dev.kybern.gpuix.png" "$DATA/icons/hicolor/256x256/apps/dev.kybern.gpuix.png" || true
    cat > "$DATA/applications/dev.kybern.gpuix.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kybern GPUIX
GenericName=Coding agent workspace
Comment=Run and review coding agents (native client, beta)
Exec="$APP"
Icon=dev.kybern.gpuix
Terminal=false
Categories=Development;
StartupWMClass=dev.kybern.gpuix
DESKTOP
    if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
      echo "==> FUSE is missing, which AppImages need to run: install fuse3 (sudo apt install fuse3, sudo dnf install fuse3)"
    fi ;;
esac

echo "==> installed $APP"
if [ "$OPEN" = "1" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup "$APP" >/dev/null 2>&1 &
fi
exit 0
