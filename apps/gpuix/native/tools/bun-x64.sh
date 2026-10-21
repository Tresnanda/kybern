#!/bin/sh
# Run x86_64 Bun under Rosetta on Apple Silicon, for the Intel addon's checks.
# Bun ships no universal binary; a standalone executable compiled for
# bun-darwin-x64 carries the whole x64 runtime and acts as the Bun CLI when
# BUN_BE_BUN=1. Built once into build/bun-x64/bun from the host Bun's version.
#
#   tools/bun-x64.sh -e "require('./build/gpuix-native.darwin-x64.node')"
#   PATH="$PWD/build/bun-x64:$PATH" BUN_BE_BUN=1 bun native/paint-check.ts
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/build/bun-x64/bun"
if [ ! -x "$bin" ]; then
  arch -x86_64 /usr/bin/true 2>/dev/null || { echo "x64 Bun needs Rosetta: softwareupdate --install-rosetta" >&2; exit 1; }
  mkdir -p "$here/build/bun-x64"
  stub=$(mktemp -d)
  echo 'console.error("run with BUN_BE_BUN=1")' > "$stub/stub.ts"
  bun build --compile --target=bun-darwin-x64 "$stub/stub.ts" --outfile "$bin" >/dev/null
  rm -rf "$stub"
fi
BUN_BE_BUN=1 exec "$bin" "$@"
