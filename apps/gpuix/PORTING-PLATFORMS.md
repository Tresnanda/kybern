# Porting GPUIX to Intel Mac, Windows and Linux

Issue #113: retire the Tauri app (`apps/desktop`) once Kybern GPUIX runs
everywhere Tauri ships. This document says what is macOS-only today, how each
piece moves to Windows and Linux (or degrades gracefully), the work packages
that can run in parallel, what needs real hardware, and the ship order.
The inventory was written against `feat/gpuix-intel` (GPUIX 0.10.0, Kybern
0.10.2); the ADE-52 spike below re-checked it on GPUIX 0.11.0 by building and
running the patched addon on Linux and Windows.

| Platform | Tauri | GPUIX |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg`, `.app.tar.gz` | `kybern-gpuix_<v>_aarch64.app.tar.gz` |
| macOS Intel | `.dmg`, `.app.tar.gz` | `kybern-gpuix_<v>_x86_64.app.tar.gz` |
| Windows x64 | NSIS `-setup.exe` (unsigned) | addon builds and draws in CI (ADE-52); no package |
| Linux x64 | `.AppImage`, `.deb` | addon builds and draws in CI (ADE-52); no package |

## ADE-52 spike: the patched addon on Linux and Windows (2026-10-22)

The patched addon (GPUIX 0.11.0 plus every Kybern patch) builds for
`x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` on GitHub-hosted
runners, and the real app draws on both: sidebar, a seeded thread with
Markdown, a table and a highlighted code block, and the composer. Rounded
clipping is ported to WGSL and HLSL. Scope was compile + draw, with
fallbacks; nothing below is product-ready.

How it is run: `.github/workflows/gpuix-platforms.yml` (manual) builds
`kybernd` and the addon (`native/update.sh` with `KYBERN_NATIVE_CHECKS=0`), then
`scripts/platform-smoke.ts`: a scratch daemon, one thread seeded the way
`perf/bench/seed.ts` does it (RPC for records, SQL for synthetic provider
events, no agent), and PNGs of the app and `native/clip-lab.tsx` with rounded
clipping on and off (`KYBERN_ROUNDED_CLIP=0` squares every clip chain: the
rectangular look the app had before this port). Neither runner has a GPU:

- **Linux** (`ubuntu-24.04`): Xvfb, X11 client, wgpu on Mesa **lavapipe**
  (llvmpipe Vulkan). Captured with ImageMagick `import` (wgpu has no readback
  in GPUIX yet).
- **Windows** (`windows-2022`): Win32 window, Direct3D 11 on **WARP**
  (Microsoft Basic Render Driver). Captured with the addon's
  `captureScreenshot` (GPUI renders the window's scene to an image through the
  same renderer).

`workflow_dispatch` only runs a workflow that exists on `main`. Until this
branch merges, the spike ran it from throwaway `spike/ade-52-platforms*`
branches whose single extra commit adds a push trigger for those branches;
the committed workflow stays manual-only.

Local loop (macOS host): an arm64 Ubuntu 24.04 container (OrbStack) runs the
same `cargo check` / release build of the Linux addon in about 15 s / 75 s
incrementally and the same smoke test under Xvfb + lavapipe; `naga` validates
the three WGSL variants. That loop found every Linux issue before CI did.

### Acceptance criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Addon builds for both targets in CI | met | Both OSes green: [39742674735](https://github.com/Tresnanda/kybern/actions/runs/39742674735) (LTO off) and [39742680467](https://github.com/Tresnanda/kybern/actions/runs/39742680467) (release profile, fat LTO). First Linux build: [39735839297](https://github.com/Tresnanda/kybern/actions/runs/39735839297) |
| 2 | App launches and renders sidebar, Markdown/code transcript, composer | met on both (Linux CI x86_64 and local arm64; Windows CI) | `ade52-linux-app.png`, `ade52-windows-app.png` |
| 3 | Rounded clipping correct in WGSL and HLSL, before/after | met on both | `ade52-linux-clip-before.png` / `-after.png`, `ade52-windows-clip-before.png` / `-after.png`; macOS `clip-check` and `rounded-check` still pass |
| 4 | Every macOS-only patch with works / fallback / blocked | met | [the table below](#macos-only-patches-off-macos) |
| 5 | Bun main thread vs GPUI UI thread, decided with evidence | met: UI thread | [Event loop decision](#event-loop-decision) |
| 6 | Re-estimated plan and ordered work packages | met | [Work packages](#work-packages) |

Screenshots are workflow artifacts (`gpuix-<os>-screens`) and copies under
`.kybern-artifacts/ade-grill/` in the main checkout; they are not committed.

### What it took

| Breaker (estimate before the spike) | What it actually needed |
| --- | --- |
| `Primitive::Backdrop` arms in wgpu and D3D renderers (0.5 d) | Two match arms that draw nothing (`platforms_gpui.py`); the material's tint quad still paints, which is the agreed fallback |
| ~40 hooks on the macOS-only `update_window` (2 d spike + 4–8 d) | **One generic bridge, no hook rewritten** (`platforms_hooks.py`): off macOS `update_window` / `update_window_without_view` box the closure into `UiCommand::Run`, run it on the `gpuix-ui` thread against the same window and wait for the result. Every existing closure was already `Send + 'static` except one `move` keyword. 12 napi methods that were stubbed "macOS-only" only because of `update_window` now share the macOS body; the save panel opens on the UI thread |
| `ContentMask` 16 → 24 bytes in WGSL/HLSL (1 d per backend) plus rounded alpha (2–3 d per backend) | Struct mirrored, the Metal chain walk ported to both languages, a clip-chain storage buffer (wgpu, group 1 binding 1) and structured buffer (D3D, `t2`, `ps_4_1`-compatible); about 1 d for both. Without it Linux drew **nothing** (every primitive read a garbage clip rect) |
| `update.sh` Mach-O only (1.5 d) | Per-target library name and output (`linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`), realign/codesign/Cocoa companion only on macOS, `.exe` test binaries, `PYTHON`/`PYTHONUTF8` for Git Bash; 0.5 d |
| (not in the inventory) | Compositor loops defaulted on everywhere: GPUI core lifted loop leaves out of the scene for Core Animation layers that only Metal creates, so spinners and shimmers would vanish off macOS. Now macOS-only (scene loops elsewhere). Upstream `getPaintedText` / `getPaintedHighlights` read the JS thread's empty thread-locals off macOS; they ask the UI thread now. `ElementBounds` lost `Copy` in a Kybern patch, which broke upstream's Linux-only `elements_at` |

