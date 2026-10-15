#!/bin/sh
# Build the Kybern-patched GPUIX native module, optionally moving to a new
# upstream release. The patch is small and reapplied from scratch every time,
# so staying current with GPUIX is: run this with the new version, fix any hook
# it reports, check, commit.
#
#   ./update.sh            rebuild the pinned version (VERSION)
#   ./update.sh 0.11.0     move to @gpuix/native@0.11.0 (also bumps the npm
#                          packages and recreates the JS patch)
#
# Steps: fetch upstream at the tag → reset packages/native/src → copy
# patches/cache_island.rs → apply patches/apply_hooks.py (fails loudly, writing
# nothing, if an anchor moved) → cargo build → realign + re-sign → dlopen check
# → islands check. Output: build/gpuix-native.darwin-arm64.node, which
# src/native/local-build.ts loads.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
app=$(cd .. && pwd)
pinned=$(cat VERSION)
version=${1:-$pinned}
tag="@gpuix/native@$version"

echo "== GPUIX $version (pinned $pinned)"
if [ ! -d upstream/.git ]; then
  git clone --filter=blob:none --no-checkout https://github.com/remorses/gpuix.git upstream
fi
git -C upstream fetch -q --filter=blob:none --tags origin
git -C upstream checkout -q --force "$tag"
git -C upstream clean -fdq packages/native/src
git -C upstream submodule update -q --init --filter=blob:none zed

echo "== patch"
cp patches/cache_island.rs upstream/packages/native/src/
python3 patches/apply_hooks.py upstream/packages/native/src

echo "== build (several minutes after a version change)"
# kache (the global rustc wrapper here) is bypassed: the release link must be
# exactly what rustc produced.
(
  cd upstream/packages/native
  RUSTC_WRAPPER= HOST_CC=cc HOST_CXX=c++ CC=cc CXX=c++ \
    CARGO_TARGET_DIR="$here/build/target" cargo build --release --lib
)

echo "== package"
out=build/gpuix-native.darwin-arm64.node
cp build/target/release/libgpuix_native.dylib "$out"
# Xcode 27's ld misaligns the LINKEDIT string pool of this dylib; dyld rejects it.
python3 tools/align_strtab.py "$out"
codesign -f -s - "$out" 2>/dev/null
node -e "require('$here/$out')"
echo "native module loads"

if [ "$version" != "$pinned" ]; then
  echo "== npm packages and JS patch → $version"
  (
    cd "$app"
    pnpm add -E "@gpuix/react@$version" "@gpuix/native@$version"
    rm -f "patches/@gpuix__native@$pinned.patch"
    sed -i '' "/@gpuix\/native@$pinned/d" pnpm-workspace.yaml
    edit=$(mktemp -d)
    pnpm patch "@gpuix/native@$version" --edit-dir "$edit/native" >/dev/null
    python3 "$here/patches/patch_js.py" "$edit/native"
    pnpm patch-commit "$edit/native"
  )
  echo "$version" > VERSION
fi

echo "== checks"
(
  cd "$app"
  pnpm typecheck
  bun scripts/island-check.ts
)
echo "done: GPUIX $version with Kybern patches"
