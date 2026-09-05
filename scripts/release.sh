#!/usr/bin/env bash
# Cut a release: bump every version file in lockstep, commit, tag, push.
#
# Usage: scripts/release.sh <version>        e.g. scripts/release.sh 0.2.0
#        scripts/release.sh <version> --no-push   stop after the local commit and tag
#
# Pushing the tag starts .github/workflows/release.yml: dist builds kybernd and
# kybern for every target and creates the GitHub Release, then desktop.yml adds
# the desktop bundles and latest.json. See docs/releasing.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
PUSH=1
for arg in "${@:2}"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "usage: scripts/release.sh <major.minor.patch[-prerelease]> [--no-push]" >&2
  exit 2
fi
TAG="v$VERSION"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "the working tree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi
if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "release from main (currently on $(git rev-parse --abbrev-ref HEAD))" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag $TAG already exists" >&2
  exit 1
fi

CURRENT="$(grep -m1 '^version = ' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
echo "==> $CURRENT -> $VERSION"

# Cargo.toml [workspace.package] (every crate inherits it), the Tauri bundle
# version (what the updater compares against latest.json), and package.json.
VERSION="$VERSION" python3 - <<'PY'
import json, os, re
version = os.environ["VERSION"]

path = "Cargo.toml"
text = open(path).read()
text, n = re.subn(r'^version = "[^"]+"', f'version = "{version}"', text, count=1, flags=re.M)
assert n == 1, "workspace version not found in Cargo.toml"
open(path, "w").write(text)

for path in ("apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/package.json"):
    data = json.load(open(path))
    data["version"] = version
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY
cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null

git add Cargo.toml Cargo.lock apps/desktop/src-tauri/tauri.conf.json apps/desktop/package.json
git commit -q -m "release: $TAG"
git tag -a "$TAG" -m "kybern $TAG"
echo "==> committed and tagged $TAG"

if [[ "$PUSH" == "1" ]]; then
  git push origin main "$TAG"
  echo "==> pushed; follow the release at https://github.com/Tresnanda/kybern/actions"
else
  echo "==> not pushed; run: git push origin main $TAG"
fi