All of it lives in two new drivers, `patches/platforms_gpui.py` (GPUI side,
run last by `backdrop_gpui.py`) and `patches/platforms_hooks.py` (native crate,
run last by `apply_hooks.py`). They only edit Linux/Windows sources or add
`cfg`-gated code, so the macOS addon is unchanged apart from the gate removal
on the 12 shared methods; `KYBERN_NATIVE_CHECKS=0 ./update.sh`, the app's
typecheck and 442 unit tests, `clip-check` and `rounded-check` pass on macOS.

Addon build times on the hosted runners (cold cargo cache): Linux 4.5–6.5 min,
Windows 7.7–8.2 min, with or without fat LTO. macOS release with LTO: 6.5 min
locally. The Windows window came up at the WARP desktop's 1024×768, so its
captures are smaller.

## Event loop decision

**Decision: keep upstream's model off macOS (GPUI on its own UI thread), with
one generic bridge for Kybern's hooks. Do not pump GPUI on Bun's main thread on
Linux or Windows.**

Evidence:

1. **The cost that motivated option 2 is gone.** The old plan assumed each of
   the ~40 hooks would need a hand-written `UiCommand` variant and every future
   hook two versions. The bridge (`run_on_ui_thread`, ~60 lines) makes
   `update_window` portable with the same signature plus `Send + 'static`.
   The whole patch queue type-checked off macOS with it; one closure needed a
   `move`. Future hooks are written once; only a non-`Send` capture fails to
   compile, which is the right error.
2. **It runs.** The full app (all hooks, the Markdown document worker, the
   editor, cached islands, layout observers) runs on the UI-thread model on
   Linux, locally and in CI.
3. **Cost per call is upstream's own.** 2,000 synchronous window updates from
   JS (`native/bridge-bench.tsx`, Linux arm64 container, lavapipe): a Kybern hook through
   the bridge p50 38.5 µs, p90 44.5 µs; upstream's own synchronous
   `getWindowSize` over its channel p50 38.5 µs, p90 43.8 µs; a call that does
   not touch the window 0.3 µs. macOS (same thread) is 1.4 µs. p99 of the hook
   reached 0.8 ms when the UI thread was mid-frame on the software rasterizer.
   That is cheap for per-gesture calls, but hooks called many times per frame
   should not wait: make the fire-and-forget ones (`()` results) send without
   waiting (WP1 below), and measure calls per frame in the bench.
