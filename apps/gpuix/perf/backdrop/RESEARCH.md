# Backdrop research and surface decisions

Research precedes native changes. Read-only clones: Zed `56934ec0560bce8929025497411de7f5322fb6ca`,
Zeron `c526d6f7cfc7a53e5588e3e6c5df7484a14d649f`, Zeron's pinned ZUI
`361ff20b919fdfb80199ee6d9aed725300cb7d54`. Context7 library resolution and
`/websites/rs_gpui` docs corroborate the public `WindowBackgroundAppearance`
contract; implementation conclusions below come from the actual clones.

## What the references actually do

- Zed distinguishes opaque / plain transparent / blurred windows. On macOS,
  changing the mode updates both the Metal layer opacity and NSWindow opacity;
  blurred mode adds a behind-window `NSVisualEffectView`, below the content view.
  [window.rs:1866–1903](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_macos/src/window.rs#L1866).
  The view uses `UnderWindowBackground`, `BehindWindow`, `Active`; Zed strips
  the material tint and saturation when its layer updates.
  [window.rs:3808–3873](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_macos/src/window.rs#L3808).
  `Transparent` alone supplies alpha, not blur. The Metal renderer sets
  `CAMetalLayer.opaque` to the inverse of transparency.
  [metal_renderer.rs:509](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_apple/src/metal_renderer.rs#L509).
- The CGS radius lead is version-specific, not the current Zed clone's path.
  Zeron's **pinned ZUI** retains `CGSSetWindowBackgroundBlurRadius(80)` before
  macOS 12 and the effect view thereafter, explicitly mentioning compositor
  downsampling. [ZUI window.rs:1664–1722](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L1664).
  These move behind-window work out of the app's Metal command buffers; they
  do **not** establish zero WindowServer GPU cost or zero system energy.
- Zeron paints the shell/sidebar over one native desktop blur with a shared
  theme tint (`theme.glass()` / `.bg(frost)`).
  [shell.rs:13434](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/shell.rs#L13434),
  [shell.rs:13590](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/shell.rs#L13590).
  Its theme chooses Blurred for glass, Opaque otherwise (Linux uses alpha for
  rounded corners). [theme.rs:1130](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/theme.rs#L1130).
- **Zeron also does in-app blur.** Floating menus/composer use 16px scene blur,
  then shadow/tint/border/content in one ordered layer.
  [frost.rs:1–20,82–93](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/frost.rs#L1).
  Its theme explicitly separates scene frost from window vibrancy.
  [theme.rs:915](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/theme.rs#L915).
  Thus “Zeron only uses flat fills” is false.
- ZUI snapshots the visible region plus 3-sigma halo, invokes a cached native
  MPS Gaussian kernel, then composites the result in draw order.
  [metal_renderer.rs:1000–1106](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L1000).
  Scratch allocation reuse is quantized to 64px extents, bounded at four pairs
  / 32MiB (one oversized pair allowed), with release after blur-free frames.
  [metal_renderer.rs:1357–1448](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L1357).
  This caches **resources/kernels**, not stale backdrop pixels. Each draw still
  snapshots current content. Reusing old pixels while text scrolls beneath is wrong.
- Zed shadows are not framebuffer blur: a `Shadow` instance carries bounds,
  corner radii, color and radius; the fragment shader integrates a rounded-rect
  Gaussian analytically along x with four y samples. Zero radius uses the shape
  distance. [scene.rs:574](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/scene.rs#L574),
  [shaders.metal:461–543](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_apple/src/shaders.metal#L461).
  Shadows batch as instanced quads; their blur radius expands fragment area,
  not the number of full framebuffer-filter passes.

## GPUIX inventory and decisions

The app already installs desktop `UnderWindowBackground` vibrancy in
`src/native/material.ts`; `src/platform/material.ts` owns opacity/accessibility.
No new NSView layer can blur **in-app** Metal text below a popup without splitting
that content into compositor layers. A behind-window effect blurs the desktop.

| Surface / current callsite | Desktop source / look | Decision |
|---|---|---|
| Window frame, rail, sidebar, title bar | `kit.css:120,174,465`; `lib/kit/theme/theme.logic.ts:812–821` explicitly sets sidebar CSS filter to none over Tauri vibrancy | (a) Existing native under-window material plus theme fills; no scene blur to remove. Preserve. |
| Workspace/dock/settings planes | `kybern.css:582–618` translucent theme fills | (a)/(d) Existing shared compositor material and plane fills. No extra pass. Opaque/accessibility retains flat fills. |
| Composer body (`src/composer.tsx:565`) | `kit.css:2838–2892`, `kybern.css:611–615,647–658` | Current GPUIX has fill/shadow and no scene backdrop. Preserve existing behavior; full-translucency composer parity is a pre-existing gap, not a performance win. |
| PopupLayer menus, dialogs, pickers (`src/composer/Menu.tsx:141`) | `kit.css:2946–2956`, `kybern.css:621–623` | (c) Keep one scene blur with existing sigma/tint/order; compositor cannot sample underlying Metal scene. Large sigma retains all 49 positions with precomputed Gaussian weights. (d) Existing accessibility/full-translucency gate removes pass. |
| Command palette (`src/nav/overlay.tsx:884`) | Desktop palette has no backdrop filter | (d) Explicit `material="none"`; preserve fill and separate content entrance blur. |
| Split drop target + label (`src/split/Workspace.tsx:267–276`) | `kybern.css:133,158` | (c) Preserve intentional separate visible surfaces; each samples live content. (d) Existing accessibility disables blur. |
| Computer live hover controls (`src/live/ComputerLiveView.tsx:74`) | `kybern.css:445` | (c) Keep one live scene filter; hover and accessibility gates remain. |
| Preview mini header (`src/preview/MiniChrome.tsx:15`) | `kit.css:3785,3811` | (c) Keep scene filter over moving preview; accessibility fallback remains. |
| Toast anchors (`src/shell/toasts.tsx:319`) | Desktop Sonner popover fill + `.t-toast` entrance blur | (d) `{blur:0}` only suppresses legacy anchored backing. No material blur pass; paintTransform entrance/exit blur is content animation and remains. |
| Floating live anchor (`src/live/Floating.tsx:66`) | Floating preview | (d) `{blur:0}` is transparent backing opt-in, not active filtering. |
| Per-word stream fades (`native/patches/stream_fade_window.rs:34`) | `.t-stream-w`: filter blur(1px) → 0 | (c) Exact dense-kernel reconstruction for device sigma <=8; 49 taps become <=25 (typically <=7 for Retina word blur). Preserve two-pass order, sigma, opacity, clip, timing. |
| Subtree animation blur (`subtree_transform*`) | `.t-toast`, pop/entrance filters | (c) Same exact narrow kernel where eligible. Broad radii retain all original sample positions. |
| `BACKDROP.popup`/`liveScrim` definitions | Reserved presets | No active direct callsites found; do not count definitions as rendered surfaces. |

The prior perf-gpu “nine backdrops” are streaming **word filters**, not nine
persistent sidebar/composer materials. Ordinary thread/sidebar/Explorer scenes
have zero backdrop draws. Surface caching needs source-content/damage provenance
including filter halos, ordering barriers, transforms, atlas updates and nested
filters; no safe cache can use a widget's own unchanged React props as proof.

## Narrow-kernel experiment

At pixel-centred source coordinates the original 49 linear samples are a linear
combination of neighboring texels. Splat each sample's Gaussian weight to those
two texels, then pair adjacent texels using hardware linear filtering. For device
sigma <=8 the full support is <=49 texels and needs <=25 samples (sigma<=2: <=7).
CPU computes one 49-term kernel per backdrop submission; shaders no longer
compute an exponential per sample per fragment. The Gaussian, fractional step,
3-sigma extent, crop-edge clamping, two-pass rounding, saturation, opacity and
rounded-mask operations are retained. Above sigma8 all 49 original sample positions remain; weights and normalization move to CPU.
Tests cover 804 sigmas, interior and both clamp edges. Actual GPU screenshot
comparisons must establish the hardware precision limits before acceptance.

MPS/downsampling would change this shader's low-sigma discrete filter and its
RGBA intermediate rounding; those are broader visual changes. Kernel folding
is the narrowest candidate supported by the measured streaming source.
