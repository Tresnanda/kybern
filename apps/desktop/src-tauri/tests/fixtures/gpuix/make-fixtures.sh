#!/bin/sh
# Regenerates the throwaway keys, archives and signatures the gpuix_install
# tests use. Nothing here is a real release key; the private keys are deleted.
# Run from apps/desktop after `pnpm install`:  sh src-tauri/tests/fixtures/gpuix/make-fixtures.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$HERE/../../../../node_modules/@tauri-apps/cli/tauri.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

plist() {
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>%s</string>\n</dict></plist>\n' "$1"
}
bundle() { # id out
  mkdir -p "$WORK/$2/Kybern GPUIX.app/Contents/MacOS"
  plist "$1" > "$WORK/$2/Kybern GPUIX.app/Contents/Info.plist"
  printf '#!/bin/sh\n' > "$WORK/$2/Kybern GPUIX.app/Contents/MacOS/kybern-gpuix"
  (cd "$WORK/$2" && COPYFILE_DISABLE=1 tar -czf "$HERE/$2.app.tar.gz" "Kybern GPUIX.app")
}
bundle dev.kybern.gpuix good
bundle dev.example.other wrongid

node "$CLI" signer generate --ci -p '' -w "$WORK/updater.key" >/dev/null
node "$CLI" signer generate --ci -p '' -w "$WORK/other.key" >/dev/null
for name in good wrongid; do
  cp "$HERE/$name.app.tar.gz" "$WORK/$name.app.tar.gz"
  node "$CLI" signer sign -f "$WORK/updater.key" -p '' "$WORK/$name.app.tar.gz" >/dev/null
  cp "$WORK/$name.app.tar.gz.sig" "$HERE/$name.app.tar.gz.sig"
done
cp "$WORK/updater.key.pub" "$HERE/updater.key.pub"
cp "$WORK/other.key.pub" "$HERE/other.key.pub"
