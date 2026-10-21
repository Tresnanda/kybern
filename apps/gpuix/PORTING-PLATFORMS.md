# Porting GPUIX to Intel Mac, Windows and Linux

Issue #113: retire the Tauri app (`apps/desktop`) once Kybern GPUIX runs
everywhere Tauri ships. This document says what is macOS-only today, how each
piece moves to Windows and Linux (or degrades gracefully), the work packages
that can run in parallel, what needs real hardware, and the ship order.
It is based on the code at `feat/gpuix-intel` (GPUIX 0.10.0, Kybern 0.10.2),
not on upstream documentation.

| Platform | Tauri | GPUIX |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg`, `.app.tar.gz` | `kybern-gpuix_<v>_aarch64.app.tar.gz` |
| macOS Intel | `.dmg`, `.app.tar.gz` | `kybern-gpuix_<v>_x86_64.app.tar.gz` (this branch) |
| Windows x64 | NSIS `-setup.exe` (unsigned) | none |
| Linux x64 | `.AppImage`, `.deb` | none |

## Intel Mac (done on this branch)

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
| gpuix event loop | AppKit embedded in Bun's main thread (`renderer.rs` `update_window*`, macOS-gated) | separate UI thread fed by `UiCommand` over a channel | same as Linux |
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

### A. The patched addon does not compile off macOS (blocking)

| Item | Where | Fix | Effort |
| --- | --- | --- | --- |
| New `PrimitiveBatch::Backdrop` / `Primitive::Backdrop` variants hit exhaustive matches | `backdrop_gpui.py`; unpatched `gpui_wgpu/src/wgpu_renderer.rs:1461`, `gpui_windows/src/directx_renderer.rs:369` | Add arms (no-op first, real filter in C) | 0.5 |
| ~40 new napi methods call the macOS-only `update_window` / `update_window_without_view` (82 call sites after patching vs 40 upstream) | `apply_hooks.py:370-478`, `clipboard_hooks.py`, `window_platform_hooks.py:26`, `frame_hooks.py`, `convo9_hooks.py`, `markdown_document_hooks.py`, `code_small_hooks.py`, `idle_memory_hooks.py`, `flick_bounds_hooks.py` | See the event-loop decision below | 2 (spike) + 4–8 |
| `ContentMask` grows 16 → 24 bytes (`rounded_clip`, `clip_generation`); Metal headers are cbindgen-generated, but WGSL/HLSL still declare `content_mask: Bounds` | `rounded_clip_gpui.py`; `shaders.wgsl:1153`, `shaders.hlsl:505` | Mirror the struct in both shader languages (rounded alpha can come later) | 1 per backend |
| `update.sh` is Mach-O/BSD only | `align_strtab.py`, `codesign`, `sed -i ''`, `.dylib` → `.node` rename, clang `-framework` | Branch per OS, or a Bun `update.ts`; output `gpuix-native.{linux-x64-gnu,win32-x64-msvc}.node` | 1.5 |

**Event-loop decision (spike first).** There are two ways to make those ~40
hooks portable:

1. **Keep upstream's off-macOS model.** Port each hook to `send_ui_command`.
   Every closure becomes `Send`, and napi `ThreadsafeFunction`s and `Rc` state
   must stay on the JS side. This is mechanical but touches every hook, and
   each future hook needs two versions.
2. **Pump GPUI on Bun's main thread on all platforms,** as on macOS:
   - Linux: dispatch calloop from a Bun-polled fd.
   - Windows: a `PeekMessage` pump on a Bun timer or message hook.
   
   Then `update_window` needs no macOS gate, and the hooks are written once.

The spike measures input latency, idle wakeups, and resize/modal-loop
behaviour (Windows' modal size loop blocks pumping) for option 2. Option 1 is
the fallback. Recommendation: spike option 2 for 2 days; take option 1 only if
the Windows modal loop or Wayland frame callbacks cannot be served from Bun's
thread.

### B. GPU features written only for Metal

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
| Window material (NSVisualEffectView) | `native/material.ts`, `platform/material.ts` | Mica (Windows 11), opaque on 10 | Opaque | Opaque | 1 |
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

They can run in parallel after WP0, with file ownership. One agent per package;
packages marked (W) or (L) can split by OS.

| WP | Scope | Owns | Depends on | Days |
| --- | --- | --- | --- | --- |
| WP0 | Event-loop spike, then compile breakers (A): renderer arms, `ContentMask` in shaders, `update_window` path, an `update.sh` that builds on Linux/Windows | `native/patches/apply_hooks.py`, `native/patches/*_hooks.py`, `native/update.sh` | — | 6–10 |
| WP1 (W/L) | Rounded clip, then backdrop, shimmer, frame waker (B) | `native/patches/{rounded_clip,backdrop,shimmer_band,frame}*` + new `*.hlsl.py` / `*.wgsl.py` hooks | WP0 | 7–9 each |
| WP2 | Text (C) | `native/patches/{font_weight,text_scale}*`, `src/theme.ts` fonts | WP0 | 4–6 |
| WP3 | Window and input (D) | `native/patches/{window_drag,close_guard,window_platform}*`, `src/nav/TitleBar.tsx`, `src/shell/{window,appearance}.ts`, `src/native/{material,visibility,windowState}.ts`, key helper + call sites | WP0 | 8–10 |
| WP4 | JS platform services (F) | `src/platform/os.ts` (new), `src/platform/{cli,files,prefs,material}.ts`, `src/environments/credentials.ts`, the shell-out call sites | none (JS-only; mock the addon calls) | 6–9 |
| WP5W | WebView2 host (E) | `native/webview-win/**`, `src/native/webview.ts` loader | WP0, WP3 | 8–12 |
| WP5L | WebKitGTK helper process + Mermaid; browser previews (E) | `native/webview-gtk/**`, `src/transcript/mermaid.ts`, `src/preview/browser.ts` | WP4 | 3 |
| WP6 | Notifications over GPUI (E) | `native/patches/notifications*`, `src/native/notifications.ts`, `packaging/notifications.m` (macOS keeps it) | WP0 | 2–3 |
| WP7 (W/L) | Packaging, updater, CI (G) | `scripts/package-app.ts`, `scripts/bundle-gpuix*`, `scripts/updater-manifest.mjs`, `src/platform/update.ts`, `.github/workflows/desktop.yml` gpuix job | WP0 | 7–9 each |
| WP8 | Cross-platform check harness (G) | `native/*-check.ts` capture/input helpers, `scripts/visual-pair.ts` | WP0 | 5–8 |

Totals: about 9–12 agent-weeks of work, or 5–7 calendar weeks with four lanes.
Windows is the larger half because of the WebView2 composition host and the
installer and AUMID work.

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

CI proves build, load, unit tests and offscreen render checks. It cannot prove
GPU drivers, compositors, DPI, installers or energy.

## Ship order

1. **Intel Mac** (this branch, v0.10.2). Same patches, cross-built, checked
   under Rosetta. One real Intel smoke test before or right after release.
2. **WP0** (spike + compile). CI builds Linux and Windows addons and runs unit
   tests; internal artifacts only.
3. **Linux x64 beta.** Requires WP1(L) rounded clip, WP2, WP3, WP4, WP5L, WP6,
   WP7(L). WGSL is one backend and AppImage is simple, and previews degrade to
   the browser. It is offered next to Tauri, which stays the default.
4. **Windows x64 beta.** Requires WP1(W), WP5W, WP7(W) on top of the shared
   packages.
5. **Parity hardening on both** with WP8 (visual pairs, perf), then backdrop
   blur and region present.
6. **Tauri deprecation release** (below), once 3 and 4 have each had a release
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
