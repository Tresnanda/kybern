#!/bin/sh
# Install Kybern GPUIX, the Kybern desktop app (beta on Linux), on x86_64 Linux.
#
#   curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-linux-install.sh | sh
#
#   ... | sh -s -- --appimage           the AppImage in ~/Applications, no root needed; it updates itself
#   ... | sh -s -- --deb | --rpm        force a package format
#   ... | sh -s -- --version 0.16.0     pin a release instead of latest
#   ... | sh -s -- --no-open            install without launching the app
#   ... | sh -s -- --uninstall          remove Kybern GPUIX (your ~/.kybern data stays)
#
# Needs glibc 2.35 or newer: Ubuntu 22.04+, Debian 12+, Fedora 36+, openSUSE
# Leap 16 or Tumbleweed and the like. RHEL, Rocky and Alma 9, Debian 11, Ubuntu
# 20.04 and openSUSE Leap 15 are older and not supported yet.
#
# By default this installs the package for this distribution: the .deb with apt
# (Debian, Ubuntu and derivatives) or the .rpm with dnf or zypper (Fedora, RHEL,
# openSUSE), which asks for your password through sudo. Packages are updated by
# rerunning this script (the app announces new releases and shows the command).
# Anywhere else, or with --appimage, it installs the AppImage, which replaces
# itself when you choose Update in the app. Rerun the script to upgrade either.
# Run it as your own user, not root: the AppImage and the menu entry belong in
# your home folder. (As root, only the package formats are available and the
# app is not launched.)
#
# The AppImage is the file the app later verifies against the release signature
# (.sig, minisign) before every self-update. This script does not verify it: it
# relies on the HTTPS download from GitHub, and has no minisign to check with.
set -eu

usage() {
  cat <<'USAGE'
Install Kybern GPUIX on x86_64 Linux (glibc 2.35 or newer).

  --appimage        the AppImage in ~/Applications (no root; it updates itself)
  --deb | --rpm     force a package format (asks for your password through sudo)
  --version X.Y.Z   pin a release instead of the latest one
  --no-open         install without launching the app
  --uninstall       remove Kybern GPUIX (your ~/.kybern data stays)
  -h, --help        show this text

Not supported yet: RHEL, Rocky and Alma 9, Debian 11, Ubuntu 20.04, openSUSE Leap 15 (glibc older than 2.35).
USAGE
}

die() { echo "$*" >&2; exit 1; }

# The major.minor of the C library, `musl` for Alpine, empty when it can't be told.
glibc_version() {
  v="$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
  if [ -z "$v" ]; then
    out="$(ldd --version 2>&1 | head -n 1 || true)"
    case "$out" in
      *musl*) echo musl; return ;;
    esac
    v="$(printf '%s\n' "$out" | sed -n 's/.*[^0-9.]\([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')"
  fi
  echo "$v"
}

check_glibc() {
  libc="$(glibc_version)"
  case "$libc" in
    musl) die "Kybern GPUIX needs glibc 2.35 or newer; this system uses musl (Alpine). Use a glibc distribution such as Ubuntu 22.04+, Debian 12+ or Fedora 36+." ;;
    "") echo "==> couldn't read the glibc version; continuing (Kybern GPUIX needs 2.35 or newer)" >&2; return ;;
  esac
  major="${libc%%.*}"
  minor="${libc#*.}"
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 35 ]; }; then
    die "Kybern GPUIX needs glibc 2.35 or newer; this system has $libc.
RHEL, Rocky and Alma 9 (2.34), Debian 11, Ubuntu 20.04 and openSUSE Leap 15 (2.31) are not supported yet.
Ubuntu 22.04+, Debian 12+, Fedora 36+ and openSUSE Leap 16 or Tumbleweed are. Nothing was installed."
  fi
}

# Delete the download in progress and the scratch folder, whatever happens.
cleanup() {
  [ -z "${PART:-}" ] || rm -f "$PART"
  [ -z "${TMP:-}" ] || rm -rf "$TMP"
}

# The newer of two package versions, by sort -V.
newer_of() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1; }

