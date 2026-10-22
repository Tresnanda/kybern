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
  # Edge fades (patches/edge_fade.rs, N3): alpha ramps, nesting, insets, scroll and retained translation.
  bun native/edge-fade-check.ts
  # Half-resolution wide backdrops (N2) against an exact Gaussian.
  bun perf/backdrop/halfres-check.ts
  bun native/subtree-translation-check.ts
  KYBERN_REGION_PAINT=1 bun native/subtree-translation-check.ts
  bun native/subtree-transform-check.ts
  KYBERN_REGION_PAINT=1 bun native/subtree-transform-check.ts
  bun native/font-weight-check.ts
  bun native/stroke-draw-check.ts
  # Paint-only hover colour fades (patches/hover_fade_*): dark, light, Reduce Motion, KYBERN_HOVER_FADE=0.
  bun native/hover-fade-check.ts
  # Rings that ease between values (stroke_draw from/to/retarget, N2).
  bun native/ring-check.ts
  # Compositor loops (patches/compositor_loops_*): CA layers, curves, hand-back; and the scene path control.
  bun perf/motion-fps/lab-check.ts
  bun perf/motion-fps/lab-check.ts --light
  bun perf/motion-fps/lab-check.ts --reduced
  KYBERN_COMPOSITOR_LOOPS=0 bun perf/motion-fps/lab-check.ts
  ;;
content)
  bun native/markdown-check.ts
  bun native/markdown-document-check.ts
  bun native/markdown-document-cost-check.ts
  bun native/diff-check.ts
  bun native/surface-check.ts
  bun native/link-check.ts
  # A multi-word link hovers as one link (link_hover_hooks.py).
  bun native/link-hover-check.ts
  # Embedded web documents: input, navigation policy, identity, and the Core Animation fade/scale (N3).
  bun native/webview-check.ts
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
  # Tab is a window default in 0.11: one move per press, a consumed Tab stays, the preview traps it.
  bun native/focus-check.ts
  ;;
*) echo "unknown native check batch: $1" >&2; exit 2 ;;
esac
