#!/bin/sh
# Build the Kybern-patched GPUIX native module, optionally moving to a new
# upstream release. The patch is small and reapplied from scratch every time,
# so staying current with GPUIX is: run this with the new version, fix any hook
# it reports, check, commit.
#
#   ./update.sh            rebuild the pinned version (VERSION)
#   ./update.sh 0.11.0     move to @gpuix/native@0.11.0 (also bumps the npm
#                          packages and recreates the JS patch)
#   KYBERN_NATIVE_CHECKS=0 ./update.sh
#                          build, align, sign and load-check the addon, but skip
#                          the typecheck and on-screen native checks (CI
#                          runners have no usable display)
#
# Steps: fetch upstream at the tag → reset packages/native/src → copy
# patches/*.rs → apply patches/apply_hooks.py (fails loudly, writing
# nothing, if an anchor moved) → cargo build → realign + re-sign → dlopen check
# → capability checks. Output: build/gpuix-native.darwin-arm64.node, which
# src/native/local-build.ts loads.
#
#   KYBERN_GPUIX_TARGET=x86_64-apple-darwin ./update.sh
#                          cross-build the Intel addon, build/gpuix-native.darwin-x64.node.
#                          Its load check and on-screen checks run under Rosetta
#                          with an x64 Bun (tools/bun-x64.sh).
set -eu
cd "$(dirname "$0")"
here=$(pwd)
app=$(cd .. && pwd)
pinned=$(cat VERSION)
version=${1:-$pinned}
tag="@gpuix/native@$version"
host=$(rustc +1.97.1 -vV | sed -n 's/^host: //p')
target=${KYBERN_GPUIX_TARGET:-$host}
case "$target" in
  aarch64-apple-darwin) arch=darwin-arm64 ;;
  x86_64-apple-darwin) arch=darwin-x64 ;;
  *) echo "unsupported GPUIX target: $target" >&2; exit 1 ;;
esac
release=build/target/release
cross=
if [ "$target" != "$host" ]; then
  release=build/target/$target/release
  cross="--target $target"
fi

echo "== GPUIX $version (pinned $pinned) for $target"
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
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$here/build/target" cargo +1.97.1 build --release --lib $cross
)

(
  cd "$app"
  rustc --test native/patches/spring.rs -o native/build/spring-tests
  native/build/spring-tests
  rustc --test native/patches/physical_spring.rs -o native/build/physical-spring-tests
  native/build/physical-spring-tests
  rustc --test native/patches/rich_doc.rs -o native/build/rich-doc-tests
  native/build/rich-doc-tests
  rustc --edition 2021 --test native/patches/backdrop_kernel.rs -o native/build/backdrop-kernel-tests
  native/build/backdrop-kernel-tests
  python3 native/markdown-document-test.py
)

echo "== package"
out=build/gpuix-native.$arch.node
# Replace the signed inode; another fixture may still have it mapped.
rm -f "$out"
cp "$release/libgpuix_native.dylib" "$out"
# Xcode 27's ld misaligns the LINKEDIT string pool of this dylib; dyld rejects it.
python3 tools/align_strtab.py "$out"
codesign -f -s - "$out" 2>/dev/null
if [ "$arch" = darwin-x64 ] && [ "$(uname -m)" = arm64 ]; then
  tools/bun-x64.sh -e "require('$here/$out')"
else
  node -e "require('$here/$out')"
fi
echo "native module loads"
python3 tools/check_arena.py
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

if [ "${KYBERN_NATIVE_CHECKS:-1}" = "0" ]; then
  echo "done: GPUIX $version with Kybern patches (on-screen checks skipped)"
  exit 0
fi

echo "== checks"
(
  cd "$app"
  pnpm typecheck
  export NAPI_RS_NATIVE_LIBRARY_PATH="$here/$out"
  if [ "$arch" = darwin-x64 ] && [ "$(uname -m)" = arm64 ]; then
    # Every `bun` the checks start, and the windows they spawn, run as x64 Bun under Rosetta.
    tools/bun-x64.sh --version >/dev/null
    export PATH="$here/build/bun-x64:$PATH" BUN_BE_BUN=1
  fi
  # Captures need exclusive windows too. Split the suite into bounded leases;
  # the four lock-using checks still share exactly one inherited lease.
  for batch in geometry content input; do
    bun native/ui-lease.ts "update-$batch-$(basename "$(cd "$app/../.." && pwd)")" sh native/check-update.sh "$batch"
  done
)
echo "done: GPUIX $version with Kybern patches"
