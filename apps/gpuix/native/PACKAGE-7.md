# Native package 7: Markdown links and backdrop filters

Worktree `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`.
Fast-forwarded `feat/gpuix-mvp` to `3e1f5240`. Changes are uncommitted. No push,
rebase, stash or branch switch. All implementation is in `native/**`,
`src/native/**`, and the existing native npm patch. `pnpm` automatically refreshed
`pnpm-lock.yaml`'s patch hash; this generated change must accompany integration.
No app source outside `src/native` was directly edited.

## APIs

- `theme.markdown.link = {color?, underline?: 'none'|'always'|'hover', weight?}`.
  Works through the round-5 theme API. Existing defaults are unchanged. Native
  link ranges and click callbacks remain independent of styling, including mixed
  inline-code flow. Hover uses event-driven repaint, not a timer.
- `backdrop = {blur?, saturation?, radius?, fadeTop?}` on ordinary host elements
  or on **`anchored` itself**. Pixels are logical; blur clamps to 0–64, saturation
  to 0–3 (default 1), fadeTop to 0–1. FadeTop is the fraction of height over which
  a caption filter ramps from transparent to full strength. Radius clips the
  filtered rectangle. Generic ancestors still supply the rectangular content mask.
- An explicit anchored `{blur:0}` suppresses its legacy opaque default backing
  without filtering. A child filter beneath the old backing would not see the
  transcript, so the API deliberately filters inside the deferred anchored layer.
- `src/native/backdrop.ts` contains types/presets; `backdrop-material.ts` supplies
  app preference and reduced-transparency/contrast gating for the unapplied patch.

## Renderer approach and bounds

Source inspection found GPUI shadow blur and whole-window vibrancy, but no
scene-local backdrop primitive. GPUIX paints its content in one Metal layer, so
an NSVisualEffectView could not be correctly inserted between an earlier transcript
and later GPUI children. The implemented path adds a GPUI scene primitive and
Metal render-pass boundary. It samples the target already painted behind the
surface, runs a cropped horizontal Gaussian pass, then paints a vertical pass
with saturation, rounded clipping, content mask, fade and inherited opacity.
Only afterwards are the surface fill and children painted.

This uses two 49-tap separable passes with a 3-sigma sampling halo. A hard draw-order
barrier prevents batch sorting from moving earlier glyphs after the filter.
Cached scene replay re-inserts the primitive in the current scene; background
changes are not frozen into a screenshot. There is no CPU readback or OS capture
in the rendering path. The screenshot calls below are verification only.

One scratch texture is reused across surfaces/frames on the renderer's ordered
command queue. It grows to the largest visible cropped region, bounded by the
window render target, and is released when no filters remain. Compiled shader
pipelines stay cached for the window lifetime. No new timer or repaint loop exists.
Offscreen/unmounted/zero-opacity filters emit no primitive. If another part of the
window causes a frame, visible filters are recomputed; this is not region-damage
tracking or a cross-frame filtered-texture cache.

The extension is macOS Metal-only. It samples GPUI scene pixels, not other windows
or wallpaper behind NSVisualEffectView. General subtree blur, arbitrary CSS filter
strings and arbitrary mask images are not implemented. The opacity ramp is the
specific mask needed by the live caption. Gaussian sampling and text rasterization
are approximations, not a pixel-identical implementation of WebKit's filters.

`patches/backdrop_gpui.py` reconstructs the GPUI edits from its pinned submodule
HEAD. `update.sh` applies them alongside GPUIX hooks, reuses the same target,
repairs LINKEDIT, signs and load-checks the binary. No dependency was added.

## Desktop audit and app patch

`BACKDROP-AUDIT.md` lists every desktop backdrop selector and exact filter values.
The audit corrects two assumptions: dialogs have no blur by default but get
16px/125% under full translucency; the command palette has no backdrop filter.
Only live-view caption/controls and preview header should filter, not the whole
image or an idle floating pane.

`app-integration-7.patch` is **unapplied** and changes nine files:

1. `composer/Menu.tsx`: `PopupLayer` filters once on the anchored layer; full
   translucency supplies 16px/125% and 78% fill. Explicit `material="none"` opts out.
2. `nav/overlay.tsx`: dim backdrop opts out; dialogs follow translucency; palette
   variant opts out.
3. `nav/Palette.tsx`: documents the deliberate opaque/no-filter path.
4. `split/Workspace.tsx`: drop target 18px/125%; label 18px/140%, mounted only on drag.
5. `live/Floating.tsx`: transparent anchored backing, no whole-image filter.
6. `live/ComputerLiveView.tsx`: 10px caption with half-height fade; 12px controls
   only while hovered.
7. `preview/Preview.tsx`: 12px/140% on its visible metadata-card header only.
8. `transcript/kit.tsx`: token link color and hover underline.
9. `notes/NoteBlock.tsx`: token link color and always underline.

Clean apply and in-memory TypeScript checks pass. App integration remains the
parent's step; no claim is made that the unapplied app changes ran in the full app.
The native preview remains a browser-launch metadata card, not an embedded browser.
Reduced-transparency/contrast OS settings are read at launch; app translucency is
reactive. Live OS accessibility changes require relaunch, like the existing native
reduced-motion setting.

The requested three link controls do not implement separate active link color,
keyboard focus-visible decoration, from-font underline thickness, or Notes' 35%
underline tint. Native underlines are 1 logical pixel. These remaining details
are explicit in the audit, rather than claimed as full CSS parity.