4. **Option 2 has real costs that option 1 does not.** Main-thread pumping
   needs an embedded mode in `gpui_linux` (X11 and Wayland calloop dispatch
   from a Bun-polled fd) and `gpui_windows` (a `PeekMessage` pump, with
   Windows' modal size/move loop blocking JS for the whole drag), plus flipping
   roughly a hundred `cfg(target_os = "macos")` pairs in `renderer.rs` from the
   threaded branch to the embedded one. Estimated 6–9 days and a patch that
   fights upstream on every update. Not attempted: point 1 removed its reason.

Known hazard of the threaded model: a hook that reads a thread-local registry
*outside* its `update_window` closure sees the JS thread's empty copy. An audit
of every napi method found only upstream's `getPaintedText` and
`getPaintedHighlights` (fixed) and the macOS-only `idle_memory` tick pool and
window-state callback (no-ops off macOS). New hooks must keep paint-time
state reads inside the closure.

## macOS-only patches off macOS

Status: **works** (same behaviour; *verified* means seen on screen or exercised
by the smoke run), **fallback** (degrades as named), **blocked** (needs the
work package named before shipping). "UI-thread bridge" means the hook needed
nothing but `platforms_hooks.py`.

| Patch / feature | Where | Linux | Windows | Notes |
| --- | --- | --- | --- | --- |
| Rounded overflow clip (paint + hit test) | `rounded_clip*`, `shaders.metal` | works, verified | works, verified | Ported (`platforms_gpui.py`); hit-test part is in GPUI core |
| Backdrop blur / saturation | `backdrop_*`, `backdrop.metal` | fallback | fallback | Batch skipped; the translucent material fill shows (clip lab "backdrop" tile). Real blur: WP6 |
| Compositor loops (CA layers) | `compositor_loops_*`, `compositor_covers_gpui.py` | fallback | fallback | Scene loops at the normal frame rate (macOS-only gate added) |
| Partial-region presentation | `paint_region_*`, `paint_region.metal` | fallback | fallback | Full redraw (it is opt-in even on macOS) |
| Drawable timing, GPU clip simplification, GPU telemetry | `frame_drawable_gpui.py`, `gpu_clip*`, `gpu_telemetry_gpui.py` | fallback | fallback | Counters report 0; nothing visual |
| Memory counters, image eviction stats | `memory_counters_gpui.py`, `image_memory*` | fallback | fallback | `getMemoryStats` works through the bridge; Metal gauges and atlas bytes are 0 |
| Idle GPU release, window-state observer, autorelease tick pool | `idle_memory*` | fallback | fallback | No idle release; JS keeps its polling path |
| Large-allocation mapper, small-allocation heap | `large_alloc.rs`, `code_small*`, `code_alloc.rs` | fallback | fallback | System allocator; their stats read 0 |
| Shimmer band / hue, pop, rotate, stroke draw, hover/stream fades, subtree transforms | `shimmer_band_gpui.py`, `pop_gpui.py`, `rotate_gpui.py`, `stroke_draw*`, `hover_fade*`, `stream_fade*`, `subtree_*` | works | works | Evaluated in GPUI core's scene, not in Metal; compiled and running, not individually checked on screen |
| Frame wake | upstream `set_frame_wake_hook` (0.11) | fallback | fallback | No display-link wake; JS frame loop on its timer (`frameMs`) |
| Variable `wght` axis | `font_weight*` (CoreText) | fallback | fallback | Nearest installed weight; WP4 |
| Per-run text scale (`kszl`) | `text_scale_gpui.py` (CoreText) | fallback | fallback | `font_scale()` default 1: rich-editor inline code at full size; WP4 |
| Fonts | `theme.ts` `.SystemUIFont`, Menlo | fallback | fallback | GPUI maps `.SystemUIFont` per platform; Menlo falls back (DejaVu in CI). Bundled Cal Sans / JetBrains Mono load (wordmark visible) |
| Key interception, close guard, input selection/transactions, text selection, rich-editor commands and images, window background | `apply_hooks.py`, `editor9_hooks.py`, `image_memory_hooks.py`, `window_platform_hooks.py` | works (UI-thread bridge) | works (UI-thread bridge) | Were "macOS-only" stubs; the close guard is used at startup |
| Rich-editor key interceptor | `rich_editor.rs:677` | fallback | fallback | Gated `macos`; editor shortcuts that rely on it do not fire. WP3 |
| Title-bar double-click action | `window_platform_hooks.py` | blocked | blocked | Reads the macOS "double-click to zoom" default; JS should zoom/maximize itself. WP3 |
| Save panel | `apply_hooks.py` `prompt_for_new_path` | works (UI thread) | works (UI thread) | Not opened in CI |
| Clipboard image | `clipboard_hooks.py` | works (bridge) | works (bridge) | Not exercised |
| Window drag regions | `window_drag.rs` | works? | works? | `WindowControlArea::Drag` is cross-platform; unverified (no pointer in CI) |
| Traffic lights / window controls | `TitleBar.tsx`, `window_platform*` | blocked | blocked | With a transparent title bar Linux X11 shows no close/min/max at all (see screenshot). WP3 |
| Window material (NSVisualEffectView) | `native/material.ts` | fallback | fallback | Opaque window |
| Secure input (Carbon) | `secure_input.rs` | fallback | fallback | No-op |
| Automation test display | `automation_display.rs` | fallback | fallback | Centered on the primary display |
| Scroll phase injection | `scroll_hooks.py` | blocked | blocked | Test-only; one line to unify like the others |
| Web view (previews, Visual, Artifacts, Mermaid) | `webview.m`, `src/native/webview.ts` | blocked | blocked | `dlopen` of the `.dylib` throws on use. Fallback to wire: previews in the browser, Mermaid as static text. WP5 |
| Notifications | `packaging/notifications.m` | fallback | fallback | Already skipped outside a macOS `.app` |
| objc FFI shell (frame restore, appearance, visibility, locale) | `shell/*.ts`, `native/*.ts` | fallback | fallback | Guarded: no restore, no system theme |
| `pbcopy`, `open`, `osascript`, `~/Library`, Keychain | `src/**` | blocked | blocked | WP2 |
| ⌘ shortcuts | 26 files | blocked | blocked | `cmd` maps to Super/Windows off macOS. WP3 |
| Pointer-release watch | `preview/resize.tsx:16` | blocked | blocked | Unguarded objc call throws on use. WP2 |
| Copy "This Mac" | environment chip | blocked | blocked | Says "This Mac" on Linux (screenshot). WP2 |

## Intel Mac (shipped in v0.10.3)

- **Addon:** one per arch, not universal. `KYBERN_GPUIX_TARGET=x86_64-apple-darwin
  native/update.sh` cross-builds `native/build/gpuix-native.darwin-x64.node` on an
  arm64 Mac. The rest of the bundle is single-arch anyway: Bun has no universal
  runtime, and `kybernd`/`kybern` are built per target. A lipo'd addon would add
  ~26 MB to every download and buy nothing. The small Objective-C companions
  (`kybern-webview.dylib`, `notifications.dylib`) are universal, built by
  `scripts/companion-flags.ts`, so the two lanes never overwrite each other's
  copies. They also now target macOS 13.0: before this, clang stamped the build
  machine's OS as the minimum (15.0 on CI, 27.0 locally), so dyld would have
  refused them on macOS 13/14.
- **Rosetta checks:** `native/tools/bun-x64.sh` compiles a stub for
  `bun-darwin-x64`; with `BUN_BE_BUN=1` that stub *is* the x64 Bun CLI. Under
  Rosetta, `update.sh` uses it for the addon load check, and for the on-screen
  checks it goes first on `PATH`.
- **Packaging:** `bun scripts/package-app.ts --arch x64` (add `--test` for local runs);
  `KYBERN_GPUIX_TARGET=x86_64-apple-darwin scripts/bundle-gpuix.sh`. The feed key is
  `darwin-x86_64-gpuix`, which `src/platform/update.ts` already derives from
  `process.arch`. `install-mac-gpuix.sh` picks the build from `uname -m`
  (`sysctl.proc_translated` keeps a Rosetta shell on the arm64 build).
- **CI:** the `gpuix` job in `desktop.yml` is a matrix over
  `aarch64-apple-darwin` and `x86_64-apple-darwin`, both on `macos-15` (arm64),
  with Intel cross-compiled. Reasons:
  - The Tauri `bundle` job already cross-builds x86_64 there.
  - Both lanes then share the same Xcode and Metal toolchain.
  - `macos-15-intel` is GitHub's last x86_64 image, with a retirement date.
  - Hosted Intel runners are slower and scarcer.
  
  Neither lane compiles the daemon: each packages the `kybernd`/`kybern` from
  dist's archive for its target (#115's single build), via `KYBERN_BIN_DIR`.