uninstall() {
  DEST="${KYBERN_APP_DIR:-$HOME/Applications}"
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  removed=0
  if command -v dpkg >/dev/null 2>&1 && dpkg -s kybern-gpuix >/dev/null 2>&1; then
    echo "==> removing the kybern-gpuix package"
    $SUDO apt-get remove -y kybern-gpuix
    removed=1
  elif command -v rpm >/dev/null 2>&1 && rpm -q kybern-gpuix >/dev/null 2>&1; then
    echo "==> removing the kybern-gpuix package"
    if command -v dnf >/dev/null 2>&1; then $SUDO dnf remove -y kybern-gpuix
    else $SUDO zypper --non-interactive remove kybern-gpuix
    fi
    removed=1
  fi
  if [ "$(id -u)" != 0 ]; then
    APP="$DEST/Kybern-GPUIX-x86_64.AppImage"
    # Only a `kybern` link that points at GPUIX's own copies; Settings → About → Terminal command made it.
    LINK="$HOME/.local/bin/kybern"
    if [ -L "$LINK" ]; then
      target="$(readlink "$LINK" 2>/dev/null || true)"
      case "$target" in
        "$DATA"/kybern-gpuix/bin/*|"$APP") rm -f "$LINK"; echo "==> removed $LINK" ;;
      esac
    fi
    for file in "$APP" "$DATA/applications/dev.kybern.gpuix.desktop" "$DATA/icons/hicolor/256x256/apps/dev.kybern.gpuix.png"; do
      if [ -e "$file" ]; then rm -f "$file"; echo "==> removed $file"; removed=1; fi
    done
    # The staged daemon and CLI copies; a daemon still running keeps its file until it exits.
    if [ -d "$DATA/kybern-gpuix" ]; then rm -rf "$DATA/kybern-gpuix"; echo "==> removed $DATA/kybern-gpuix"; removed=1; fi
  fi
  [ "$removed" = 1 ] || echo "==> nothing to remove: Kybern GPUIX is not installed"
  echo "==> your Kybern data in ~/.kybern was left alone"
}

main() {
  REPO="${KYBERN_REPO:-Tresnanda/kybern}"
  VERSION="${KYBERN_VERSION:-latest}"
  FORMAT=auto
  OPEN=1
  UNINSTALL=0
  PART=
  TMP=

  while [ $# -gt 0 ]; do
    case "$1" in
      --appimage) FORMAT=AppImage ;;
      --deb) FORMAT=deb ;;
      --rpm) FORMAT=rpm ;;
      --version) [ $# -ge 2 ] || die "--version needs a release number, for example --version 0.16.0"; VERSION="$2"; shift ;;
      --version=*) VERSION="${1#--version=}" ;;
      --no-open) OPEN=0 ;;
      --uninstall) UNINSTALL=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done

  [ "$(uname -s)" = "Linux" ] || die "this installer is for Linux; on macOS use kybern-gpuix-mac-install.sh"
  [ "$(uname -m)" = "x86_64" ] || die "Kybern GPUIX for Linux is built for x86_64 only"

  SUDO=
  [ "$(id -u)" = 0 ] || SUDO=sudo

  if [ "$UNINSTALL" = 1 ]; then
    uninstall
    return 0
  fi

  check_glibc
  command -v curl >/dev/null 2>&1 || die "curl is required"

  if [ "$FORMAT" = auto ]; then
    if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then FORMAT=deb
    elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then FORMAT=rpm
    else FORMAT=AppImage
    fi
  fi
  if [ "$FORMAT" = AppImage ] && [ "$(id -u)" = 0 ]; then
    die "run this as your own user, not root: the AppImage and its menu entry go in your home folder. For a system-wide install use --deb or --rpm."
  fi
  if [ "$FORMAT" != AppImage ] && [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then
    die "installing the $FORMAT needs root and sudo is missing; rerun as root or with --appimage"
  fi

  PINNED=0
  if [ "$VERSION" = "latest" ]; then
    # Newest release that already carries this build. A release that is still
    # being published is skipped instead of failing the install.
    URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" \
      | grep -o "\"browser_download_url\": *\"[^\"]*/kybern-gpuix_[^\"/]*_x86_64\\.$FORMAT\"" \
      | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/')"
    [ -n "$URL" ] || die "no published Kybern GPUIX $FORMAT for Linux found for $REPO"
  else
    PINNED=1
    VERSION="${VERSION#v}"
    URL="https://github.com/$REPO/releases/download/v$VERSION/kybern-gpuix_${VERSION}_x86_64.$FORMAT"
  fi
  FILE="$(basename "$URL")"
  NEW="${FILE#kybern-gpuix_}"
  NEW="${NEW%%_x86_64*}"

  TMP="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  case "$FORMAT" in
    deb)
      echo "==> downloading $FILE"
      curl -fL --retry 3 --progress-bar -o "$TMP/$FILE" "$URL"
      # apt reads the file as its unprivileged _apt user; a private mktemp folder would only earn a warning.
      chmod 755 "$TMP"; chmod 644 "$TMP/$FILE"
      # Going back to an older release the user asked for by number is the only reason to allow a downgrade.
      DOWNGRADE=
      if [ "$PINNED" = 1 ]; then
        # shellcheck disable=SC2016
        have="$(dpkg-query -W -f='${Version}' kybern-gpuix 2>/dev/null || true)"
        if [ -n "$have" ] && dpkg --compare-versions "$have" gt "$(printf '%s' "$NEW" | tr '-' '~')"; then DOWNGRADE=--allow-downgrades; fi
      fi
      # shellcheck disable=SC2086
      $SUDO apt-get install -y $DOWNGRADE "$TMP/$FILE"
      APP=/usr/bin/kybern-gpuix ;;
    rpm)
      echo "==> downloading $FILE"
      curl -fL --retry 3 --progress-bar -o "$TMP/$FILE" "$URL"
      have="$(rpm -q --qf '%{VERSION}' kybern-gpuix 2>/dev/null || true)"
      older=0
      if [ "$PINNED" = 1 ] && [ -n "$have" ] && [ "$(newer_of "$have" "$(printf '%s' "$NEW" | tr '-' '~')")" = "$have" ] && [ "$have" != "$(printf '%s' "$NEW" | tr '-' '~')" ]; then older=1; fi
      if command -v dnf >/dev/null 2>&1; then
        if [ "$older" = 1 ]; then $SUDO dnf downgrade -y "$TMP/$FILE"; else $SUDO dnf install -y "$TMP/$FILE"; fi
      elif [ "$older" = 1 ]; then $SUDO zypper --non-interactive install --oldpackage --allow-unsigned-rpm "$TMP/$FILE"
      else $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/$FILE"
      fi
      APP=/usr/bin/kybern-gpuix ;;
    AppImage)
      DEST="${KYBERN_APP_DIR:-$HOME/Applications}"
      mkdir -p "$DEST"
      APP="$DEST/Kybern-GPUIX-x86_64.AppImage"
      # Downloaded beside its final name so the last step is a rename on one filesystem, which is atomic. A running
      # Kybern GPUIX keeps its mounted old image; nothing ever writes into the file it runs from.
      PART="$DEST/.$FILE.part"
      echo "==> downloading $FILE"
      curl -fL --retry 3 --progress-bar -o "$PART" "$URL"
      chmod 755 "$PART"
      mv -f "$PART" "$APP"
      PART=
      # A menu entry and icon, like the deb and rpm install, pointing at this file.
      DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
      mkdir -p "$DATA/applications" "$DATA/icons/hicolor/256x256/apps"
      (cd "$TMP" && "$APP" --appimage-extract dev.kybern.gpuix.png >/dev/null 2>&1) \
        && cp -L "$TMP/squashfs-root/dev.kybern.gpuix.png" "$DATA/icons/hicolor/256x256/apps/dev.kybern.gpuix.png" 2>/dev/null || true
      # AppImages mount through FUSE. Without it the menu entry starts the image with its extract-and-run mode
      # (APPIMAGE_EXTRACT_AND_RUN=1: unpacked to a temporary folder for each run, slower to start) instead of failing.
      EXEC="\"$APP\""
      if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
        EXEC="env APPIMAGE_EXTRACT_AND_RUN=1 \"$APP\""
        APPIMAGE_EXTRACT_AND_RUN=1
        export APPIMAGE_EXTRACT_AND_RUN
        echo "==> FUSE is missing: the menu entry unpacks the AppImage on each start. Install fuse3 for a faster start (sudo apt install fuse3, sudo dnf install fuse3)"
      fi
      cat > "$DATA/applications/dev.kybern.gpuix.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kybern GPUIX
GenericName=Coding agent workspace
Comment=Run and review coding agents (native client, beta)
Exec=$EXEC
Icon=dev.kybern.gpuix
Terminal=false
Categories=Development;
StartupWMClass=dev.kybern.gpuix
DESKTOP
      ;;
  esac

  echo "==> installed $APP"
  if [ "$OPEN" = "1" ] && [ "$(id -u)" != 0 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$APP" >/dev/null 2>&1 &
  fi
  return 0
}

# Everything is defined before anything runs, so a truncated download runs nothing.
main "$@"
