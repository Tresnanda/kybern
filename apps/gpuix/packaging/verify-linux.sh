#!/usr/bin/env bash
# Checks the built Linux packages of Kybern GPUIX on this machine, the counterpart of
# windows/verify-install.ps1. CI runs it in desktop.yml's `gpuix-linux` job before the
# packages are uploaded. It installs the .deb with apt (needs sudo), runs a smoke start of
# the installed app and of the AppImage (KYBERN_GPUIX_SMOKE=1: the native addon loads with
# its libraries and the whole module graph imports, before any window or daemon exists),
# reads the .rpm's header, then removes the .deb again. Do not run it where the
# kybern-gpuix package you use is installed.
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

echo "== deb: ${debs[0]##*/}"
dpkg-deb --info "${debs[0]}" | sed -n 's/^ \(Package\|Version\|Architecture\|Depends\):/  \1:/p'
sudo apt-get install -y --no-install-recommends "${debs[0]}"
[[ -x /usr/bin/kybern-gpuix ]] || { echo "FAILED: /usr/bin/kybern-gpuix is missing" >&2; exit 1; }
desktop-file-validate /usr/share/applications/dev.kybern.gpuix.desktop
echo "ok: desktop entry"
for name in kybern kybernd; do
  if [[ -e /usr/bin/$name ]]; then echo "FAILED: the deb put $name on PATH (the Tauri package owns it)" >&2; exit 1; fi
done
smoke "the installed deb" /usr/bin/kybern-gpuix
sudo apt-get remove -y kybern-gpuix
[[ ! -e /usr/lib/kybern-gpuix ]] || { echo "FAILED: /usr/lib/kybern-gpuix is left after removal" >&2; exit 1; }
echo "ok: the deb removes cleanly"

echo "== AppImage: ${appimages[0]##*/}"
chmod +x "${appimages[0]}"
# Runners have no FUSE; the runtime extracts to a temporary folder instead of mounting.
smoke "the AppImage" env APPIMAGE_EXTRACT_AND_RUN=1 "${appimages[0]}"

echo "== rpm: ${rpms[0]##*/}"
rpm -qp --queryformat '  %{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' "${rpms[0]}"
rpm -qp --requires "${rpms[0]}" | sed 's/^/  requires: /'
echo "done: the Linux packages pass"