- **Tauri prompt:** `gpuix_install.rs` now offers GPUIX on Intel Macs and picks
  the feed key by arch. An x86_64 Tauri running under Rosetta installs the arm64
  GPUIX.

**Rosetta testing has an expiry date.** macOS 28 drops Rosetta for apps, so this
Apple Silicon check only works on macOS 27 or earlier. Every x86_64 launch on
macOS 27 also posts a system "App Update Required … will not open in macOS 28"
notice naming the bundle. Local Intel builds are therefore packaged with
`--test` (`Kybern GPUIX (x86_64 test).app`, `dev.kybern.gpuix.test`) and launched
as rarely as possible. Lasting Intel verification needs Intel hardware or a
hosted Intel runner (`macos-15-intel`, while it exists). The Intel product
itself is unaffected: on a real Intel Mac the app is native.

**What Rosetta cannot prove.** Rosetta translates CPU code. Metal still runs on
the Apple GPU, so nothing below is exercised:

- **Intel GPUs:** Iris/UHD integrated and AMD Radeon Pro discrete Metal drivers
  and their shader compiler.
- **Dual-GPU MacBook Pros (2016–2019):** GPU switching, plus GPUI's choice of
  the low-power device.
- **Performance on older silicon:** real AVX2 timing and memory bandwidth.
  Rosetta-under-M1 numbers are not Intel numbers.
- **Older macOS:** Intel Macs on macOS 13–15 (this Mac runs 27). The companions
  and the Bun runtime now declare 13.0, but older WebKit and AppKit behaviour
  is untested.

One pass on a real Intel Mac before the first release would cover this: launch,
transcript scroll, the backdrop blur, a preview, a Mermaid diagram, and
Activity Monitor energy.

## How upstream GPUI runs off macOS

Pinned zed (`native/upstream/zed`) splits platforms into crates:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Platform crate | `gpui_macos` | `gpui_linux` (Wayland + X11) | `gpui_windows` |
| Renderer | `gpui_apple` Metal, `shaders.metal` | `gpui_wgpu` (wgpu, Vulkan/GL), `shaders.wgsl`; cosmic-text | Direct3D 11 + DirectComposition, `shaders.hlsl`; DirectWrite |
| gpuix event loop | AppKit embedded in Bun's main thread (`renderer.rs` `update_window*`) | separate `gpuix-ui` thread fed by `UiCommand` over a channel; Kybern's hooks reach it through `UiCommand::Run` (`platforms_hooks.py`) | same as Linux |
| Stock npm addon | darwin-arm64 | linux-x64-gnu | win32-x64-msvc |

GPUI already ships cross-platform services that Kybern reaches for through
AppKit or shell-outs today:

- credentials: `read_credentials` / `write_credentials`
- `show_system_notification`
- `open_url`, `reveal_path`
- `prompt_for_paths`, `prompt_for_new_path`
- clipboard
- `window_appearance`
- `WindowBackgroundAppearance::MicaBackdrop` (Windows 11)

## Inventory

Effort is in focused agent-days, including the checks described, but not
review. "Fallback" is what ships if the full port is not done yet.

### A. The patched addon did not compile off macOS (done in ADE-52)

