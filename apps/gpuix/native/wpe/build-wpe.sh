#!/bin/sh
# Build the private WPE WebKit that Kybern GPUIX ships on Linux (WP10, WEBVIEW-PLATFORMS.md "Linux").
#
#   build-wpe.sh deps            print the apt packages the build needs (ubuntu-22.04, the glibc 2.35 floor)
#   build-wpe.sh [PREFIX]        fetch, verify, patch, configure, build, install, bundle (default PREFIX: ./build/wpe)
#
# Environment: WPE_WORK (scratch dir, default $PREFIX.work; tens of GB while building, removed by `clean`),
# WPE_JOBS (default nproc), WPE_KEEP_WORK=1 keeps the build tree (incremental re-runs), CC/CXX (default gcc-12/g++-12:
# WebKit 2.54 needs GCC 12.2+, jammy's gcc-12 is 12.3).
#
# Output layout (relocatable; the patch below resolves every compiled-in directory beside libWPEWebKit at run time):
#   PREFIX/lib/libWPEWebKit-2.0.so.1             WebKit + WPEPlatform (headless) in one library
#   PREFIX/lib/wpe-webkit-2.0/WPEWebProcess      helper processes, RUNPATH $ORIGIN/..
#   PREFIX/lib/wpe-webkit-2.0/WPENetworkProcess
#   PREFIX/lib/wpe-webkit-2.0/injected-bundle/libWPEInjectedBundle.so
#   PREFIX/lib/*.so.*                            bundled dependencies not guaranteed on every distro, RUNPATH $ORIGIN
#                                                (bundle-wpe.sh, re-runnable on an installed prefix without rebuilding)
#   PREFIX/lib/wpe-webkit-2.0/bwrap              Kybern's own bubblewrap, used only when the system's is refused and
#                                                Kybern's .deb gave this copy an AppArmor profile (wpe-sandbox.patch)
#   PREFIX/include, PREFIX/lib/pkgconfig         for building the companion (libkybern-webview.so)
#   PREFIX/share/licenses/                       WebKit's licence texts and each bundled library's copyright file
#   PREFIX/SOURCES.txt                           the exact upstream tarball, its checksum and our patch (LGPL source offer)
#
# The web-process sandbox (bubblewrap + xdg-dbus-proxy) uses the system's /usr/bin/bwrap and /usr/bin/xdg-dbus-proxy;
# they are not bundled. The companion checks them before creating a view and reports the web view unavailable otherwise.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/wpe-version.sh"

DEPS="gcc-12 g++-12 cmake ninja-build pkg-config perl python3 ruby gperf unifdef curl xz-utils ca-certificates patch patchelf file
libglib2.0-dev libharfbuzz-dev libicu-dev libjpeg-dev libepoxy-dev libgcrypt20-dev libsoup-3.0-dev libtasn1-6-dev
libxkbcommon-dev libxml2-dev libpng-dev libsqlite3-dev libwebp-dev zlib1g-dev libfreetype-dev libfontconfig-dev
libxslt1-dev liblcms2-dev libseccomp-dev libdrm-dev libgbm-dev bubblewrap xdg-dbus-proxy"

case "${1:-}" in
  deps) echo $DEPS; exit 0 ;;
  clean) rm -rf "${2:-$here/build/wpe}.work"; exit 0 ;;
esac

prefix=${1:-$here/build/wpe}
mkdir -p "$prefix"
prefix=$(cd "$prefix" && pwd)
work=${WPE_WORK:-$prefix.work}
jobs=${WPE_JOBS:-$(nproc)}
export CC=${CC:-gcc-12} CXX=${CXX:-g++-12}
mkdir -p "$work"
launcher=
command -v ccache >/dev/null 2>&1 && launcher="-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"

