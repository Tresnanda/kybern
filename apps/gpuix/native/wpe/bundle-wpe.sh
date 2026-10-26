#!/bin/sh
# The packaging half of build-wpe.sh, re-runnable on an installed WPE prefix (CI restores a cached build and runs
# only this, so changing what is bundled never rebuilds WebKit). Run on the build floor (ubuntu-22.04):
#   bundle-wpe.sh PREFIX
# - copies every library libWPEWebKit, the helper processes and the injected bundle link that a desktop distro may
#   lack (or ship under another soname) into PREFIX/lib, with RUNPATH $ORIGIN (helpers $ORIGIN/..); strips them;
# - copies /usr/bin/bwrap to PREFIX/lib/wpe-webkit-2.0/bwrap (Kybern's own copy for an AppArmor profile, see
#   apps/gpuix/scripts/package-linux.ts) with its licence;
# - records each bundled library's Debian copyright file in PREFIX/share/licenses and writes PREFIX/SOURCES.txt with
#   the exact Ubuntu package and version each bundled file came from (the source offer, THIRD_PARTY_NOTICES.md).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
prefix=$(cd "$1" && pwd)
lib=$prefix/lib
pkg=$lib/wpe-webkit-2.0
. "$here/wpe-version.sh"
# Present on every desktop distro Kybern supports with a stable soname, or that must be the system's own (GLib's type
# registry, the GPU drivers, glibc, Kerberos). Everything else is copied in: libunistring and libidn2 are, because
# jammy's libpsl needs libunistring.so.2 and Ubuntu 24.04 has only .so.5.
system='^(ld-linux.*|libc|libm|libdl|libpthread|librt|libresolv|libutil|libstdc\+\+|libgcc_s|libglib-2\.0|libgobject-2\.0|libgio-2\.0|libgmodule-2\.0|libgthread-2\.0|libz|libfontconfig|libfreetype|libexpat|libuuid|libmount|libblkid|libselinux|libpcre2-8|libffi|libdrm|libgbm|libEGL|libGL|libGLX|libGLdispatch|libOpenGL|libwayland-.*|libxkbcommon|libgcrypt|libgpg-error|libbz2|liblzma|libzstd|libbrotlicommon|libbrotlidec|libpng16|libX11|libxcb.*|libXau|libXdmcp|libcap|libudev|libsystemd|liblz4|libgnutls|libnettle|libhogweed|libgmp|libp11-kit|libtasn1|libkeyutils|libkrb5.*|libk5crypto|libcom_err|libgssapi_krb5|libsqlite3|libharfbuzz|libgraphite2)\.so'
copy_deps() {
  ldd "$1" | awk '/=> \//{print $1" "$3}' | while read -r name path; do
    if echo "$name" | grep -Eq "$system"; then continue; fi
    case "$path" in "$prefix"/*) continue ;; esac
    if [ ! -f "$lib/$name" ]; then cp -L "$path" "$lib/$name"; copy_deps "$lib/$name"; fi
  done
}
for f in "$lib"/libWPEWebKit-2.0.so.1 "$pkg"/WPEWebProcess "$pkg"/WPENetworkProcess "$pkg"/injected-bundle/*.so; do copy_deps "$f"; done
for f in "$lib"/*.so*; do [ -L "$f" ] || patchelf --set-rpath '$ORIGIN' "$f"; done
patchelf --set-rpath '$ORIGIN/..' "$pkg"/WPEWebProcess "$pkg"/WPENetworkProcess
[ -e "$pkg"/WPEGPUProcess ] && patchelf --set-rpath '$ORIGIN/..' "$pkg"/WPEGPUProcess
for f in "$pkg"/injected-bundle/*.so; do patchelf --set-rpath '$ORIGIN/../..' "$f"; done
# The .pc files name the build machine's prefix; make them relative to where they sit (pkg-config and pkgconf).
for pc in "$lib"/pkgconfig/*.pc; do
  built=$(sed -n 's/^prefix=//p' "$pc")
  case "$built" in /*) sed -i -e "/^prefix=/!s|$built|\${prefix}|g" -e 's|^prefix=.*|prefix=${pcfiledir}/../..|' "$pc" ;; esac
done
cp /usr/bin/bwrap "$pkg/bwrap"
chmod 755 "$pkg/bwrap"
find "$prefix" -type f \( -name '*.so*' -o -perm -u+x \) -exec sh -c 'file -b "$1" | grep -q ELF && strip --strip-unneeded "$1"' _ {} \;

lic=$prefix/share/licenses
mkdir -p "$lic"
packages=$(mktemp)
for f in "$lib"/*.so.* "$pkg/bwrap"; do
  [ -L "$f" ] && continue
  case "$(basename "$f")" in libWPEWebKit-2.0.so*) continue ;; esac
  source=/usr/bin/bwrap
  [ "$f" = "$pkg/bwrap" ] || source=$(ldconfig -p | awk -v n="$(basename "$f")" '$1==n{print $NF; exit}')
  owner=
  # dpkg records a file under one of its usrmerge aliases (/lib or /usr/lib), and ldconfig may name a symlink.
  for candidate in "$source" "$(readlink -f "$source")" "/usr$source" "${source#/usr}"; do
    owner=$(dpkg -S "$candidate" 2>/dev/null | cut -d: -f1 | head -1) || true
    [ -n "$owner" ] && break
  done
  if [ -z "$owner" ]; then
    echo "bundle-wpe.sh: WARNING no Ubuntu package owns $source ($(basename "$f")); SOURCES.txt says so" >&2
    printf '  %s: from %s, package unknown\n' "${f#$prefix/}" "$source" >> "$packages"
    continue
  fi
  version=$(dpkg-query -W -f='${Version}' "$owner")
  source_package=$(dpkg-query -W -f='${source:Package} ${source:Version}' "$owner")
  printf '  %s: %s %s (source %s)\n' "${f#$prefix/}" "$owner" "$version" "$source_package" >> "$packages"
  [ -f "/usr/share/doc/$owner/copyright" ] && cp "/usr/share/doc/$owner/copyright" "$lic/$owner.copyright"
done
cat > "$prefix/SOURCES.txt" <<SOURCES
WPE WebKit $WPE_VERSION, built by apps/gpuix/native/wpe/build-wpe.sh in the Kybern repository.
Source: $WPE_URL
SHA-256: $WPE_SHA256
Kybern patches: apps/gpuix/native/wpe/wpe-relocatable.patch (resolves LIBDIR/PKGLIBDIR/PKGLIBEXECDIR beside the
library), wpe-sandbox.patch (never starts a web process without its sandbox, ignores
WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS, no audio or camera binds, an in-process switch to Kybern's bubblewrap) and
wpe-gcc12.patch (one ANGLE static_assert GCC 12 evaluates in a discarded branch).
Bundled libraries and lib/wpe-webkit-2.0/bwrap (bubblewrap) come from these Ubuntu 22.04 packages; their sources are
the matching source package versions at https://launchpad.net/ubuntu/jammy (licences in share/licenses):
$(sort "$packages")
SOURCES
rm -f "$packages"
cat "$prefix/SOURCES.txt"
echo "== bundled: $(du -sh "$prefix" | cut -f1) ($(du -sh "$lib" | cut -f1) in lib)"
