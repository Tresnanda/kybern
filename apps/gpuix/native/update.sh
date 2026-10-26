#!/bin/sh
# Build Kybern's GPUIX native module from the fork pinned in FORK: Tresnanda/gpuix
# at `commit` (the upstream release plus our commits), with its zed submodule on
# Tresnanda/zed. Nothing is patched here; a native change is a commit on the
# forks' `kybern` branches and a new pin (README.md, "Changing the native module").
#
#   ./update.sh            rebuild the pinned fork commit for VERSION
#   ./update.sh 0.12.0     after the fork moved to @gpuix/native@0.12.0 (FORK's
#                          `upstream`): build it, bump the npm packages and
#                          recreate the JS patch
#   KYBERN_GPUIX_SOURCE=~/src/gpuix ./update.sh
#                          build a local gpuix checkout (zed submodule included)
#                          as it is, skipping the fetch: for trying fork commits
#                          before pushing them, and for the canary's rebased tree
#   KYBERN_NATIVE_CHECKS=0 ./update.sh
#                          build, align, sign and load-check the addon, but skip
#                          the typecheck and on-screen native checks (CI
#                          runners have no usable display)
#
# Steps: fetch the fork at the pinned commit with its zed submodule → cargo
# build → the fork's standalone unit tests → realign + re-sign → dlopen check →
# capability checks. Output: build/gpuix-native.darwin-arm64.node, which
# src/native/local-build.ts loads.
#
#   KYBERN_GPUIX_PREBUILT=1 ./update.sh
#                          skip the zed submodule and the cargo build when
#                          build/target/.../libgpuix_native.dylib and
#                          upstream/zed/crates/gpui/src/arena.rs already exist
#                          (CI restores them from a cache keyed on FORK and this
#                          script); the gpuix checkout the unit tests compile
#                          from is still fetched, and every later step runs
#                          except markdown-document-test.py, which needs the
#                          dependency rlibs and already passed when the cache
#                          was built.
#
#   KYBERN_GPUIX_TARGET=x86_64-apple-darwin ./update.sh
#                          cross-build the Intel addon, build/gpuix-native.darwin-x64.node.
#                          Its load check and on-screen checks run under Rosetta
#                          with an x64 Bun (tools/bun-x64.sh).
#
# Linux and Windows (ADE-52 spike, `.github/workflows/gpuix-platforms.yml`): run
# natively on that OS (Git Bash on Windows, PYTHON=python there) with
# KYBERN_NATIVE_CHECKS=0. Output: build/gpuix-native.linux-x64-gnu.node or
# build/gpuix-native.win32-x64-msvc.node, and on Windows the WebView2 companion
# build/kybern-webview.dll (webview-win/, WP10). The Mach-O realign, codesign and
# the Cocoa companion are macOS-only and skipped; so are the on-screen checks.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
app=$(cd .. && pwd)
pinned=$(cat VERSION)
version=${1:-$pinned}
tag="@gpuix/native@$version"
pin() { sed -n "s/^$1=//p" FORK | tr -d '\r'; }
fork_repo=$(pin repo) fork_commit=$(pin commit) fork_zed=$(pin zed) fork_upstream=$(pin upstream)
host=$(rustc +1.97.1 -vV | sed -n 's/^host: //p')
target=${KYBERN_GPUIX_TARGET:-$host}
py=${PYTHON:-python3}
exe=
case "$target" in
  aarch64-apple-darwin) arch=darwin-arm64 lib=libgpuix_native.dylib ;;
  x86_64-apple-darwin) arch=darwin-x64 lib=libgpuix_native.dylib ;;
  x86_64-unknown-linux-gnu) arch=linux-x64-gnu lib=libgpuix_native.so ;;
  aarch64-unknown-linux-gnu) arch=linux-arm64-gnu lib=libgpuix_native.so ;;
  x86_64-pc-windows-msvc) arch=win32-x64-msvc lib=gpuix_native.dll exe=.exe ;;
  *) echo "unsupported GPUIX target: $target" >&2; exit 1 ;;
esac
export KYBERN_EXE_SUFFIX=$exe
release=build/target/release
cross=
if [ "$target" != "$host" ]; then
  release=build/target/$target/release
  cross="--target $target"
fi

echo "== GPUIX $version (pinned $pinned) for $target"
# $src is the tree cargo builds, relative to this directory; $app_src is the same
# tree relative to the app (the unit tests compile from there).
if [ -n "${KYBERN_GPUIX_SOURCE:-}" ]; then
  src=$(cd "$KYBERN_GPUIX_SOURCE" && pwd)
  app_src=$src
  # The tools that read the source tree (check_arena.py, the Markdown parity
  # test) default to upstream/.
  export KYBERN_GPUIX_TREE="$src"
  echo "== building the local checkout $src ($(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout'))"
else
  src=upstream
  app_src=native/upstream
  if [ "$fork_upstream" != "$tag" ]; then
    echo "FORK is based on $fork_upstream, not $tag: move the fork's kybern branch to $tag and pin it first (README.md, \"Moving to a new GPUIX release\")" >&2
    exit 1
  fi
fi
# Check out the pinned fork commit into upstream/. A checkout made by the old
# patch queue (origin remorses/gpuix, zed edited in place) is reused and moved over.
fetch_fork() {
  if [ ! -d upstream/.git ]; then
    # A CI cache hit has already restored upstream/zed/...; clone beside it.
    rm -rf upstream.clone
    git clone -q --filter=blob:none --no-checkout "$fork_repo" upstream.clone
    mkdir -p upstream
    mv upstream.clone/.git upstream/.git
    rm -rf upstream.clone
  fi
  git -C upstream remote set-url origin "$fork_repo"
  if ! git -C upstream cat-file -e "$fork_commit^{commit}" 2>/dev/null; then
    git -C upstream fetch -q --filter=blob:none origin "$fork_commit"
  fi
  if [ -e upstream/zed/.git ]; then
    git -C upstream/zed reset -q --hard
    git -C upstream/zed clean -fdq
  fi
  git -C upstream checkout -q --force --detach "$fork_commit"
}

