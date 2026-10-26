#!/usr/bin/env bash
# Checks the built Linux packages of Kybern GPUIX on this machine, the counterpart of
# windows/verify-install.ps1. CI runs it in desktop.yml's `gpuix-linux` job before the
# packages are uploaded. It installs the .deb with apt (needs sudo), runs a smoke start of
# the installed app and of the AppImage (KYBERN_GPUIX_SMOKE=1: the native addon loads with
# its libraries and the whole module graph imports, before any window or daemon exists),
# reads the .rpm's header, then removes the .deb again. Do not run it where the
# kybern-gpuix package you use is installed.
#
# It also checks that each package carries the embedded web view (WP10): the
# companion and the private WPE WebKit in resources, the .deb's AppArmor profile
# for Kybern's bwrap, EGL and GLES among the dependencies and bubblewrap among
# the recommendations, and that the installed companion and web process resolve
# every library. KYBERN_VERIFY_WEBVIEW=0 skips that for a local package built
# without WPE (pages then open in the browser).
#
#   apps/gpuix/packaging/verify-linux.sh [dist]
set -euo pipefail
dist=$(cd "${1:-dist}" && pwd)
shopt -s nullglob
debs=("$dist"/kybern-gpuix_*.deb) appimages=("$dist"/kybern-gpuix_*.AppImage) rpms=("$dist"/kybern-gpuix_*.rpm)
[[ ${#debs[@]} == 1 && ${#appimages[@]} == 1 && ${#rpms[@]} == 1 ]] || { echo "FAILED: expected one .deb, .AppImage and .rpm in $dist" >&2; exit 1; }

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
smoke() {
  local what=$1; shift
  local out="$scratch/smoke-$RANDOM.txt" data="$scratch/data-$RANDOM"
  mkdir -p "$data"
  if KYBERN_DATA_DIR="$data" KYBERN_GPUIX_SMOKE=1 KYBERN_GPUIX_SMOKE_OUT="$out" timeout 120 "$@" && [[ "$(cat "$out" 2>/dev/null)" == ok ]]; then
    echo "ok: $what loads its native addon and modules"
  else
    echo "FAILED: $what smoke run: $(cat "$out" 2>/dev/null || echo '(no output)')" >&2
    exit 1
  fi
}

fail() { echo "FAILED: $*" >&2; exit 1; }
webview=${KYBERN_VERIFY_WEBVIEW:-1}
resources=usr/lib/kybern-gpuix/resources
# The two files every package must carry for the web view, relative to /.
web_files=("$resources/libkybern-webview.so" "$resources/wpe/lib/libWPEWebKit-2.0.so.1")
has_files() {
  local what=$1 list=$2 file
  for file in "${web_files[@]}" "$resources/wpe/lib/wpe-webkit-2.0/WPEWebProcess" "$resources/wpe/lib/wpe-webkit-2.0/bwrap" "$resources/wpe/SOURCES.txt"; do
    grep -qxF "$file" "$list" || fail "the $what has no /$file"
  done
  echo "ok: the $what carries the web view (companion, WPE WebKit, its helpers, bwrap, source offer)"
}
# A comma-separated dependency field names this package (alone or in an alternative).
lists() { tr ',|' '\n\n' <<< "$1" | sed -E 's/^ *([^ (]+).*/\1/' | grep -qxF "$2"; }

echo "== deb: ${debs[0]##*/}"
dpkg-deb --info "${debs[0]}" | sed -n 's/^ \(Package\|Version\|Architecture\|Depends\|Recommends\):/  \1:/p'
if [[ $webview == 1 ]]; then
  dpkg-deb --fsys-tarfile "${debs[0]}" | tar -t | sed 's|^\./||' > "$scratch/deb.txt"
  has_files deb "$scratch/deb.txt"
  depends=$(dpkg-deb -f "${debs[0]}" Depends) recommends=$(dpkg-deb -f "${debs[0]}" Recommends)
  for name in libegl1 libgles2; do lists "$depends" "$name" || fail "the deb does not depend on $name: $depends"; done
  for name in bubblewrap xdg-dbus-proxy; do lists "$depends, $recommends" "$name" || fail "the deb neither depends on nor recommends $name"; done
  echo "ok: the deb depends on libegl1 and libgles2 and asks for bubblewrap and xdg-dbus-proxy"
  mkdir -p "$scratch/control"
  dpkg-deb --control "${debs[0]}" "$scratch/control"
  grep -q 'profile kybern-gpuix-bwrap /usr/lib/kybern-gpuix/resources/wpe/lib/wpe-webkit-2.0/bwrap' "$scratch/control/postinst" 2>/dev/null \
    || fail "the deb's postinst does not install the AppArmor profile for Kybern's bwrap"
  grep -q 'userns,' "$scratch/control/postinst" || fail "the deb's AppArmor profile does not allow userns"
  grep -q 'apparmor_parser -R' "$scratch/control/postrm" 2>/dev/null || fail "the deb's postrm does not unload the AppArmor profile"
  echo "ok: the deb installs (postinst) and removes (postrm) the AppArmor profile for Kybern's bwrap"
fi
sudo apt-get install -y --no-install-recommends "${debs[0]}"
[[ -x /usr/bin/kybern-gpuix ]] || { echo "FAILED: /usr/bin/kybern-gpuix is missing" >&2; exit 1; }
desktop-file-validate /usr/share/applications/dev.kybern.gpuix.desktop
echo "ok: desktop entry"
for name in kybern kybernd; do
  if [[ -e /usr/bin/$name ]]; then echo "FAILED: the deb put $name on PATH (the Tauri package owns it)" >&2; exit 1; fi
done
smoke "the installed deb" /usr/bin/kybern-gpuix
if [[ $webview == 1 ]]; then
  # The bundled libraries resolve beside the companion and WPE (RUNPATH), the rest from the system.
  for file in /${web_files[0]} /${web_files[1]} /$resources/wpe/lib/wpe-webkit-2.0/WPEWebProcess /$resources/wpe/lib/wpe-webkit-2.0/WPENetworkProcess; do
    missing=$(ldd "$file" | grep 'not found' || true)
    [[ -z $missing ]] || fail "$file has unresolved libraries:"$'\n'"$missing"
  done
  ldd "/${web_files[0]}" | grep -q "/$resources/wpe/lib/libWPEWebKit-2.0.so.1" || fail "the companion does not load the bundled WPE WebKit"
  echo "ok: the installed companion and WPE's processes resolve every library (WPE from resources/wpe/lib)"
fi
sudo apt-get remove -y kybern-gpuix
[[ ! -e /usr/lib/kybern-gpuix ]] || { echo "FAILED: /usr/lib/kybern-gpuix is left after removal" >&2; exit 1; }
echo "ok: the deb removes cleanly"

echo "== AppImage: ${appimages[0]##*/}"
chmod +x "${appimages[0]}"
if [[ $webview == 1 ]]; then
  (cd "$scratch" && "${appimages[0]}" --appimage-extract > /dev/null)
  (cd "$scratch/squashfs-root" && find . \( -type f -o -type l \) | sed 's|^\./||') > "$scratch/appimage.txt"
  has_files AppImage "$scratch/appimage.txt"
  rm -rf "$scratch/squashfs-root"
fi
# Runners have no FUSE; the runtime extracts to a temporary folder instead of mounting.
smoke "the AppImage" env APPIMAGE_EXTRACT_AND_RUN=1 "${appimages[0]}"

echo "== rpm: ${rpms[0]##*/}"
rpm -qp --queryformat '  %{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' "${rpms[0]}"
rpm -qp --requires "${rpms[0]}" | sed 's/^/  requires: /'
if [[ $webview == 1 ]]; then
  rpm -qlp "${rpms[0]}" | sed 's|^/||' > "$scratch/rpm.txt"
  has_files rpm "$scratch/rpm.txt"
  requires=$(rpm -qp --requires "${rpms[0]}") recommends=$(rpm -qp --recommends "${rpms[0]}")
  for name in 'libEGL.so.1()(64bit)' 'libGLESv2.so.2()(64bit)'; do grep -qxF "$name" <<< "$requires" || fail "the rpm does not require $name"; done
  grep -qxF bubblewrap <<< "$recommends" || fail "the rpm does not recommend bubblewrap"
  echo "ok: the rpm requires EGL and GLES and recommends bubblewrap"
fi
echo "done: the Linux packages pass"