## Visual evidence

All final artifacts are in `/Users/mymac/projects/ade/previews/gpuix/p1g/`:

- `surface-{dark,light}-{tauri,gpuix,pair,diff}.png`: 728×600 logical, 2×.
- `links-{dark,light}-{tauri,gpuix,pair,diff}.png`: 728×420 logical, 2×.
- Hover, scroll, hidden, filter-off and clipped/saturation/fade capability captures.

The reference imports the real desktop Markdown component, `kit.css` and
`kybern.css`. Playwright WebKit's **page snapshot omitted compositor backdrop
filters** despite the correct computed style, both headless and headed. The
reference runner therefore starts its own headed WebKit, resolves only that
process tree's window ID, takes `screencapture -l`, and crops out the browser
chrome to the exact viewport. No full-screen capture or user's app window is used.
Those compositor captures show real blur and are the accepted surface reference
pairs. The link-only lab uses ordinary WebKit page screenshots because it has no
backdrop effects; these also avoid browser-window corner masks.

Reviewed both appearance pairs. Surface placement, rounded bounds, background
softening and sharp foreground/link styling match closely. Small glyph/line-height
and underline-position differences remain. WebKit window captures also contain
its bottom window-corner mask. Diff diagnostics use 24/255 per channel and include
large blank areas; they are not a percentage score for parity.

## Validation

The final signed binary passed `native/update.sh` end to end:

- All six original native scripts; original dark/light input, selection, font and
  virtual-row capabilities; decoration and rounded-background checks.
- Markdown grid, code-wrap, Unicode selection, paragraph search and large document.
- Diff layout, context-line clicks, bounded expansion and 30,000-line paint.
- New backdrop dark/light pixel checks, per-link clicks and hover paint; generic
  rounded bounds, ancestor clipping, opacity zero, saturation-only, cached filter
  and caption fade assertions.
- New links: none/always/hover pixel differences, first/second URL dispatch and
  link activation through mixed inline-code layout in both appearances.
- Layout, syntax every-boundary pixel comparisons, lifecycle/revision/Unicode
  checks, and four mounted rows from a 70,003-line document.
- Scratch-daemon `combined-pointer-check.ts`: Settings pointer and Space, sidebar,
  dock entrance, Notes tab and collapse; two standalone spring tests.
- App and native fixture typechecks; `bun test ./src`: **43 passed, 402 assertions**.
- Unapplied patch clean-apply and virtual TypeScript checks; `git diff --check`.

Every successful rebuild completed the existing capability suite and scratch
pointer check before the next rebuild. Earlier iterations fixed Rust type errors,
a helper filename collision, and a fixture assumption about painted-text inspection
for cached deferred overlays. The final uninterrupted log is
`native/build/surface-build-final.log`. The separate physical drag/AX/real-IME
checks remain permission-dependent manual checks as in previous packages.

## Performance

Apple M1, macOS 27, Bun 1.4.0, GPUIX 0.10.0. Two independent launches per binary,
each **10 seconds warmup + 15 seconds sampling**, 728×600 background window.
Sample 1 is settled; sample 2 scrolls a synthetic 60-row transcript under the open
380×260 floating dialog (16px blur / 125% saturation) with 33ms wheel steps.
The legacy fixture mode preserves the original pre-change row/text layout for
before/after measurement; the visual lab uses cleaner single-string rows.
This is a native capability workload, not the full app's virtual transcript.

| Condition | CPU | Footprint | Metal time / 15s |
| --- | ---: | ---: | ---: |
| Before idle | 1.67% | 134 MiB | 0.0 ms |
| After idle | 1.60% | 138 MiB | 0.0 ms |
| Before scrolling | 18.73% | 143 MiB | 87.3 ms |
| After scrolling | 13.87% | 152 MiB | 690.8 ms |

Idle CPU is similar; footprint rises 4 MiB. While scrolling, filtering adds
**603.5 ms of reported Metal time per 15-second sample** (87.3 → 690.8 ms,
about 7.9× this workload's baseline GPU time) and 9 MiB footprint. The CPU
reduction is retained as measured, not attributed as a proven speedup. The GPU
cost is real; do not describe this as free glass or an energy improvement.

CPU is process CPU-time delta, memory is physical footprint, GPU is reported
per-process Metal time. Rounded 0.0ms is not proof of no GPU activity or an energy
measurement. Other system/agent work and window occlusion limit precision.
No frame-interval, React commit, input-latency, power or energy claim is made.

## Binary and cleanup

Binary: `/Users/mymac/projects/ade-gpuix-native/apps/gpuix/native/build/gpuix-native.darwin-arm64.node`

SHA-256: `a5b2f882a93da1a08cca9038e882128ecfe821c1cdd35d24b5c15fa3463c8f10`.

Disk free **60 GiB before**, **58 GiB** at handoff; always above 30 GiB.
Retained for the parent's explicitly requested incremental integration/builds:
`native/build` 1.9 GiB, upstream 185 MiB, existing dependencies. Removed the unused 20 MiB intermediate pnpm patch copy after checking it had no
open files. The 35 MiB Vite cache predates this task and is retained. No extra Rust
output directory, daemon build, simulator or dependency was added. Scratch
fixtures stop their own daemons and remove their data. The task's WebKit server
and browser processes are stopped after captures. User app/data, port 4219 and
normal `~/.kybern` were untouched. No commit.
