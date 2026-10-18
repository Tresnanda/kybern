#!/bin/sh
# Each bounded batch owns its UI lease; the caller sets the native addon path.
set -eu
case "$1" in
geometry)
  for check in island-check island-overlay-check native-check secure-input-check code-wrap-check native-motion-check; do
    bun "scripts/$check.ts"
  done
  pnpm exec tsc -p native/tsconfig.json
  bun native/paint-check.ts
  bun native/capability-check.ts
  bun native/decoration-check.ts
  bun native/rounded-check.ts
  bun native/subtree-translation-check.ts
  KYBERN_REGION_PAINT=1 bun native/subtree-translation-check.ts
  bun native/subtree-transform-check.ts
  KYBERN_REGION_PAINT=1 bun native/subtree-transform-check.ts
  bun native/font-weight-check.ts
  bun native/stroke-draw-check.ts
  ;;
content)
  bun native/markdown-check.ts
  bun native/markdown-document-check.ts
  bun native/diff-check.ts
  bun native/surface-check.ts
  bun native/link-check.ts
  for check in layout-check syntax-check syntax-lifecycle-check syntax-large-check; do
    bun "native/$check.ts"
  done
  bun native/fixture.ts bun scripts/combined-pointer-check.ts
  ;;
input)
  bun native/clip-check.ts
  bun native/explorer-motion-check.ts
  bun native/scroll8-check.ts
  bun native/scroll8-input-check.ts
  ;;
*) echo "unknown native check batch: $1" >&2; exit 2 ;;
esac
