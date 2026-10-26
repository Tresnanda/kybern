#!/bin/sh
# WP10 Linux spike: build and run offscreen.c in a throwaway Debian container (WPE WebKit 2.0 API with WPEPlatform;
# Ubuntu 24.04 does not package WPE WebKit at all). Uses OrbStack/Docker; the container and image are named wp10l-*
# and removed at the end. No GPU, no display server: WPE's headless display renders through Mesa (llvmpipe) or SHM.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
image=debian:sid-slim
name=wp10l-wpe-offscreen
# Only remove the image afterwards if this run pulled it (OrbStack is shared with other agents).
pulled=1; docker image inspect "$image" >/dev/null 2>&1 && pulled=0
docker run --rm --name "$name" -v "$here:/spike:ro" -w /tmp "$image" sh -c '
  set -e
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libwpewebkit-2.0-dev gcc pkg-config >/dev/null
  dpkg-query -W -f "\${Package} \${Version}\n" libwpewebkit-2.0-1 libwpe-1.0-1 2>/dev/null || true
  modules=$(pkg-config --list-all | awk "{print \$1}" | grep -E "^wpe-(webkit|platform)" | tr "\n" " ")
  echo "pkg-config: $modules"
  gcc -O1 -o offscreen /spike/offscreen.c $(pkg-config --cflags --libs $modules)
  ./offscreen
  du -sh /usr/lib/*/libWPEWebKit-2.0.so* /usr/lib/*/wpe-webkit-2.0 2>/dev/null || true
'
[ "$pulled" = 1 ] && docker image rm "$image" >/dev/null 2>&1 || true