| Item | Fix | Where |
| --- | --- | --- |
| `PrimitiveBatch::Backdrop` / `Primitive::Backdrop` hit exhaustive matches in the wgpu and D3D renderers | Arms that draw nothing (fallback: the tint quad shows) | `platforms_gpui.py` |
| ~40 napi methods call the macOS-only `update_window` / `update_window_without_view` | Generic UI-thread bridge, no hook rewritten; 12 "macOS-only" stubs now share the macOS body | `platforms_hooks.py`, [decision](#event-loop-decision) |
| `ContentMask` 16 → 24 bytes, WGSL/HLSL declared `Bounds` (Linux drew nothing) | Struct mirrored; rounded chain walk ported to WGSL and HLSL | `platforms_gpui.py` |
| `update.sh` was Mach-O/BSD only | Per-target names and steps; Git Bash on Windows | `native/update.sh` |

### B. GPU features written only for Metal

Rounded clip: done on both backends (ADE-52). The other rows are post-beta
parity (WP9); their fallbacks are what the spike runs today.

| Feature | Patches | Windows (HLSL) | Linux (WGSL) | Fallback | Effort per backend |
| --- | --- | --- | --- | --- | --- |
| Rounded `overflow:hidden` clip for paint and hit tests | `rounded_clip*.{py,rs}`, `rounded_clip_alpha` in `shaders.metal` | Port the SDF alpha + clip buffer | same in WGSL | **None acceptable**: rectangular clips break every card and pill, so this ships with the first build | 2–3 |
| Backdrop blur/saturation | `backdrop_gpui.py`, `backdrop_renderer.rs`, `backdrop.metal`, `backdrop_kernel*` | Two-pass blur in a D3D11 pixel shader on a copied back buffer; Mica for the window background | wgpu compute or two render passes | Opaque tinted fill (the existing reduced-transparency look) | 3–4 |
| Shimmer band / hue animations | `shimmer_band_gpui.py` | HLSL | WGSL | Static colour, as with Reduce Motion | 1 |
| Compositor loops (breathe/shimmer/rotate handed to Core Animation) | `compositor_loops_*` | DirectComposition animations later | none | `KYBERN_COMPOSITOR_LOOPS=0` scene path, already checked by `perf/motion-fps/lab-check.ts` | 0 (fallback), 4 for DComp |
| Partial-region presentation | `paint_region_*`, `paint_region.metal` | `Present1` dirty rects | wgpu has no partial present | Full-frame present (higher idle-animation cost; measure) | 0 / 3 |
| GPU clip simplification, drawable timing, telemetry, idle GPU release, image eviction | `gpu_clip*`, `frame_drawable_gpui.py`, `gpu_telemetry_gpui.py`, `memory_counters_gpui.py`, `image_memory_gpui.py`, `idle_memory_gpui.py` | Atlas counters from the DX atlas | wgpu atlas | Counters report 0; release on idle skipped | 2 |
| Frame waker + presentation timestamps (CVDisplayLink) | `frame_gpui.py`, `frame_clock.rs` | DXGI frame statistics / `DwmFlush` | Wayland frame callback / X11 Present | Timer-based waker at display rate | 1.5 |

### C. Text

| Feature | Where | Windows | Linux | Effort |
| --- | --- | --- | --- | --- |
| Variable `wght` axis | `font_weight_gpui.py`, `font_weight.rs` (CoreText) | DirectWrite font axis values | cosmic-text / fontdb variations | 2 each |
| Per-run text scale (`kszl`) | `text_scale_gpui.py` | DirectWrite | cosmic-text | 1 each |
| `register_font` for the bundled fonts | `apply_hooks.py:272-279` (macOS-only branch) | `text_system().add_fonts` is cross-platform: drop the gate | same | 0.5 |
| System fonts | `theme.ts:141-142` (`.SystemUIFont`, Menlo) | Segoe UI Variable / Cascadia Mono, or the bundled JetBrains Mono | Inter (bundle it) / JetBrains Mono | 1 |

### D. Window and input integration

| Feature | Where | Windows | Linux | Fallback | Effort |
| --- | --- | --- | --- | --- | --- |
| Traffic lights, title-bar drag and double-click | `window_drag.rs`, `nav/TitleBar.tsx`, `window_platform_hooks.py` | Custom caption buttons with `WindowControlArea` (Min/Max/Close) plus snap layouts | CSD on Wayland (`start_window_move` exists), server decorations on X11 | Native title bar | 2 + 2 |
| Window material (NSVisualEffectView, adjustable blur) | `native/material.ts`, `native/windowBlur.ts`, `shell/windowMaterial.ts`, `platform/translucency.ts`, `platform/material.ts` | Mica (Windows 11), opaque on 10; no equivalent of the adjustable blur: Solid/Auto only | Opaque; no equivalent of the adjustable blur: Solid/Auto only | Opaque | 1 |
| Close guard, key intercept | `close_guard.rs`, `apply_hooks.py` | `WM_CLOSE` / GPUI `on_should_close` | GPUI `on_should_close` | — | 1 each |
| Secure input | `secure_input.rs` (Carbon) | No equivalent; no-op | No-op | Already no-op | 0 |
| Automation test display | `automation_display.rs` (CoreGraphics) | Offscreen / second desktop | Xvfb or a headless Wayland compositor | — | 1 |
| ⌘ shortcuts | 26 files test `modifiers.cmd`; gpuix maps `cmd` to `platform`, which is the Windows/Super key off macOS | One `isPrimary(mods)` helper (Ctrl off macOS), with conflict review for the terminal (Ctrl+C) and editors | same | — | 2 |
| Window frame, appearance, visibility (objc FFI) | `shell/window.ts`, `shell/appearance.ts`, `native/visibility.ts`, `native/windowState.ts`, `locale.ts` | GPUI `window_appearance`; restore through GPUI window bounds; `Intl` locale | same | Already guarded: no system theme, no restore | 2 |
| Pointer-release watch | `split/Workspace.tsx:45`, `tasks/drag.tsx:77` guarded; **`preview/resize.tsx:16` unguarded, throws** | GPUI mouse-up capture | same | Guard `resize.tsx` (bug) | 0.5 |
| Reduce motion, transparency, contrast | `platform/material.ts`, `platform/reducedMotion.ts` | `SystemParametersInfo` via the addon | `org.freedesktop.appearance` portal, gsettings | Defaults | 1 each |

### E. Companion libraries

**Web view** (`native/webview.m`, 287 lines; `src/native/webview.ts`).
- **What it backs:** Preview, Visual, Artifacts and the mini-player, plus
  Mermaid (a hidden document returning an SVG that GPUI/resvg draws).
- **API:** a JSON command channel (`create` / `place` / `present` / `occlusion` /
  `navigate` / `post` / …) plus events.
- **Native behaviour it needs:** rounded clips, CA opacity/scale animation,
  occlusion masks, a custom `tauri://localhost/embedded/` scheme, an isolated
  content world, and Cmd-shortcut re-emission.

Ports:
- **Windows (8–12 days):** WebView2 `CompositionController` hosted in GPUI's
  DirectComposition tree. A child HWND cannot do the rounded clips, animation or
  occlusion. The rest maps directly:
  - `WebResourceRequested` for the scheme
  - `CoreWebView2Frame` script for the isolated world
  - `AcceleratorKeyPressed` for shortcuts
  - an InPrivate profile
  
  The same JSON channel stays, so `webview.ts` changes only its loader. Ship the
  Evergreen bootstrapper in the installer for Windows 10 machines without the
  runtime.
- **Linux:** GPUI is not GTK, and there is no X11/Wayland embedding that
  survives GTK4 or Wayland.
  - Phase 1 (3 days): a WebKitGTK helper *process* (its own GTK main loop, JSON
    over stdio) that renders Mermaid headlessly. Previews open in the
    browser (`xdg-open`) through the existing relay.
  - Phase 2 (10–15 days, risky): offscreen WPE WebKit into a wgpu texture with
    forwarded input.
- **Both platforms, interim:** the helper-process approach also gives Windows
  Mermaid before the composition host is done.

**Notifications** (`packaging/notifications.m`;
`src/native/notifications.ts`: `status` / `requestPermission` / `post` /
`onClick`). Replace the `.m` with addon napi methods over GPUI's
`show_system_notification` and `on_system_notification_response`.
- Linux: D-Bus `org.freedesktop.Notifications`.
- Windows: toast notifications. These need an AppUserModelID registered by a
  Start-menu shortcut that the installer creates.
- Effort: 2–3 days for both.

### F. JS platform services (`src/`)

Gather these behind one `src/platform/os.ts` (desktop-style), mostly backed by
GPUI APIs. Effort: 6–9 days total.

| Today | Files | Windows | Linux |
| --- | --- | --- | --- |
| `pbcopy` / `pbpaste` | `transcript/store.ts:89`, `notes/NoteMenu.tsx:17`, `composer/TokenTextarea.tsx:145`, `terminal/Terminal.tsx:326` | GPUI clipboard (addon) | same |
| `open`, `open -R` (Reveal in Finder) | `transcript/markdown.tsx`, `ThreadImage.tsx`, `dock/Diff.tsx`, `dock/Explorer.tsx`, `notes/NoteEditor.tsx`, `pulls/PrStates.tsx`, `preview/browser.ts`, `settings/external.ts` | GPUI `open_url` / `reveal_path` ("Show in Explorer") | `xdg-open` / D-Bus FileManager1 ("Show in Files") |
| `osascript` folder picker, admin prompt | `settings/external.ts:23`, `platform/cli.ts:156` | GPUI `prompt_for_paths`; no admin needed (per-user PATH) | same |
| `~/Library/Application Support`, `~/Library/Caches` | `settings/appearance.ts`, `platform/prefs.ts`, `environments/registry.ts`, `nav/live.ts`, `composer/store.ts` | `%APPDATA%`, `%LOCALAPPDATA%` | `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME` |
| Keychain (throws off macOS) | `environments/credentials.ts:35` | GPUI credentials → Credential Manager | Secret Service; file store (`KYBERN_GPUIX_CREDENTIALS_DIR`) when no keyring is running |
| Login-shell PATH, `/opt/homebrew/bin` | `shell/daemon.ts:100-102`, `platform/cli.ts:53` | Inherit the environment; `;` separator; `.exe` | `$SHELL -ilc` works |
| CLI install symlink | `platform/cli.ts` | Installer adds `bin` to the user PATH | `~/.local/bin` symlink |
| Save panel, clipboard image | `platform/files.ts` → `promptForNewPath` (macOS-gated hook) | GPUI `prompt_for_new_path` | same |
| `screencapture -l` | `transcript/live.ts:43` + verify scripts | Addon window capture | same |

### G. Packaging, updates, CI

| Item | Windows | Linux | Effort |
| --- | --- | --- | --- |
| App | `bun build --compile --target=bun-windows-x64`; `Kybern GPUIX.exe` + `gpuix-native.win32-x64-msvc.node` + `kybernd.exe` + `kybern.exe` + `kybern-webview.dll` | `bun-linux-x64` (glibc; baseline build if old CPUs matter); `.node` + daemon + CLI | 2 + 2 |
| Installer | NSIS per-user into `%LOCALAPPDATA%\Programs\Kybern GPUIX`, Start-menu shortcut carrying the AUMID, WebView2 bootstrapper. Unsigned like Tauri today (SmartScreen warning) until a certificate exists | AppImage (appimagetool, built on ubuntu-22.04 for the same glibc floor as Tauri) + `.deb` with a `.desktop` file and icon | 3 + 3 |
| Updater (`src/platform/update.ts`) | Keys `windows-x86_64-gpuix`; download the signed installer, run it silently `/S`, relaunch | `linux-x86_64-gpuix`; replace the AppImage in place (`$APPIMAGE`) and relaunch; `.deb` installs only announce | 2 + 2 |
| `updater-manifest.mjs`, `bundle-gpuix.*` | New asset names and keys | same | 1 |
| CI | `windows-2022` lane: build the addon from source (no display checks), package, sign the archive with the updater key | `ubuntu-22.04` lane: same, plus `libxkbcommon`/`wayland`/`vulkan` dev packages | 2 + 2 |
| Parity checks | The check harness relies on `screencapture`, Swift helpers and NSEvent synthesis. Move captures and input to the addon's automation API (already cross-platform) and run under a virtual display | Xvfb / headless Weston | 5–8 |

## Work packages

Re-estimated on 2026-10-22 from the spike. Effort is focused agent-days
including checks, not review. The previous plan ("9–12 agent-weeks, 5–7
calendar weeks with four lanes") summed its own table to roughly 70–95 days;
about 20 of those (the old WP0 and the rounded-clip half of WP1) are now done
in about 2 days, and the compile risk that sized the rest is gone. What is
left is ordinary platform work, mostly in TypeScript, plus packaging.

Ordered by when to start; the "Lane" column is a suggested split for parallel
agents (one OS-specific lane can split W/L).

| WP | Scope | Owns | Depends on | Days | Lane |
| --- | --- | --- | --- | --- | --- |
| WP0 | Forks + CI. Move to `Tresnanda/gpuix` and `Tresnanda/zed` with the patch queue as commits (planned separately). Then: `desktop.yml` lanes that build and cache the Linux/Windows addons (generalize `.github/actions/gpuix-addon` by target), run the app's unit tests there, and keep `gpuix-platforms.yml` as the on-screen check | `native/update.sh`, `.github/actions/gpuix-addon`, `.github/workflows/*gpuix*` | — | 2–3 (+ fork move) | A |
| WP1 | Native platform core: confirm Windows on screen at DPI 100/150 %; Wayland (a real GNOME/KDE session: headless Weston has no `wl_seat` and upstream `gpui_linux` unwraps it, `wayland/client.rs:832`); bridge cost: `()`-returning hooks send without waiting, count bridged calls per frame in `perf/bench`; unify scroll-phase injection; a frame-wake hook on Linux/Windows instead of the timer (Wayland frame callback / DXGI `WaitForVBlank`) | `native/patches/platforms_*`, `perf/bench` | WP0 | 3–5 | A |
| WP2 | JS platform services (section F): `src/platform/os.ts` over GPUI clipboard, `open_url`/`reveal_path`, path prompts, credentials (Credential Manager / Secret Service, file store fallback), config/cache dirs, PATH and `.exe`, CLI install, "This computer" copy, the `preview/resize.tsx` guard | `src/platform/**`, `src/environments/credentials.ts`, shell-out call sites | — (JS only; mock the addon) | 5–7 | B |
| WP3 | Window and input (section D): caption buttons and drag/snap on Windows (`WindowControlArea`), CSD buttons on Linux, title-bar double-click in JS, one `isPrimary(mods)` key helper with a conflict review (terminal Ctrl+C, editors), the rich-editor key interceptor off macOS, close guard and DPI checks | `src/nav/TitleBar.tsx`, key helper + call sites, `native/patches/{window_*,rich_editor}*` | WP1 | 6–8 | C |
| WP4 | Previews and Mermaid without the embedded web view: open previews in the default browser through the existing relay, Mermaid as static text (or SVG from a headless helper on Linux later) | `src/native/webview.ts` loader, `src/preview/browser.ts`, `src/transcript/mermaid.ts` | WP2 | 2–3 | B |
| WP5 | Notifications over GPUI (`show_system_notification`); Windows needs the AUMID from WP7's installer | `native/patches/notifications*`, `src/native/notifications.ts` | WP1 | 2–3 | C |
| WP6 (L/W) | Packaging and updater (section G): `bun build --compile` per target, AppImage + `.deb` (L), NSIS per-user installer with the AUMID shortcut (W), updater keys and in-place update, manifest entries | `scripts/package-app.ts`, `scripts/bundle-gpuix*`, `scripts/updater-manifest.mjs`, `src/platform/update.ts` | WP0 | L 5–6, W 6–8 | D |
| WP7 | Cross-platform check harness: run a first set of the native checks (`clip-check`, `rounded-check`, `markdown-document-check`, `focus-check`) through automation captures under Xvfb/lavapipe and WARP; `platform-smoke.ts` is the seed | `native/*-check.ts` capture helpers, `scripts/platform-smoke.ts` | WP1 | 4–6 | A |
| — | **Linux beta** = WP0–WP5 + WP6(L) + WP7 | | | ≈ 30–41 | 3–4 lanes: ≈ 2.5–3 calendar weeks |
| — | **Windows beta** adds WP6(W) and Windows-only fixes from WP1/WP3 | | | ≈ +6–10 | ≈ +1–1.5 weeks |
| WP8 | Text parity (section C): variable `wght` and `kszl` on DirectWrite and cosmic-text, system font choice | `native/patches/{font_weight,text_scale}*`, `src/theme.ts` | WP0 | 4–6 | after beta |
| WP9 | GPU parity: backdrop blur in WGSL and HLSL (scratch copy + two-pass blur), Mica on Windows 11 | `native/patches/platforms_gpui.py` (or fork commits) | WP0 | 6–8 | after beta |
| WP10 | Embedded web view: WebView2 composition host (W, 8–12); WebKitGTK/WPE (L, phase 2, 10–15, risky) | `native/webview-*/**` | WP3, WP4 | 18–27 | after beta |

Totals: about 36–51 agent-days to both betas, 28–41 more for full parity
(text, blur, embedded web view). With three or four lanes the Linux beta is
about 2.5–3 calendar weeks out and Windows 1–1.5 weeks after it.

Where the forks help (WP0 onwards):

- `platforms_gpui.py` edits shaders with anchored replacements and a regex that
  wraps every fragment `return`; as commits on `Tresnanda/zed` they become
  plain diffs to `shaders.wgsl`/`shaders.hlsl`, reviewable and rebased by git.
- The UI-thread bridge and the off-macOS fixes to upstream code
  (`elements_at`, painted-text readers) are upstreamable to GPUIX as commits.
- CI can key the addon cache on the fork SHAs instead of hashing the patch
  queue, and each platform lane can build from the same commit.
- Shader changes for Metal, WGSL and HLSL land in one commit, so a missing
  backend shows in review instead of as a blank Linux window.

## What needs real hardware or CI

- **Windows:**
  - D3D11 on Intel iGPU, NVIDIA and AMD
  - per-monitor DPI at 125/150/175 %, mixed-DPI monitor moves
  - Windows 10 (no Mica; WebView2 runtime may be missing) and Windows 11
  - SmartScreen and Defender behaviour for the unsigned installer
  - toasts after install (AUMID)
  - the silent-update relaunch
- **Linux:**
  - GNOME Wayland, KDE Wayland and an X11 session
  - Mesa (Intel/AMD) and NVIDIA proprietary drivers, where wgpu Vulkan can be
    absent and fall back to GL
  - fractional scaling
  - no-keyring sessions (Secret Service missing)
  - a notification daemon
  - AppImage without FUSE
- **Intel Mac:** see above (real Intel GPU, dual-GPU switching, macOS 13–15).

CI proves build, load, unit tests and software-rendered on-screen checks
(lavapipe, WARP). It cannot prove GPU drivers, compositors, DPI, installers or
energy: the spike's screenshots say nothing about real GPUs.

## Ship order

1. **Intel Mac**: shipped in v0.10.3.
2. **ADE-52 spike** (done): the patched addon builds for Linux and Windows and
   draws in CI (`gpuix-platforms.yml`); rounded clipping on both backends.
3. **WP0**: forks, cached addon lanes in `desktop.yml`; internal artifacts only.
4. **Linux x64 beta**: WP1–WP5, WP6(L), WP7. AppImage is simple and previews
   degrade to the browser. Offered next to Tauri, which stays the default.
5. **Windows x64 beta**: WP6(W) and the Windows halves of WP1/WP3.
6. **Parity**: WP8 text, WP9 backdrop blur and Mica, WP10 embedded web view;
   visual pairs and perf through WP7's harness.
7. **Tauri deprecation release** (below), once 4 and 5 have each had a release
   with no blocking regressions.

## Tauri deprecation end state

The final Tauri release (call it vT):

- **Every launch shows the popup:** "Kybern Desktop is no longer updated. Move to
  Kybern GPUIX". It offers one-click Install and open (`install_gpuix`, extended
  to download the Windows installer or the Linux AppImage), plus the manual
  command. `gpuixPromptRules.ts` gets a `deprecated` mode with no "shown once"
  record.
- **Its own updater checks are turned off.** This is required, not optional:
  `latest.json` keeps one top-level `version`, which will move past vT with
  GPUIX releases. A vT client polling it would then reinstall vT forever.
- **Installs from older Tauri versions still land on vT.** The manifest job
  stops building Tauri and copies vT's `darwin-aarch64`, `darwin-x86_64`,
  `linux-x86_64` and `windows-x86_64` entries from a checked-in
  `scripts/tauri-final.json`. Older Tauri clients, whose updaters still run,
  then update to vT and see the popup.
- **Then the rest of issue #113 follows:**
  - installers and the website default to GPUIX
  - README, `docs/`, `AGENTS.md` and `CLAUDE.md` mark `apps/desktop` retired
    (it stays as the visual reference until removed)
  - the Tauri CI and release jobs are deleted
