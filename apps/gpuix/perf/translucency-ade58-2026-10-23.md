# Frosted popups and the backdrop alpha pass: perf and pixel check (ADE-56..58, 2026-10-23)

What changed: dialogs, alert dialogs, sheets and the command palette now take the menu frost on whole-window glass (a tint over a scene
blur), and the addon's backdrop pass blurs the window alpha with the colour (`native/patches/backdrop.metal`, `backdrop_renderer.rs`;
programmable blending on Apple GPUs). This note holds the pixel proof and the GPU cost of both.

## Pixel check: what "not blurred" was

`src/platform/verify.blur.ts` (glass fixture with text under every popup, whole-window glass 83/83, dark, 1000×900) captures each popup
and the scene behind it, then regresses the popup's pixels on the scene's: `colour` = how much of the scene's glyph edges survive in the
colour under the surface, `alpha` = the same in the window's alpha channel. GPUI's own render is the source (the OS window image
is shown in the screenshots, but the window server returned stale frames often enough that it cannot carry numbers).

| Surface | Build | colour detail | window-alpha detail |
|---|---|---:|---:|
| "…" menu | v0.11.1 addon, v0.11.1 app | 0.002 | **0.330** |
| "…" menu | v0.11.1 addon, this branch | -0.009 | **0.332** |
| "…" menu | **patched addon**, this branch | 0.013 | **0.005** |
| "…" menu | patched addon, `KYBERN_BACKDROP_PROGRAMMABLE=0` (control) | 0.002 | 0.330 |
| dialog (Add project) | v0.11.1 | 0.006 (opaque popover, 96%) | 0.000 |
| dialog | this branch, patched addon | 0.006 (frosted) | 0.000 |
| palette | v0.11.1 | 0.004 (opaque popover) | 0.000 |
| palette | this branch, patched addon | 0.004 (frosted) | 0.000 |

Reading: the "…" menu's colour was already blurred (at a glyph pixel under it the colour reads 42 like its surroundings; with `KYBERN_GLASS_FROST=none` the same pixel reads 62, the sharp text through the tint).
What the eye read as "nothing is blurred" was the window alpha: the backdrop pass left the destination alpha untouched
(`source_alpha_blend_factor(Zero)`, `destination(One)`), so opaque glyph pixels on a translucent coat stayed crisp in the alpha channel and
the desktop showed through text-shaped holes (alpha detail 0.33). The composer and pills had the same ghost. With the alpha blurred
too the menu is a clean frosted pane (screenshots `after-popups-blur-menu*.png` against `before-popups-blur-menu*.png`).
Moving the filter between the popup layer and its animated child (the first lead) changed nothing: window captures of a layer-level and a nested filter
show the same crisp ghost as the shipped arrangement, so the layer was never the problem. Dialogs and the palette were opaque before, so they read "no detail" for the wrong reason.

Solid and Sidebar only against v0.11.1, GPUI's render, pixels differing by more than 2 per channel: draft, task page, Notes, Tasks,
Settings and the thread at the tail 0.000 to 0.004%; the thread scrolled up 0.167% (the removed bottom wash, ADE-57).

## GPU cost

`perf/bench/gate2.ts` (the round-2 procedure), one build per row, arms `w-tint` (`KYBERN_GLASS_FROST=none`) and `w-menus`
(`menus` frost on), 2 rounds A B B A, 3 windows of 15 s per block after a 10 s warm-up, `--fresh`, AC power, hidden 1440×900@2× display, M1.
Scenarios: `streaming-menu` (model picker held open over the stream, as in the gate) and the new `streaming-palette` (command palette
held open). Medians of block medians; GPUIX GPU ms per submitted frame.

| Scenario | Build | tint-only | frosted | Δ | p95 ms (tint / frosted) | frames > 33 ms per 45 s |
|---|---|---:|---:|---:|---|---|
| streaming-menu | v0.11.1 | 2.11 | 4.50 | +113% | 28.0 / 27.4 | 10.0 / 8.5 |
| streaming-menu | this branch, patched addon | 2.07 | 4.21 | +103% | 29.4 / 23.0 | 4.5 / 0.0 |
| streaming-palette | v0.11.1 (opaque: both arms the same) | 3.34 | 3.39 | +1% | 35.5 / 35.6 | 183 / 174 |
| streaming-palette | this branch, patched addon | 2.54 | 5.44 | +114% | 35.4 / 35.5 | 178 / 181 |

- The patched pass costs no more than the fixed-function one: the menu's frosted frame is 4.21 ms against 4.50 ms, and the extra over
  tint-only is +103% against +113% (two rounds, so within the A/A noise of the earlier gates).
- Frosting the palette doubles its GPU time per frame (+2.9 ms), the same ratio the gate accepted for menus and the composer.
  Frame pacing does not move (p95 35.4 / 35.5 ms, intervals over 33 ms 178 / 181): the palette over a stream already misses 33 ms
  with the blur off (183 intervals on v0.11.1), which is its own cost (the open list and field), not the blur. Rule agreed for this
  feature is stutter, so the blur stays on the palette and on dialogs, alerts and sheets (same path and a similar area; dialogs
  were not benched separately).
- The tint-only palette arm reads 3.34 ms on v0.11.1 and 2.54 ms on this branch with the same content: the machine, not the build
  (two rounds; A and B ran 30 minutes apart). Read the Δ within a build, not across.

## Limits

- Two rounds per arm and no warm-up round, against four with one in the gate: the CIs are not computed. The ratios inside a build are
  the evidence; the across-build rows are context.
- The hidden display has a flat wallpaper: it shows the in-scene blur's cost and the alpha silhouettes, not the window-server blur.
- Intel Macs (and any GPU without programmable blending) keep the fixed-function pass and its alpha silhouettes; only
  `supportsFamily(Apple1)` GPUs read the target in the shader. Not tested here: no Intel machine.
- Windows and Linux builds have no backdrop pass (`native/README.md`), so nothing changes there.
- Dark theme only; light was not measured (same kernel, same cost).