echo "== WPE WebKit $WPE_VERSION → $prefix (work $work, $jobs jobs, $CXX)"
tarball=$work/wpewebkit-$WPE_VERSION.tar.xz
if [ ! -f "$tarball" ]; then curl -fsSL -o "$tarball.part" "$WPE_URL" && mv "$tarball.part" "$tarball"; fi
echo "$WPE_SHA256  $tarball" | sha256sum -c -
src=$work/wpewebkit-$WPE_VERSION
if [ ! -f "$src/.kybern-patched" ]; then
  rm -rf "$src"
  tar -C "$work" -xf "$tarball"
  for p in "$here"/wpe-*.patch; do (cd "$src" && patch -p1 < "$p"); done
  touch "$src/.kybern-patched"
fi

# Only what Kybern's pages need. Off: the legacy libwpe API, the DRM and Wayland platforms (Kybern draws the frames
# itself through the headless platform), media (GStreamer), speech, WebXR, gamepads, accessibility (GPUI's AccessKit
# tree cannot host a foreign subtree yet), spell checking, docs, introspection, MiniBrowser, WebDriver, tests.
# shellcheck disable=SC2086
cmake -S "$src" -B "$work/build" -G Ninja $launcher \
  -DPORT=WPE -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DLIB_INSTALL_DIR="$prefix/lib" -DLIBEXEC_INSTALL_DIR="$prefix/lib/wpe-webkit-2.0" \
  -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG -g0" -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG -g0" \
  -DENABLE_WPE_PLATFORM=ON -DENABLE_WPE_PLATFORM_HEADLESS=ON -DENABLE_WPE_PLATFORM_DRM=OFF -DENABLE_WPE_PLATFORM_WAYLAND=OFF \
  -DENABLE_WPE_LEGACY_API=OFF -DENABLE_WPE_QT_API=OFF \
  -DENABLE_BUBBLEWRAP_SANDBOX=ON -DBWRAP_EXECUTABLE=/usr/bin/bwrap -DDBUS_PROXY_EXECUTABLE=/usr/bin/xdg-dbus-proxy \
  -DENABLE_DOCUMENTATION=OFF -DENABLE_INTROSPECTION=OFF -DENABLE_MINIBROWSER=OFF -DENABLE_WEBDRIVER=OFF \
  -DENABLE_API_TESTS=OFF -DENABLE_JOURNALD_LOG=OFF \
  -DENABLE_VIDEO=OFF -DENABLE_WEB_AUDIO=OFF -DENABLE_MEDIA_STREAM=OFF -DENABLE_WEB_RTC=OFF -DENABLE_ENCRYPTED_MEDIA=OFF \
  -DENABLE_SPEECH_SYNTHESIS=OFF -DENABLE_GAMEPAD=OFF -DENABLE_WEBXR=OFF -DENABLE_SPELLCHECK=OFF \
  -DUSE_ATK=OFF -DUSE_FLITE=OFF -DUSE_LIBBACKTRACE=OFF -DUSE_LIBHYPHEN=OFF -DUSE_JPEGXL=OFF -DUSE_AVIF=OFF \
  -DUSE_SYSPROF_CAPTURE=OFF -DUSE_GSTREAMER=OFF -DUSE_GSTREAMER_WEBRTC=OFF -DUSE_LCMS=ON -DENABLE_PDFJS=OFF -DUSE_GBM=ON -DUSE_LIBDRM=ON
ninja -C "$work/build" -j "$jobs"
rm -rf "$prefix"/lib "$prefix"/include "$prefix"/share "$prefix"/bin "$prefix"/libexec
ninja -C "$work/build" install

"$here/bundle-wpe.sh" "$prefix"

# WebKit's own licence texts (bundle-wpe.sh adds each bundled library's).
lic=$prefix/share/licenses
mkdir -p "$lic/wpewebkit"
find "$src/Source" -maxdepth 3 \( -name 'LICENSE*' -o -name 'COPYING*' \) -type f | while read -r f; do
  cp "$f" "$lic/wpewebkit/$(echo "${f#$src/Source/}" | tr / _)"
done
rm -rf "$prefix/share/wpe-webkit-2.0" "$prefix/bin"
[ "${WPE_KEEP_WORK:-0}" = 1 ] || rm -rf "$work"
echo "== installed: $(du -sh "$prefix" | cut -f1) ($(du -sh "$prefix/lib" | cut -f1) in lib)"
ls -la "$prefix/lib" | head -60