if [ "${KYBERN_GPUIX_PREBUILT:-0}" = 1 ] && [ -f "$release/$lib" ] && [ -f "$src/zed/crates/gpui/src/arena.rs" ]; then
  # CI restored the cargo output (and the one zed file check_arena.py reads)
  # for exactly these inputs: the same FORK, this script, toolchain and target.
  # The unit tests, the realign + re-sign, the load check, the arena tests and
  # the webview companion still run; only the Markdown parser parity test (it
  # needs the dependency rlibs) is skipped.
  echo "== reusing the prebuilt $release/$lib"
  prebuilt=1
  [ -n "${KYBERN_GPUIX_SOURCE:-}" ] || fetch_fork
else
  prebuilt=0
  if [ -z "${KYBERN_GPUIX_SOURCE:-}" ]; then
    fetch_fork
    git -C upstream clean -fdq
    # Older checkouts still name remorses/zed in .git/config; take the URL from .gitmodules.
    git -C upstream submodule sync -q zed
    git -C upstream submodule update -q --init --filter=blob:none zed
    actual=$(git -C upstream/zed rev-parse HEAD)
    if [ "$actual" != "$fork_zed" ]; then
      echo "the fork commit $fork_commit records zed $actual, FORK says $fork_zed: fix the pin" >&2
      exit 1
    fi
  fi

  echo "== build (several minutes after a version change)"
  # kache (the global rustc wrapper here) is bypassed: the release link must be
  # exactly what rustc produced. --locked: the fork commits Cargo.lock.
  (
    cd "$src/packages/native"
    case "$target" in
      *-apple-darwin)
        RUSTC_WRAPPER= HOST_CC=cc HOST_CXX=c++ CC=cc CXX=c++ \
          CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$here/build/target" cargo +1.97.1 build --release --lib --locked $cross ;;
      *)
        RUSTC_WRAPPER= CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$here/build/target" cargo +1.97.1 build --release --lib --locked $cross ;;
    esac
  )
fi

(
  # Standalone unit tests of Kybern modules in the fork's native crate.
  cd "$app"
  mkdir -p native/build
  native_src=$app_src/packages/native/src
  rustc --test "$native_src/spring.rs" -o native/build/spring-tests$exe
  native/build/spring-tests$exe
  rustc --test "$native_src/physical_spring.rs" -o native/build/physical-spring-tests$exe
  native/build/physical-spring-tests$exe
  rustc --test "$native_src/rich_doc.rs" -o native/build/rich-doc-tests$exe
  native/build/rich-doc-tests$exe
  rustc --edition 2021 --test "$native_src/backdrop_kernel.rs" -o native/build/backdrop-kernel-tests$exe
  native/build/backdrop-kernel-tests$exe
  # The renderers build zed's copy; the test above compiles the native crate's, which must be the same file.
  zed_kernel=$app_src/zed/crates/gpui/src/backdrop_kernel.rs
  if [ -f "$zed_kernel" ] && ! cmp -s "$zed_kernel" "$native_src/backdrop_kernel.rs"; then
    echo "$native_src/backdrop_kernel.rs differs from $zed_kernel: they must be the same file" >&2
    exit 1
  fi
  if [ "$prebuilt" = 1 ]; then
    # It compiles against the cargo dependency rlibs, which a cache hit does not
    # restore; its inputs (FORK and the test itself) are in the cache key, so
    # the build that saved the cache already ran it on exactly these sources.
    echo "markdown-document-test.py: ran when the cached build was made"
  else
    "$py" native/markdown-document-test.py
  fi
)

echo "== package"
out=build/gpuix-native.$arch.node
# Replace the signed inode; another fixture may still have it mapped.
rm -f "$out"
cp "$release/$lib" "$out"
case "$target" in
  *-apple-darwin)
    # Xcode 27's ld misaligns the LINKEDIT string pool of this dylib; dyld rejects it.
    "$py" tools/align_strtab.py "$out"
    codesign -f -s - "$out" 2>/dev/null ;;
esac
if [ "$arch" = darwin-x64 ] && [ "$(uname -m)" = arm64 ]; then
  tools/bun-x64.sh -e "require('$here/$out')"
else
  # Resolved by Node itself: Git Bash's /d/... paths mean nothing to node.exe.
  node -e "require(require('path').resolve(process.argv[1]))" "$out"
fi
echo "native module loads"
"$py" tools/check_arena.py
case "$target" in
  *-apple-darwin | x86_64-pc-windows-msvc) bun build-webview.ts ;;
  *) echo "webview companion: macOS and Windows only (previews open in the browser elsewhere)" ;;
esac

if [ "$version" != "$pinned" ]; then
  echo "== npm packages and JS patch → $version"
  (
    cd "$app"
    # Unregister the old patches first: pnpm refuses a lockfile whose patches no
    # longer match a dependency (ERR_PNPM_UNUSED_PATCH).
    rm -f "patches/@gpuix__native@$pinned.patch" "patches/@gpuix__react@$pinned.patch"
    sed -i '' "/@gpuix\/native@$pinned/d; /@gpuix\/react@$pinned/d" pnpm-workspace.yaml
    pnpm add -E "@gpuix/react@$version" "@gpuix/native@$version"
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
  echo "done: GPUIX $version from the Kybern fork (on-screen checks skipped)"
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
echo "done: GPUIX $version from the Kybern fork"
