#!/bin/sh
# L-S2/L-S3 on a CI runner: run offscreen.c against the private WPE build (native/wpe/build-wpe.sh) as an ordinary
# user, with WebKit's bubblewrap sandbox on, three ways: from a plain folder, from an AppImage mounted with FUSE, and
# from an AppImage extracted and run (APPIMAGE_EXTRACT_AND_RUN). Prints the kernel's user-namespace policy first.
#   ci-sandbox.sh <wpe prefix> <out dir>     (APPIMAGETOOL and APPIMAGE_RUNTIME for the AppImage runs)
set -u
here=$(cd "$(dirname "$0")" && pwd)
prefix=$(cd "$1" && pwd)
out=$2
mkdir -p "$out"
out=$(cd "$out" && pwd)
. /etc/os-release
echo "== $PRETTY_NAME, kernel $(uname -r)"
for key in kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone user.max_user_namespaces; do
  printf '%s = %s\n' "$key" "$(sysctl -n "$key" 2>/dev/null || echo n/a)"
done
ls -la /usr/bin/bwrap /usr/bin/xdg-dbus-proxy 2>&1
/usr/bin/bwrap --version 2>&1 || true
ls /etc/apparmor.d/ 2>/dev/null | grep -iE 'bwrap|userns|unpriv' || echo "no bwrap/userns AppArmor profile"
echo "== bwrap smoke (unprivileged user namespace)"
/usr/bin/bwrap --unshare-all --ro-bind / / --dev /dev true && echo "bwrap smoke ok" || echo "bwrap smoke FAILED"

app=$out/AppDir
rm -rf "$app"
mkdir -p "$app/lib"
cp -a "$prefix/lib/." "$app/lib/"
rm -rf "$app/lib/pkgconfig"
PKG_CONFIG_PATH=$prefix/lib/pkgconfig gcc -O1 -o "$app/offscreen" "$here/offscreen.c" -Wl,-rpath,'$ORIGIN/lib' \
  $(PKG_CONFIG_PATH=$prefix/lib/pkgconfig pkg-config --cflags --libs wpe-webkit-2.0 wpe-platform-2.0 wpe-platform-headless-2.0)
printf '#!/bin/sh\ncd "${OWD:-$PWD}"\nexec "$(dirname "$0")/offscreen" "$@"\n' > "$app/AppRun"
chmod +x "$app/AppRun"
printf '[Desktop Entry]\nType=Application\nName=wpe-spike\nExec=offscreen\nIcon=wpe-spike\nCategories=Development;\nTerminal=true\n' > "$app/wpe-spike.desktop"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>' > "$app/wpe-spike.svg"
echo "== ldd (libraries resolved outside the bundle)"
ldd "$app/lib/libWPEWebKit-2.0.so.1" | grep -v "$app" | awk '{print "  " $1 " => " $3}'
ldd "$app/lib/libWPEWebKit-2.0.so.1" | grep "not found" && echo "MISSING LIBRARIES"

status=0
run() {
  label=$1; shift
  echo "== $label"
  (cd "$out" && timeout 60 "$@" > "$out/$label.log" 2>&1); code=$?
  grep -E '^CHECK|bwrap|ERROR|rror' "$out/$label.log" | head -20
  echo "exit $code"
  if ! grep -q '^CHECK sandbox ok' "$out/$label.log" || ! grep -q '^CHECK input ok' "$out/$label.log"; then
    status=1
    echo "-- last lines of $label.log"; tail -25 "$out/$label.log"
  fi
  [ -f "$out/frame.pam" ] && mv "$out/frame.pam" "$out/$label.pam"
}
run folder "$app/offscreen"
# Ubuntu 23.10+: the profile Kybern's .deb installs (packaging/linux/kybern-gpuix-bwrap.apparmor) for its own bwrap,
# and WebKit switched to that copy in-process (webkit_kybern_sandbox_hardened, wpe-sandbox.patch).
own=$app/lib/wpe-webkit-2.0/bwrap
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ -x "$own" ] && [ -e /etc/apparmor.d/abi/4.0 ]; then
  echo "== AppArmor profile for $own"
  sed "s#@BWRAP@#$own#" "$here/../../../../packaging/linux/kybern-gpuix-bwrap.apparmor" | sudo tee /etc/apparmor.d/kybern-gpuix-bwrap >/dev/null
  sudo apparmor_parser -r -T -W /etc/apparmor.d/kybern-gpuix-bwrap && echo "profile loaded"
  "$own" --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc true && echo "own bwrap smoke ok" || echo "own bwrap smoke FAILED"
  run folder-own-bwrap env SPIKE_BUNDLED_BWRAP=1 WEBKIT_DEBUG=Process,Loading "$app/offscreen"
  bundled="env SPIKE_BUNDLED_BWRAP=1"
fi
# wpe-sandbox.patch: WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS is ignored (the web process is still sandboxed), and
# where upstream would run the web process unsandboxed (a Snap's environment) Kybern's WebKit aborts before spawning it.
run dangerous-env-ignored ${bundled:-} WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 "$app/offscreen"
echo "== snap-env-refused"
(cd "$out" && timeout 60 env ${bundled:-} SNAP=/snap/code/200 SNAP_NAME=code SNAP_REVISION=200 "$app/offscreen" > "$out/snap-env-refused.log" 2>&1); code=$?
grep -E '^CHECK|Kybern' "$out/snap-env-refused.log" | head
echo "exit $code"
if [ "$code" = 0 ] || ! grep -q 'refusing to start a WebKit process without its sandbox' "$out/snap-env-refused.log" || grep -q '^CHECK frame' "$out/snap-env-refused.log"; then
  status=1; echo "FAIL a Snap environment must abort before any web process starts"; tail -25 "$out/snap-env-refused.log"
else echo "PASS a Snap environment aborts before any web process starts"; fi
if [ -n "${APPIMAGETOOL:-}" ] && [ -n "${APPIMAGE_RUNTIME:-}" ]; then
  ARCH=x86_64 "$APPIMAGETOOL" --runtime-file "$APPIMAGE_RUNTIME" -n "$app" "$out/wpe-spike.AppImage" > "$out/appimagetool.log" 2>&1 || { tail "$out/appimagetool.log"; status=1; }
  ls -la "$out/wpe-spike.AppImage"
  run appimage-fuse "$out/wpe-spike.AppImage"
  run appimage-extract env APPIMAGE_EXTRACT_AND_RUN=1 "$out/wpe-spike.AppImage"
fi
du -sh "$prefix" "$prefix/lib" "$out/wpe-spike.AppImage" 2>/dev/null
exit $status
