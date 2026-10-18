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
# patches/*.rs → apply patches/apply_hooks.py (fails loudly, writing
# nothing, if an anchor moved) → cargo build → realign + re-sign → dlopen check
# → capability checks. Output: build/gpuix-native.darwin-arm64.node, which
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
cp patches/*.rs upstream/packages/native/src/
python3 patches/apply_hooks.py upstream/packages/native/src
python3 patches/backdrop_gpui.py upstream/zed

echo "== build (several minutes after a version change)"
# kache (the global rustc wrapper here) is bypassed: the release link must be
# exactly what rustc produced.
(
  cd upstream/packages/native
  RUSTC_WRAPPER= HOST_CC=cc HOST_CXX=c++ CC=cc CXX=c++ \
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$here/build/target" cargo +1.97.1 build --release --lib
)

(
  cd "$app"
  rustc --test native/patches/spring.rs -o native/build/spring-tests
  native/build/spring-tests
  rustc --test native/patches/physical_spring.rs -o native/build/physical-spring-tests
  native/build/physical-spring-tests
  rustc --test native/patches/rich_doc.rs -o native/build/rich-doc-tests
  native/build/rich-doc-tests
  python3 native/markdown-document-test.py
)

echo "== package"
out=build/gpuix-native.darwin-arm64.node
# Replace the signed inode; another fixture may still have it mapped.
rm -f "$out"
cp build/target/release/libgpuix_native.dylib "$out"
# Xcode 27's ld misaligns the LINKEDIT string pool of this dylib; dyld rejects it.
python3 tools/align_strtab.py "$out"
codesign -f -s - "$out" 2>/dev/null
node -e "require('$here/$out')"
echo "native module loads"
bun build-webview.ts

if [ "$version" != "$pinned" ]; then
  echo "== npm packages and JS patch → $version"
  (
    cd "$app"
    pnpm add -E "@gpuix/react@$version" "@gpuix/native@$version"
    rm -f "patches/@gpuix__native@$pinned.patch" "patches/@gpuix__react@$pinned.patch"
    sed -i '' "/@gpuix\/native@$pinned/d; /@gpuix\/react@$pinned/d" pnpm-workspace.yaml
    edit=$(mktemp -d)
    pnpm patch "@gpuix/native@$version" --edit-dir "$edit/native" >/dev/null
    python3 "$here/patches/patch_js.py" "$edit/native"
    pnpm patch-commit "$edit/native"
    pnpm patch "@gpuix/react@$version" --edit-dir "$edit/react" >/dev/null
    python3 "$here/patches/patch_react.py" "$edit/react"
    pnpm patch-commit "$edit/react"
    rm -rf "$edit"
  )
  echo "$version" > VERSION
fi

echo "== checks"
(
  cd "$app"
  pnpm typecheck
  export NAPI_RS_NATIVE_LIBRARY_PATH="$here/build/gpuix-native.darwin-arm64.node"
  # Captures need exclusive windows too. Split the suite into bounded leases;
  # the four lock-using checks still share exactly one inherited lease.
  for batch in geometry content input; do
    bun native/ui-lease.ts "update-$batch-$(basename "$(cd "$app/../.." && pwd)")" sh native/check-update.sh "$batch"
  done
)
echo "done: GPUIX $version with Kybern patches"
