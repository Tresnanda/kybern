#!/usr/bin/env bash
# Installs Ubuntu packages on a GitHub runner, surviving a mirror outage.
#
#   scripts/ci-apt-install.sh <package>...
#
# Every apt-get in CI and the release goes through here. The runners fetch from
# azure.archive.ubuntu.com through `mirror+file:/etc/apt/apt-mirrors.txt`,
# which also lists archive.ubuntu.com and security.ubuntu.com; when the Azure
# mirror stopped answering (release v0.25.0, run 44517562334), apt kept
# connecting to the Azure address for those fallbacks too and the step ran 25
# minutes before failing. So:
#
#  1. `apt-get update` (once per job) and a download-only install, each with
#     retries, short timeouts and a time cap. Downloading is safe to stop;
#     dpkg never runs under the cap.
#  2. If either fails, the Ubuntu sources are rewritten to archive.ubuntu.com
#     (security.ubuntu.com for the -security pocket) without the mirror list,
#     and step 1 runs once more.
#  3. `apt-get install` from the downloaded packages.
#
# Packages are installed with --no-install-recommends.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package>..." >&2
  exit 2
fi

sudo=""
if [ "$(id -u)" != 0 ]; then sudo="sudo"; fi

# Seconds; overridable to check the fallback quickly.
update_cap="${KYBERN_APT_UPDATE_CAP:-180}"
download_cap="${KYBERN_APT_DOWNLOAD_CAP:-420}"
apt_options=(
  -o Acquire::Retries=5
  -o Acquire::http::Timeout="${KYBERN_APT_TIMEOUT:-20}"
  -o Acquire::https::Timeout="${KYBERN_APT_TIMEOUT:-20}"
  -o DPkg::Lock::Timeout=300
)
export DEBIAN_FRONTEND=noninteractive
# One update per job: later calls reuse the lists, and the sources once rewritten.
marker="${RUNNER_TEMP:-/tmp}/kybern-apt-updated"
log=$(mktemp)
trap 'rm -f "$log"' EXIT

apt_update() {
  [ -f "$marker" ] && return 0
  # apt-get update exits 0 when an index could not be fetched; its warnings say so.
  if ! $sudo timeout "$update_cap" apt-get "${apt_options[@]}" update 2>&1 | tee "$log"; then return 1; fi
  if grep -qE '^(W|E): (Failed to fetch|Some index files failed to download)' "$log"; then return 1; fi
  touch "$marker"
}

apt_download() {
  $sudo timeout "$download_cap" apt-get "${apt_options[@]}" install -y --no-install-recommends --download-only "$@"
}

use_ubuntu_archive() {
  echo "::warning::The Ubuntu mirror did not answer; retrying with archive.ubuntu.com and security.ubuntu.com"
  . /etc/os-release
  local mirror='(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://([a-z0-9-]+\.)+archive\.ubuntu\.com/ubuntu)/?'
  local file
  # One-line sources: the -security pocket to security.ubuntu.com, the rest to archive.ubuntu.com.
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [ -f "$file" ] || continue
    $sudo sed -i -E \
      -e "/^[[:space:]]*deb(-src)?[[:space:]].*[[:space:]][a-z]+-security([[:space:]]|$)/ s#$mirror#http://security.ubuntu.com/ubuntu/#g" \
      -e "s#$mirror#http://archive.ubuntu.com/ubuntu/#g" "$file"
  done
  # deb822 sources (Ubuntu 24.04): archive.ubuntu.com serves every pocket, -security included.
  for file in /etc/apt/sources.list.d/*.sources; do
    [ -f "$file" ] || continue
    $sudo sed -i -E "/^URIs:/ s#$mirror#http://archive.ubuntu.com/ubuntu/#g" "$file"
  done
  if ! grep -rqs 'security\.ubuntu\.com' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    echo "deb http://security.ubuntu.com/ubuntu/ ${VERSION_CODENAME}-security main restricted universe multiverse" \
      | $sudo tee /etc/apt/sources.list.d/kybern-ubuntu-security.list >/dev/null
  fi
  grep -rhsE '^[[:space:]]*(deb|URIs:)' /etc/apt/sources.list /etc/apt/sources.list.d/ || true
  rm -f "$marker"
}

if ! { apt_update && apt_download "$@"; }; then
  use_ubuntu_archive
  apt_update
  apt_download "$@"
fi
$sudo apt-get "${apt_options[@]}" install -y --no-install-recommends "$@"
