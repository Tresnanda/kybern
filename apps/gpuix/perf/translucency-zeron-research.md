# Zeron's window glass vs GPUIX translucency (ADE-47 follow-up, 2026-10-22)

Research only: no app code, builds or benchmarks. This builds on `perf/zeron-zed-techniques.md` and
`perf/backdrop/RESEARCH.md` + `RESULTS.md`, and does not repeat them. What it adds: what Zeron does at its current
head, the cost model of each part, a point-by-point comparison with ADE-47 as shipped, and a cleaner gate.

Read-only shallow clones (deleted after reading):

- Zeron `911ec56e412786f706f58b7d0bda5729c9d5d488` (2026-10-19). The earlier research read `c526d6f`.
- ZUI `361ff20b919fdfb80199ee6d9aed725300cb7d54`, the GPUI fork Zeron pins in `Cargo.toml:97–104`. Same pin as the
  earlier research.

Links: `Z:` = `https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/…`,
`U:` = `https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/…`. Kybern paths are relative
to `apps/gpuix/`.

## 1. How Zeron does it

### 1.1 Window material: one stock effect view, edited in place, no CGS on current macOS

- Zeron maps its theme to the GPUI window background: `Transparent` on Linux, `Blurred` when the theme is glass,
  otherwise `Opaque` ([Z:crates/ui/src/theme.rs:1130–1138](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/theme.rs#L1130)).
  It never uses `Transparent` on macOS.
- `Blurred` in ZUI ([U:crates/gpui_macos/src/window.rs:1664–1717](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L1664)):
  1. the Metal layer becomes non-opaque (`renderer.update_transparency`, [U:metal_renderer.rs:555–560](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L555));
  2. the window gets `setOpaque:NO` and an alpha-0.0001 background, which keeps the shadow intact;
  3. **on macOS 12 and later** it adds one `NSVisualEffectView` (`BlurredView`) below the GPUI view. The code
     comment says this path is used for performance: the effect view "downsamples the backdrop". Only before
     macOS 12 does it call `CGSSetWindowBackgroundBlurRadius(80)`.
- The effect view is `UnderWindowBackground` / `BehindWindow` / `Active` ([U:window.rs:3414–3431](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L3414)).
  On every `updateLayer`, ZUI walks the layer tree ([U:window.rs:3433–3520](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L3433)) and:
  - hides `CAChameleonLayer`, which removes the desktop tint;
  - removes the `colorSaturate` filter;
  - **sets the material's own gaussian filter to `inputRadius = 60`** (line 3477). This is how Zeron gets a
    stronger desktop blur without the private CGS call;
  - gives the root layer an opaque black background, so Mission Control snapshots, which omit backdrop layers,
    don't show raw desktop.
- The window background is re-applied after every appearance change, deferred until every window is back in `App`
  ([Z:crates/ui/src/appearance.rs:342–362](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/appearance.rs#L342)).
  The reason: GPUI drops the effect view whenever the background is not `Blurred`.

### 1.2 Coat: one fill, at a fixed alpha that is raised only for contrast

- The shell paints one `.bg(frost)` on the root, where `frost = theme.glass()`
  ([Z:crates/ui/src/shell.rs:13434–13436](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/shell.rs#L13434),
  [:13596](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/shell.rs#L13596)).
- On that coat:
  - the sidebar column is transparent ([:7745](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/shell.rs#L7745));
  - the conversation column is flush and unfilled, "the transcript directly on the frost glass" ([:14027–14030](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/shell.rs#L14027));
  - only the right pane adds `bg × 0.4` (`panel_bg`, [theme.rs:906–912](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/theme.rs#L906)).

  **In the steady state there is one full-window fill. No large surface is stacked on another.**
- The coat is `surface × 0.80` in both appearances (`GLASS_ALPHA`, `GLASS_ALPHA_LIGHT`, [theme.rs:795–813](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/theme.rs#L795)).
  `contrast_checked_tint_alpha` ([:876–887](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/theme.rs#L876))
  raises it in 5% steps until text reaches 4.5:1 and muted text 3:1 against an adverse backdrop: white for dark,
  black for light. `is_glass()` is just `glass().a < 1` ([:901](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/theme.rs#L901)).
  So if contrast forces the coat to opaque, the window falls back to `Opaque` compositing on its own.
  (The doc comment at `:1115` saying light is opaque is stale. The code makes light glass too.)

### 1.3 In-scene blur: Zeron uses more of it than we do, and bounds the resources

- `frosted()` paints one scene layer: backdrop blur first, then shadow, tint, border and content
  ([Z:crates/ui/src/frost.rs:72–94](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/frost.rs#L72)).
  The blur is `MENU_BLUR = 16` logical px, scaled to device px by `paint_backdrop_blur`
  ([U:crates/gpui/src/window.rs:4127–4149](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui/src/window.rs#L4127)).
- It applies to every popover, the command palette, and also **always-on surfaces over scrolling content**:
  - the composer ([Z:crates/ui/src/composer.rs:10037](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/composer.rs#L10037));
  - the "Scroll to bottom" pill ([shell.rs:11636](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/shell.rs#L11636));
  - sticky diff headers ([changes.rs:3690](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/changes.rs#L3690)).

  So while streaming, Zeron re-blurs the region under its composer on every frame. **Zeron does not keep costs
  low by avoiding scene blur.**
- What it bounds instead (renderer, [U:metal_renderer.rs:962–1106, 1357–1500](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L962)):
  - **Copy size:** it blits only the clipped bounds plus a 3σ+2 halo, not the drawable.
  - **Blur kernel:** `MPSImageGaussianBlur`, cached per σ in a 4-entry LRU (`:1486`). Apple's kernel picks its own
    algorithm for wide σ.
  - **Scratch textures:** quantized to 64 px (`:1375`); at most 4 pairs and 32 MiB, allowing one oversized pair.
  - **Release:** scratch is dropped after 30 blur-free frames (`:50`).

  It does **not** downsample and does **not** cache pixels; every blur re-reads live content.
- The only downsampled in-window blur is the native path for WebKit children. There, a `CABackdropLayer` at
  `setScale: 0.25` with a `gaussianBlur` filter sits under GPUI overlays, and the filter is rebuilt only when the
  radius changes ([U:window.rs:357–385](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L357),
  [:1974–2036](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/window.rs#L1974)).
  It is enabled only when the in-app browser mounts (`enable_scene_overlay`,
  [Z:crates/ui/src/browser/macos.rs:365](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/browser/macos.rs#L365)).

### 1.4 Settings, re-render and idle

- **The only material setting is "Glass":** Theme default / Frosted / Opaque. The default is `ThemeDefault`
  ([Z:crates/theme/src/lib.rs:67–72](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/theme/src/lib.rs#L67);
  select at [settings/appearance.rs:3597–3615](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/settings/appearance.rs#L3597)).
  There is **no opacity slider, no blur slider and no sidebar-only mode.**
- **A change costs one repaint.** `set_surface` returns early when nothing changed. `apply()` reinstalls the theme
  and calls `cx.refresh_windows()` once, and only if appearance, variant, accent, surface or wallpaper colour
  actually moved ([appearance.rs:195–279](https://github.com/zeronsh/zeron/blob/911ec56e412786f706f58b7d0bda5729c9d5d488/crates/ui/src/appearance.rs#L195)).
  Colours are read at paint time, so a change costs one full repaint, not one per slider step.
- **Idle:** GPUI presents only dirty frames, and backdrop scratch is released after 30 blur-free frames. Zeron has
  nothing material-specific running when idle.

## 2. Point-by-point comparison

| Aspect | Zeron / ZUI | GPUIX (ADE-47) | Who pays more |
|---|---|---|---|
| Desktop blur mechanism | `Blurred` = stock `NSVisualEffectView` (downsampled by AppKit), filter radius set to 60 in `updateLayer` | Blur 1–64 (default **64**) → `transparent` + private `CGSSetWindowBackgroundBlurRadius` (`src/native/windowBlur.ts:61–96`, `src/shell/windowMaterial.ts:88–100`). Auto → `blurred` + effect view with tint and saturation restored (`src/native/material.ts:72,91`) | Unmeasured. The last gate shows no WindowServer difference (before-r streaming WS GPU 2517 ms vs sidebar-r 2356 ms). ZUI's own comment favours the effect view |
| Blur shown where nothing can show through | Never: `is_glass()` is false once contrast forces alpha 1, so the window becomes `Opaque` | **Yes, see §3.1.** Light + Sidebar only + opacity ≥ 47 is opaque everywhere, yet the window stays transparent with a radius-64 blur | **GPUIX** |
| Large fills in the steady state | One root coat. Sidebar and transcript unfilled | Window scope: one coat (`App.tsx:129`); sidebar and content transparent. **Sidebar scope: root shell (translucent) + sidebar coat on top + opaque content card on top of the shell** (`App.tsx:129,156,180`; `src/platform/translucency.ts:121–126`). Solid: opaque frame + opaque card | **GPUIX** in Sidebar only (the default) and Solid |
| Contrast safety | Coat alpha raised until 4.5:1 / 3:1 against an adverse backdrop | None. Opacity 15 is allowed whatever the wallpaper | Quality gap, not cost |
| Settings granularity | One 3-way select, applied once | Per variant: Solid/Translucent, Sidebar only, Opacity 15–100, Blur 1–64/Auto | — |
| Cost of a settings change | One `refresh_windows` | Each opacity preview step (≤ 10/s, `src/settings/Appearance.tsx:21–42`) runs `build()` (`src/theme.ts:175–191`), giving a **new `Theme` object, which re-renders every `useTheme()` consumer** and repaints. Each blur preview step re-runs `setOpaque`, `setBackgroundColor`, the CGS call and `invalidateShadow` on every window | **GPUIX**, during drags only |
| In-scene blur surfaces | Popovers, palette, **composer, scroll pill, sticky headers** | Only menus, pickers and dialogs in **window** scope (`src/composer/Menu.tsx:170–171`). Sidebar only and Solid: none. The composer is a plain fill | **Zeron** |
| Scene blur kernel | MPS gaussian, full resolution, kernel LRU of 4 | Own two-pass shader, full resolution. `blur:16` (`src/native/backdrop.ts:22`) is likely device σ≈32 at 2×, which is > 8, so **all 49 taps × 2 passes** (`native/patches/backdrop_kernel.rs:16–27`) | Probably **GPUIX** per blurred pixel |
| Scene blur scratch | 64 px buckets, ≤ 4 pairs / 32 MiB, freed after 30 idle frames | One texture that only grows, never shrinks (`native/patches/backdrop_renderer.rs:34–38`) | **GPUIX** (peak memory) |
| Idle | 0 frames | 0 submissions, 0 GPU ms in every mode (gate report) | Equal |

## 3. Where we pay more (each checked in our code)

### 3.1 The default Sidebar only mode blurs the desktop for pixels that are nearly or fully opaque

`materialFormulas` (`src/platform/translucency.ts:81–99`) computes the shell as
`min(100, round(opacity × k))`, where k = 64/72 for dark and 82/38 for light. In sidebar scope (`:121–126`), the
root paints that shell over the whole window (`App.tsx:129`), and the sidebar paints the coat on top (`App.tsx:156`).

At the default opacity 90 (`DEFAULT_VARIANT_MATERIAL`, `:39`):

- **Dark:**
  - shell 80%, so the rail, title bar and gutters show 20% of the blur;
  - the sidebar is the 90% coat over the 80% shell, an effective **98%**;
  - content is opaque.
- **Light:** the shell clamps to **100%** (the spec says so: "light o=90 → 100%", spec line 210). The coat goes on
  top and content is opaque, so **every pixel in the window is opaque**.

Yet `backingFor` (`src/shell/windowMaterial.ts:23–26`) chooses `transparent` with radius 64 for any non-`none`
scope. That means:

- the CAMetalLayer is non-opaque, so WindowServer has to blend the whole window;
- a desktop blur runs behind it, for a result that is invisible (light) or 2–20% visible (dark).

Zeron can't get into this state, because its `is_glass()` reads the coat's final alpha.

### 3.2 Sidebar only and Solid stack large fills; whole-window glass doesn't

GPUI repaints the whole drawable on every presented frame, and its quads are blended, so the GPU's hidden-surface
removal does not apply. That makes every full-area quad a fill cost on every streamed or scrolled frame.

| Scope | Large quads painted |
|---|---|
| Window | Root coat only (`App.tsx:129`). Sidebar (`:156`) and content (`:180`) are transparent |
| Sidebar only | Root shell over the whole window, sidebar coat on top, opaque content card on top of the shell |
| Solid | Opaque frame, then an opaque card covering most of it |

The gate report credits the halved GPUIX GPU time in whole-window mode (streaming 3014 → 1751 ms; thread-scroll
3338 → 1620 ms) to "GPUI no longer drawing its `BlurredView`". **That explanation doesn't fit.** `BlurredView` is an
AppKit layer composited by WindowServer, so it never appears in the app's Metal command buffers or its per-PID GPU
counter. Sidebar only also uses `transparent` with no `BlurredView`, and its GPU time stayed at the vibrancy level
(3035 ms).

The variable that does differ between Window and Sidebar only is the **opaque content card**. So the halving
points at **overdraw, not material**. This is an inference; R2 below is the one-variable check. If it holds, it
saves GPU time in every scope, Solid included, independent of glass.

### 3.3 An opacity step re-renders the whole React tree

The theme cache (`src/theme.ts:169–191`, 16 entries) avoids rebuilding a value it has already seen. But each new
opacity is a new `Theme` identity passed through `ThemeContext` (`src/ui.tsx:48`), so every themed component
re-renders, lays out and repaints at up to 10 Hz while the slider is held.

Only about ten tokens depend on opacity: frame, sidebar, content, and `glass.*`, used by `App.tsx`,
`SettingsScreen.tsx:84`, `Composer.tsx:629`, `composer/Menu.tsx:218`, `shell/toasts.tsx:305,395`,
`transcript/Requests.tsx:115`, `dock/Dock.tsx:92`, `subagents/Page.tsx:61`, and `terminal/Terminal.tsx:388`.

Zeron pays one repaint per discrete change. This affects responsiveness while dragging, not steady-state cost.

### 3.4 The menu blur is the most expensive kernel case

With the default `cutout` blur of 16 pt, σ exceeds 8 device px, which falls outside the folded-kernel fast path
(`perf/backdrop/RESEARCH.md`, "Narrow-kernel experiment"). Each blurred menu pixel therefore costs 2 × 49
texture reads. This runs:

- on every frame of the 150 ms entrance, because the blur sits inside the paint transform
  (`src/composer/Menu.tsx:213–217`);
- on every frame that streams under an open menu.

The scratch texture also keeps its largest size for good.

The gate saw no menu regression (model-picker frame p95 27.3 ms vs 28.8 ms), so this is headroom, not a defect.
At σ ≥ 16 device px, a half- or quarter-resolution blur can't be told apart from full resolution. That is why both
AppKit's material and ZUI's WebKit path downsample.

### 3.5 Minor

- `setWindowBlurRadius` sets `setOpaque`, the background colour and `invalidateShadow` on every call
  (`src/native/windowBlur.ts:77–88`), including each blur preview step. These are only needed on the transition
  into `transparent`.
- Restoring the material's tint layer and saturation filter (`src/native/material.ts:72,91`) keeps two extra
  WindowServer filter stages that Zeron strips. This is deliberate desktop parity, and under a coat of 80% or more
  the tint is barely visible. Low value.

## 4. Recommended changes (in priority order)

| # | Change | Where | Layer | Expected effect | Risk |
|---|---|---|---|---|---|
| R1 | **Opaque backing when nothing can show through.** Compute the coverage of the most transparent visible surface for the scope: frame/shell for Sidebar only, coat for Window. If it is ≥ 0.99 (light Sidebar only at opacity ≥ 47 today; any scope at opacity 100), return `{mode:'opaque', radius:0}` and keep the colours. Pass variant and opacity into `backingFor`. | `src/shell/windowMaterial.ts:23–26`, call sites `src/ui.tsx:47`, `src/main.tsx:71`; helper next to `materialFormulas` | **TS** | Light default: no desktop blur and an opaque Metal layer, so WindowServer stops blending the window. Matches Zeron's `is_glass()` rule. | Low. Keyed on the existing `lastKey`, so a slider crossing 47 flips the backing once. Add a unit test next to `translucency.test.ts`. |
| R2 | **Remove overdraw under opaque cards.** First measure (below). Then, in Sidebar only and Solid, stop painting the root fill under the workspace card: paint the frame colour only on title bar, rail and gutter rects, or make the card's region of the root transparent. In Sidebar only, paint the sidebar with the coat that gives the intended **effective** alpha instead of coat over shell. | `src/App.tsx:129,156,180`, `src/platform/translucency.ts:121–126` | **TS** | If §3.2 holds, roughly the GPU saving Window mode showed (−40–50% GPUIX GPU on streaming and scroll) in Sidebar only and Solid too. | Medium: rounded-corner seams at the card edge, the narrow-window dock overlay, theme-fade screenshots. Check visually in light/dark, opaque, Reduce transparency and Increase contrast. **Measure first:** with `KYBERN_WINDOW_MATERIAL=solid` and a temporary flag that sets the root fill to transparent under an opaque card, run thread-scroll GPU ms on the same build. If GPU ms doesn't fall, drop R2. |
| R3 | **Split material tokens from `Theme`.** Move frame, sidebar, content and `glass.*` into a small `useMaterial()` store/context. Keep `Theme` identity per (variant, contrast, reduceTransparency) so an opacity step re-renders only the ~10 consumers listed in §3.3. | `src/theme.ts`, `src/ui.tsx:48`, the consumers in §3.3 | **TS** | Opacity drag previews stop re-rendering the tree. No steady-state change. | Low–medium: mechanical migration. The `MAX_DERIVED` cache becomes mostly unnecessary. |
| R4 | **Default blur = Auto (effect view) instead of 64, or keep 64 and implement it the ZUI way.** Option A, TS only: `DEFAULT_VARIANT_MATERIAL.blur = null`, so the default uses the downsampled `NSVisualEffectView` and no private API. Option B: set the effect view's backdrop gaussian `inputRadius` to the slider value, as ZUI does at `window.rs:3466–3480`, instead of `CGSSetWindowBackgroundBlurRadius`. That keeps `blurred` mode for every radius and removes the `setOpaque`/`invalidateShadow` calls (§3.5). Doing B robustly needs `updateLayer` to re-apply the radius: put a `blurRadius` ivar on `BlurredView` in the **patched addon**. | A: `src/platform/translucency.ts:39`. B: `native/patches/` (`window_platform*`), `src/native/material.ts` | A: **TS**. B: **native** | Removes a private WindowServer call from the default path; probably cheaper backdrop work (AppKit downsamples). **Not shown by the last gate**, so ship only with a WS GPU measurement. | A: the default look changes (vibrancy is lighter than radius 64 under a 90% coat; check by eye). B: a CA filter keyed on the description string (ZUI relies on the same trick). Keep CGS as the fallback when no blur filter is found. |
| R5 | **Downsampled menu blur for σ > 8 device px.** Blit the padded region at half resolution with linear filtering, run the folded kernel with σ/2 (≤ 25 taps), and upsample in the composite pass. Leave σ ≤ 8 (stream-word fades) exactly as now. Also add ZUI's 64 px scratch buckets and release after N blur-free frames. | `native/patches/backdrop_renderer.rs`, `backdrop_kernel.rs`, `backdrop.metal` | **Native** | About 4× fewer fragments and about 2× fewer taps per blurred menu pixel; lower retained scratch after a large popup. | Medium: visual equivalence must be shown with the existing `perf/backdrop` pixel checks at σ 16/18 pt. Keep the full-resolution path behind `KYBERN_BACKDROP_KERNEL=0`-style control. |
| R6 | **Contrast floor for the coat.** Port Zeron's `contrast_checked_tint_alpha`: raise the coat's alpha until text ≥ 4.5:1 and secondary ≥ 3:1 against an adverse backdrop. Let R1 then pick opaque backing automatically when the floor reaches 1. | `src/platform/translucency.ts:87–100` | **TS** | Quality: low opacities stay legible on bright wallpapers. Makes R1 apply more often. | Low. The slider's low end looks less transparent than its label. Document it in the row description. |
| R7 | **Apply window flags only on transition.** In `setWindowBlurRadius`, set `setOpaque:NO`, the background colour and `invalidateShadow` once when entering `transparent`. Later radius changes only call CGS. | `src/native/windowBlur.ts:77–88` | **TS** | Cheaper blur-slider drags; avoids shadow recomputation. | Very low. |

**Rejected:** caching blurred backdrop pixels across frames. The earlier research already rejected it: content
under a menu changes while streaming, and neither Zed nor ZUI does it.

**Not recommended:** moving the coat into a CALayer behind the Metal view. It would take one full-window quad per
frame out of GPUIX, but the coat would vanish from `captureScreenshot` (theme fade, visual checks) and from the
pixels that the menu blur samples. If R2's measurement shows the root quad itself is expensive, revisit it as an
addon experiment.

## 5. A cleaner perf gate

The last gate compared two different checkouts (`b225fa0d9` vs `d7c01275d`) in sequence, with other lanes running
and the quiet `before` run first. Its base-vs-base control failed:

| Metric | Control drift (`before` vs `before-r`) | Gate limit |
|---|---|---|
| Streaming CPU | +18.9 points | +3 |
| Streaming frame p95 | +2.4 ms | +1 ms |
| Thread-scroll GPU | +45% | +10% |
| Idle memory | +20 MiB | +10 MiB |

The bench already pins the material by environment (`KYBERN_WINDOW_MATERIAL`, `KYBERN_WINDOW_OPACITY`,
`KYBERN_WINDOW_BLUR`, read in `src/settings/appearance.ts:31–44`, recorded in `run.ts` `renderFlags`). So **the A/B
needs only one build.** Procedure:

1. **One binary, one addon, one daemon.** Compare modes by env pin only: `solid` (control), `sidebar`, `window`, and
   an `auto` blur variant. Record the addon SHA once. Code changes such as R1–R3 get their own A/B against the same
   build with the change behind a temporary env flag, so the binary stays identical.
2. **Quiet machine.**
   - No other agent lanes; `run.ts` already discards overlap with native builds and foreign GPUIX apps.
   - AC power, Low Power Mode off, display sleep off.
   - Take `pmset -g therm` before each block and abort if thermally limited.
   - Note background indexers (`mdutil -s /`) and pause Time Machine for the session.
3. **Warm the session before measuring.** Run one full throw-away block, because the first block of a session
   lands in a quieter regime (the last gate's `before`). Keep `--warmup 10` per scenario.
4. **Interleave, don't sequence.** Run blocks as A B B A A B B A, at least 4 blocks per arm, `--runs 3` each, so
   every arm gets ≥ 12 windows spread over the session. Randomize scenario order within a block with a fixed seed,
   and keep the seed in the label.
5. **A/A control in the same session.** Make one of the arms a second copy of `solid` (the same env), interleaved
   with the rest. **If the A/A pair exceeds a threshold, that metric is uninformative for the session**, rather
   than the A/B failing.
6. **Normalize by cadence.**
   - The CPU gap in the last control matched submissions (367 vs 450–500 per window), so also report CPU ms and
     GPU ms **per submitted frame**.
   - Mark a pair invalid when submissions differ by more than 10% (the input-rate check already does this at 5%
     for offered packets).
7. **Statistics.**
   - Gate on the median of per-block medians, with a bootstrap 90% CI of the A−B difference (resample blocks, not
     windows).
   - A metric fails only when the CI's lower bound exceeds the threshold **and** the A/A CI does not already
     cover that threshold.
8. **Thresholds that fit the noise we saw.** Same-regime pairs (the reverse pairs) varied by about ±2–5 CPU points,
   ±1.4 ms p95 and ±20% GPU ms. Proposed:

   | Metric | Threshold |
   |---|---|
   | Frame p95 | +1.5 ms |
   | Intervals > 33 ms | +2 per 45 s |
   | GPUIX CPU | +5 points, **or** +10% CPU ms per frame |
   | GPUIX GPU ms | +15% |
   | WindowServer CPU | +4 points |
   | WindowServer GPU ms | +20% |
   | Idle CPU | +1.5 points |
   | Idle memory | +15 MiB |
   | Idle submissions / GPU ms | must stay 0 |

   Tighten these again once an A/A run on a quiet machine shows less spread.
9. **Measure what material changes move.**
   - WindowServer GPU ms is the key metric for R1/R4. It counts every window on the test display, so keep that
     display empty.
   - For R1/R4, run one block **on the real display with a wallpaper**; the hidden test display has no desktop to
     blur, which may understate WindowServer's backdrop work.
   - For R2, GPUIX GPU ms per frame is the key metric.
   - For R5, use `popup.ts model-picker` (25 opens) plus a menu held open over `streaming`.

## 6. Limits

- Reading code, not running it. The effect-view-vs-CGS cost, the downsampling inside AppKit, and the overdraw
  explanation in §3.2 are inferences that R2 and R4 have to confirm on hardware.
- ZUI's own comment about effect-view performance is a claim, not a measurement.
- Zeron's choices are tuned to its look (one 80% coat, frost everywhere); copying its settings model is a product
  decision, not a perf requirement.
