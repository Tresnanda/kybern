#!/usr/bin/env bash
# The WPE build store: every built prefix (the wpe.tar.xz gpuix-wpe.yml caches)
# under its cache key on the maintainer's server, so a release does not build
# WebKit cold when GitHub has evicted the Actions cache. On the server the key
# can only read a build's checksum and bytes and add a build once; an existing
# build is never replaced.
#
#   store.sh fetch <cache key> <file>    exits non-zero when there is no such build
#   store.sh upload <cache key> <file>
#
# Needs WPE_STORE_HOST (user@host), WPE_STORE_SSH_KEY and WPE_STORE_KNOWN_HOSTS.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: store.sh fetch|upload <cache key> <file>" >&2
  exit 2
fi
action=$1 name="$2.tar.xz" file=$3
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$WPE_STORE_SSH_KEY" > "$work/key"
chmod 600 "$work/key"
printf '%s\n' "$WPE_STORE_KNOWN_HOSTS" > "$work/known_hosts"
store() {
  ssh -F /dev/null -i "$work/key" -o IdentitiesOnly=yes -o UserKnownHostsFile="$work/known_hosts" \
    -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20 "$WPE_STORE_HOST" "$@"
}

case "$action" in
  fetch)
    sum=$(store sha "$name")
    store get "$name" > "$file"
    echo "${sum%% *}  $file" | sha256sum -c -
    ;;
  upload)
    store put "$name" < "$file"
    ;;
  *)
    echo "usage: store.sh fetch|upload <cache key> <file>" >&2
    exit 2
    ;;
esac
