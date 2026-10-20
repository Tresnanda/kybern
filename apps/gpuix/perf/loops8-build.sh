#!/bin/sh
# Research iteration only; final acceptance still uses native/update.sh.
set -eu
cd "$(dirname "$0")/../native"
here=$(pwd)
if [ "${KYBERN_LOOPS_PACKAGE_ONLY:-0}" != 1 ]; then
python3 patches/backdrop_gpui.py upstream/zed
(cd upstream/packages/native && RUSTC_WRAPPER= HOST_CC=cc HOST_CXX=c++ CC=cc CXX=c++ CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$here/build/target" cargo +1.97.1 build --release --lib)
fi
cp build/target/release/libgpuix_native.dylib build/gpuix-native.darwin-arm64.node
python3 tools/align_strtab.py build/gpuix-native.darwin-arm64.node
codesign -f -s - build/gpuix-native.darwin-arm64.node
node -e "require('$here/build/gpuix-native.darwin-arm64.node')"
