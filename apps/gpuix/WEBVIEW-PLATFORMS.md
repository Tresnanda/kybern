# Embedded web view on Windows and Linux (WP10)

This document is the design for WP10 of [PORTING-PLATFORMS.md](PORTING-PLATFORMS.md): the embedded web view behind
Preview, interactive HTML visuals (inline, tab and full-screen viewer, `await_answer` questions), Artifacts and
Mermaid. On macOS it is `native/webview.m` (`kybern-webview.dylib`) driven by `src/native/webview.ts` (`webHost`).
It covers decisions, evidence and a plan. Written 2026-10-26 against
`Tresnanda/zed@kybern` 7c2b5c6d4 and `Tresnanda/gpuix@kybern` 712950faa. **The Windows half is implemented**
(`native/webview-win`, see [Windows status](#windows-status-wp10)); Linux is still the plan below.

## Windows status (WP10)

Implemented 2026-10-26 as `native/webview-win` (Rust cdylib `kybern-webview.dll`, same three C exports and JSON
channel as `webview.m`), loaded by `webview.ts` on win32. `webHost.available` is true when the DLL is beside the app
and `GetAvailableCoreWebView2BrowserVersionString` finds a runtime (`kybern_web_available`); otherwise WP4's fallbacks
stay, with copy that names the reason (`runtime`: install the WebView2 Runtime; `missing`: reinstall).

**W-S1 passed: option C works.** `native/spikes/wp10/webview2-composition/src/bin/coexist.rs` builds GPUI's half
exactly (`WS_EX_NOREDIRECTIONBITMAP`, premultiplied composition swap chain on `CreateTargetForHwnd`) and adds a
WinComp `DesktopWindowTarget` with a WebView2 composition controller. On `windows-2022` (WARP, WebView2 131): with
GPUI's target topmost, `CreateDesktopWindowTarget(topmost)` fails with `DCOMPOSITION_ERROR_WINDOW_ALREADY_COMPOSED`
(0x88980800); with it not topmost both targets compose, and screen `BitBlt` and `PrintWindow(PW_RENDERFULLCONTENT)`
both show the page above GPUI, GPUI through a transparent page and outside a 32 px rounded corner, GPUI's popup
through a hole cut in an opaque part of the page, the bridge round trip, a forwarded click, and a CDP snapshot that
keeps alpha. Option B′ was not needed.

What differs from the plan above, and why:

- **Fork commits (zed `wp10-win`, two):** GPUI's DirectComposition target is not topmost (the one argument); and
  `translate_accelerator` in GPUI's message loop only handles GPUI's own windows. It sent `WM_GPUI_KEYDOWN` to every
  `WM_KEYDOWN` on the thread, WebView2's input window answered 0, and the key was dropped before
  `TranslateMessage`/`DispatchMessage`, so typing never reached a page. No window-procedure hook, HWND or scale export
  and no `run_on_ui_thread` were needed.
- **Getting onto the UI thread:** a `WH_GETMESSAGE` hook on GPUI's thread plus a registered message posted to a GPUI
  window (`Zed::Window`, found with `EnumWindows`); the hook runs the queued commands as the loop takes the message.
- **Pointer filter:** the companion subclasses GPUI's window (`SetWindowLongPtrW`) instead of a fork hook. Hit
  testing is `Mask::hit`, the same model as the composition clip. Presses capture the pointer until the last button
  is up, a second press in time and place becomes the double click WebView2 expects (GPUI's class has no
  `CS_DBLCLKS`), entering a page sends GPUI a `WM_MOUSELEAVE` so its hover clears, `WM_SETCURSOR` shows the page's
  `Cursor`.
- **Bridge:** `webDocument` and the Mermaid renderer are unchanged: a document-created script defines
  `window.webkit.messageHandlers.kybern` over `chrome.webview.postMessage` in the wrapper only.
- **`frame`, `navigate`, `action`, the picker:** `ICoreWebView2Frame2::ExecuteScript` in the child's own world (the
  plan's fallback; WebView2 has no content worlds). The child's script (document-created, also in the child) posts
  `navigation`, picker messages and the unhandled Escape through the frame's own `WebMessageReceived`, whose source is
  the frame's URL. A page can post these too; picker data is untrusted and re-bounded on every OS.
- **Hidden documents:** `IsVisible(false)` and `SetIsMuted(true)`; no `TrySuspend`.
- **`probe`:** reports `present`'s targets and whether its `CompositionScopedBatch` is still running.

| `webHost` op / behaviour | Windows | Evidence (CI, WARP) |
| --- | --- | --- |
| `create` (InPrivate, wrapper on `http://tauri.localhost/embedded/<id>`, ≤2 previews), `createDocument` | Native | loaded + bridge in the lab |
| `place` (rect, device mode, own radius, `roundedClips`) | Native (`CompositionGeometricClip`) | rounded corner pixels |
| `occlusion` holes, `dim`, `inputOnly` | Native | menu cut out, press on menu not in page, dim pixels |
| `hide` / visibility (placed, window shown, not minimized) | Native | hide/show, page gets `kybernVisible`, no reload |
| `present` fade + scale (cubic bezier, compositor clock) | Native | probe animating then settled |
| `probe` | Emulated (targets + scoped batch) | as above |
| `snapshot` | Emulated (CDP `Page.captureScreenshot`, fresh frame) | PNG 560×360, alpha 0 in the transparent part |
| `snapshotRect` | Native (CDP `clip`) | PNG written |
| `post` / `send` / `theme` / `navigate` / `action` | Native (`ExecuteScript`; child via `Frame2`) | round trip |
| `message` (wrapper only, `Source` checked) | Native | `kybern.answer.draft` from the daemon's `bootstrap.js` |
| `frame` / `frameMessage` | Emulated (child's own world, not isolated) | `frame` returns the page's values |
| Navigation policy, `externalNavigation`, `loaded`, `failed`, `terminated` | Native | no unexpected block or failure |
| `focus` / click to focus / `releaseFocus` / outside press | Native | typing reaches the page and not GPUI; outside press takes it back |
| Unhandled Escape | Emulated (bubble check after dispatch) | next key reaches GPUI |
| Ctrl shortcuts (`shortcut`) | Native (`AcceleratorKeyPressed`) | Ctrl+L re-emitted |
| `outsidePress` | Native | window points, not for presses inside |
| `capturePointer` | Native (filter off) | not exercised in CI |
| Wheel, double click | Native / synthesized double click | scroller scrolled, word selected |
| Transparent visuals | Native (background alpha 0 at creation) | GPUI through the page |
| Window occlusion by other windows | **Gap** (minimize and hide only) | — |
| IME, touch and pen, drag and drop, page accessibility | **Unverified / gap** (touch and pen are not forwarded) | needs hardware |
| DPI other than 100 %, per-monitor moves | **Unverified** (raw pixels, rasterization scale, re-place on `WM_DPICHANGED`) | WARP is 100 % |

Checks: `native/webview-win-check.ts` (`run-platform-checks.ts --checks webview`, Windows only) drives
`native/webview-win-lab.tsx` with real OS input and captures the composed window with `PrintWindow`. Packaging:
`kybern-webview.dll` and `mermaid.min.js` beside the exe; the NSIS installer carries Microsoft's Evergreen bootstrapper
and runs it per-user and silently only when the runtime's `pv` is missing (`packaging/README.md`).

## Recommendation

| OS | Host | Why |
| --- | --- | --- |
| Windows 10 1809+ / 11 | **WebView2 `CompositionController`, hosted in a Windows.UI.Composition `DesktopWindowTarget` (topmost) on GPUI's HWND.** GPUI's own DirectComposition target becomes not topmost, which is one argument changed in a fork commit. | It is the only option that gives arbitrary clip paths (rounded chains minus popup holes), compositor-driven fade and scale, and transparent pages. That makes it a 1:1 port of `webview.m`'s model, and `webview.ts` keeps its JSON channel. |
| Linux (X11 and Wayland) | **WPE WebKit (2.0 API, WPEPlatform) rendering offscreen into buffers that GPUI draws as a `PaintSurface` texture**, behind Kybern's own `WPEDisplay`/`WPEView` subclass on a dedicated GLib thread. | GPUI is not GTK and Wayland cannot place or stack a foreign window. A texture in GPUI's scene gets z-order, rounded clipping, transparency, animation, snapshots and hit-testing from GPUI itself. The fork already draws wgpu textures in the scene on Linux (`gpui_wgpu` `draw_surfaces`). |
| Both, interim | Pictures for resting visuals (already cross-platform through the daemon) plus WP4's browser fallback. Optionally an answer page served by the daemon, so `await_answer` works before WP10. | Without a live view, Windows and Linux cannot answer interactive questions at all. |

Effort: Windows **11–14 agent-days**, Linux **20–24 agent-days**. These replace the earlier 8–12 and 10–15; the
reasons are under [Plan](#plan). The riskiest unknowns are two things nobody has run yet: mixing a WinComp target
with a DirectComposition target on one HWND (W-S1), and building and sandboxing WPE inside an AppImage on Ubuntu 24.04
(L-S2, L-S3).

## What the web view has to do

`webHost` (`src/native/webview.ts`) sends JSON commands to the native library through three C exports
(`kybern_web_init`, `kybern_web_command`, `kybern_web_next`) and gets JSON events back. The same three exports
can back a `.dll` or a `.so`; `webview.ts` only changes its loader path. Call sites:

| Caller | Uses |
| --- | --- |
| `preview/Surface.tsx`, `Preview.tsx`, `resize.tsx` | `create` (`file`/`server`), `place` with device-mode layout, `hide`, `present` entrance, `theme`, `navigate`, `action` (back/forward/reload/stop), `destroy`, `shortcut` events, `capturePointer` during the dock resize |
| `transcript/Visual.tsx`, `visualDocs.ts` | `create` (`visual`, transparent page), `place` over the picture with `roundedClips` and `layer`, `present` fade, `send` (replayed click, lock), `snapshot` (freeze back to a picture at device scale), `outsidePress`, `releaseFocus`, message bridge (`kybern-visual-size/ready/draft/submit/escape/hover/link`), at most two documents (`MAX_DOCS`), warm reuse |
| `dock/Artifacts.tsx` | `create` (`visual`), `place`, `theme`, `destroy` |
| `transcript/mermaid.ts` | `createDocument` (never placed), `post` of the bundle and jobs, `message` results |
| `pick/hub.ts` | `documents`, `frame` (the picker script in an isolated world in the child frame), `focus`, `snapshotRect`, `frameMessage` |
| `native/web-occlusion.ts`, `composer/height.ts` | `occlusion` (popups, dialogs and the glass composer card cut out of documents below them; modal backdrops `dim` them) |
| `native/focusHandback.ts` | `releaseFocus` whenever GPUI moves focus itself |

The security model is shared with the daemon and does not change. Every document is a trusted wrapper page
(`webDocument`) served from a private scheme. It holds one sandboxed iframe with the daemon's URL. The daemon
sets the child's CSP: `previews/files.rs` `csp()` uses `sandbox allow-scripts allow-forms allow-modals` with no
`allow-same-origin` and `frame-ancestors tauri://localhost http://tauri.localhost http://localhost:1420 'self'`,
and `visuals.rs` `POLICY` uses `sandbox allow-scripts; default-src 'none'; …`. The child cannot reach the host
bridge. Only the wrapper may navigate top-level, frames stay on the ticket's origin, there are no popups, and the
data store is not persistent.

## Windows

### How GPUI owns the window

`gpui_windows` draws one Direct3D 11 swap chain. When DirectComposition is enabled (the default), the window gets
`WS_EX_NOREDIRECTIONBITMAP` (`window.rs:492`) and the swap chain is created with
`CreateSwapChainForComposition`, `DXGI_ALPHA_MODE_PREMULTIPLIED` (`directx_renderer.rs:1330-1351`). It is the content
of one `IDCompositionVisual` set as the root of `CreateTargetForHwnd(hwnd, true)`, which is **topmost**
(`directx_renderer.rs:1043-1060`). Popups, menus and dialogs are drawn into that same swap chain; there is no
second layer. The window procedure handles `WM_ACTIVATE` but not `WM_KILLFOCUS` (`events.rs:97`). So a child
input window taking keyboard focus does not deactivate GPUI.

### Options

| Option | Z-order with GPUI popups | Rounded clip chain | Transparent page | Fade/scale | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. Child HWND (`ICoreWebView2Controller`)**, as Tauri/wry do | GPUI's topmost DComp target draws *above* child windows ([CreateTargetForHwnd](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-createtargetforhwnd): `topmost` decides above/below child windows), so the page is hidden unless GPUI punches a hole | `SetWindowRgn`: 1-bit and aliased | No (a child HWND cannot blend with the parent's DComp content) | Opacity with a layered child at best; no scale | Rejected |
| **B. `CompositionController` in pure DirectComposition** (`RootVisualTarget` = an `IDCompositionVisual` in GPUI's tree) | Web visuals as children of GPUI's root visual sit above the swap chain. Popup holes are impossible: a DComp clip is only an `IDCompositionRectangleClip` (one rounded rect) | One rounded rect only | Yes | Yes (`IDCompositionAnimation`, cubic segments) | Fails the occlusion requirement (menus and the glass composer over pages) |
| **B′. Same, as an underlay with GPUI hole-punch.** Web visuals sit *below* GPUI's visual; a new GPUI primitive writes alpha 0 in the element's rounded clip, and later primitives (popups, dims) draw over it | Free: GPUI's own draw order | Free: GPUI's clip | **No.** Under a transparent visual there is nothing, so the desktop shows through the window, unless GPUI also copies the pixels painted before the punch into a backing surface each frame | Fade only by painting over it | Fallback if C fails (W-S1) |
| **C. `CompositionController` under a Windows.UI.Composition `DesktopWindowTarget`** (topmost) on GPUI's HWND; GPUI's DComp target moved to not topmost | Same model as macOS: documents above GPUI, each popup cut out of the documents below it | `CompositionGeometricClip` with a `CompositionPathGeometry` (any Direct2D path: rounded rect ∩ chain − holes) | Yes (`DefaultBackgroundColor` alpha 0) | `ScalarKeyFrameAnimation`/`Vector3KeyFrameAnimation` with `CubicBezierEasingFunction`, run by the compositor like Core Animation | **Recommended** |

Evidence for C:

- `RootVisualTarget` accepts "an IDCompositionVisual or a Windows::UI::Composition::ContainerVisual".
  With `CompositionController` the app forwards mouse input itself (`SendMouseInput`/`SendPointerInput`) and
  follows `CursorChanged`. [ICoreWebView2CompositionController](https://learn.microsoft.com/ja-jp/microsoft-edge/webview2/reference/win32/icorewebview2compositioncontroller).
- `CompositionGeometricClip` requires Windows 10 1809 (10.0.17763). `Compositor.CreatePathGeometry` dates from
  1803. Sources: [CompositionGeometricClip](https://learn.microsoft.com/uwp/api/windows.ui.composition.compositiongeometricclip),
  [CreatePathGeometry](https://learn.microsoft.com/en-us/uwp/API/windows.ui.composition.compositor.createpathgeometry?view=winrt-22621).
- `DefaultBackgroundColor` accepts alpha 0 or 255 only. That is enough, because visuals need a fully transparent
  page. Setting it through `ICoreWebView2ControllerOptions3` at creation avoids the white first frame.
  Sources: [ICoreWebView2Controller2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2),
  [ICoreWebView2ControllerOptions3](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions3).
- A window can have one topmost and one non-topmost composition target. A second target with the same flag fails
  with `DCOMPOSITION_ERROR_WINDOW_ALREADY_COMPOSED`. That is why GPUI's target has to move to not topmost before
  the WinComp target can be topmost. This rule comes second-hand from
  [Microsoft Q&A](https://learn.microsoft.com/answers/questions/337407/directx-composition-issue.html?orderby=newest);
  the reference page excerpt did not show it.
- **Not verified:** that a WinComp `DesktopWindowTarget` and a DirectComposition target can coexist on one HWND.
  Both run on DirectComposition, and WinUI uses that for XAML islands, but nobody has run it here. Spike W-S1 tests
  it; option B′ is the fallback.

### The tree, per GPUI window (sketch in `native/spikes/wp10/webview2-composition/src/host.rs`)

```text
DComp target, not topmost (gpui_windows)        └─ GPUI swap chain
WinComp DesktopWindowTarget, topmost (addon)    └─ root ContainerVisual
                                                     └─ per document: clip ContainerVisual
                                                          offset/size, CompositionGeometricClip, Opacity, Scale, CenterPoint
                                                          ├─ web ContainerVisual   ← WebView2 RootVisualTarget (device-mode offset)
                                                          └─ shade SpriteVisual    ← black, alpha = occlusion `dim`
```

The WinComp tree needs a `DispatcherQueue` on the thread that owns the HWND, which is GPUI's `gpuix-ui` thread
under the ADE-52 [event loop decision](PORTING-PLATFORMS.md#event-loop-decision). That thread already pumps Win32
messages, and `CreateDispatcherQueueController(DQTYPE_THREAD_CURRENT)` rides on that pump. Every host operation runs
there through the existing `run_on_ui_thread` bridge. That is the Windows equivalent of `webview.m`'s
`dispatch_async(dispatch_get_main_queue(), …)`.

### Details

- **Clip and occlusion.** `mask.rs` ports `-[KybernWebHost mask]` as written. It takes the clip box with its own
  radius, intersects every `roundedClips` entry, subtracts every occlusion ordered above the document, applies
  `dim` as a shade, and treats `inputOnly` occlusions as pointer holes only. It is unit-tested. `host.rs` turns it
  into a Direct2D path (per-corner arcs, `CombineWithGeometry` INTERSECT/EXCLUDE), wraps that as an
  `IGeometrySource2D` through `IGeometrySource2DInterop`, and sets it as a `CompositionGeometricClip`. The same
  `Mask::hit` decides pointer routing, so painting and hit-testing cannot disagree. macOS has the same pairing:
  the `CAShapeLayer` mask plus `hitTest:`.
- **Present.** `present` maps to keyframe animations on the clip visual's `Opacity` and `Scale` about `CenterPoint`,
  with `CubicBezierEasingFunction(ease)`. A keyframe animation without a 0.0 key starts from the value on screen,
  which matches "eases from what is on screen". `probe` is a test seam; it reports the target values and whether
  the animation's `CompositionScopedBatch` has completed. WinComp has no presentation-value read, so this is
  emulated.
- **DPI.** `BoundsMode = UseRawPixels`, `ShouldDetectMonitorScaleChanges = false`, and `RasterizationScale = window
  scale`. Visual offsets are device pixels (`place` multiplies by the scale). GPUI handles `WM_DPICHANGED` and
  re-lays-out, so `place` arrives again with the new scale. Per-monitor moves at 125–175 % need real hardware.
- **Pointer.** One hook in `gpui_windows`' window procedure (a fork commit, like the macOS `NSEvent` local monitors)
  calls the addon's filter before GPUI handles `WM_MOUSE*`, wheel, `WM_SETCURSOR` and `WM_MOUSELEAVE`. If
  `Mask::hit` is true and pointer capture is off, the filter forwards the event with
  `SendMouseInput` and swallows it. It also does these:
  - Calls `SetCapture` while a button is down inside a document, so drags and text selection keep working outside
    the rect.
  - Emits `outsidePress` for live visuals.
  - Returns focus to GPUI on a press elsewhere, as the `mouseMonitor` does on macOS.

  `WM_SETCURSOR` over a document uses the `SystemCursorId` from `CursorChanged`. Double-click needs either
  `CS_DBLCLKS` on GPUI's window class or synthesized `LEFT_BUTTON_DOUBLE_CLICK` events (to check). Touch and pen go
  through `SendPointerInput` (later).
- **Keyboard and focus.** A press inside a document calls `MoveFocus(PROGRAMMATIC)`. Keys then go to WebView2's own
  input window, and GPUI does not deactivate because it ignores `WM_KILLFOCUS`. `releaseFocus` is a
  `SetFocus(gpui_hwnd)` on the UI thread. The ⌘ monitor becomes `AcceleratorKeyPressed`: with Ctrl held and the
  same key list (L R N B K J [ ] ↑ , \ and Alt+P), it emits `shortcut` and sets `Handled`. **Unhandled Escape is
  emulated.** WebView2 has no "the page did not handle this key" signal. `AcceleratorKeyPressed` fires *before* the
  page sees the key. A document-created script (bubble phase, `!e.defaultPrevented`) posts `escape` instead. A page
  can fake it, but all that does is give focus back to GPUI.
- **Transparency.** Visuals and Artifacts set `DefaultBackgroundColor` to 0,0,0,0 at creation. Previews stay opaque;
  the wrapper paints the theme background, as on macOS.
- **Wrapper scheme.** The wrapper is served at `http://tauri.localhost/embedded/<id>`. A `WebResourceRequested` filter
  answers it and gives 404 for every other path under the prefix, so nothing under it ever reaches the network.
  The daemon's `frame-ancestors` already lists `http://tauri.localhost`, so no daemon change is needed. Tauri uses
  this origin on Windows. The wrapper's `window.webkit.messageHandlers.kybern.postMessage` becomes
  `window.chrome.webview.postMessage`: the sketch uses a document-created shim, and the real port makes `send`
  per-platform in `webDocument`. `WebMessageReceived` on the `CoreWebView2` only fires for the top-level document;
  child frames need `ICoreWebView2Frame2` handlers, which are never added. The host also checks `Source` against
  the wrapper URL.
- **Isolated world (`frame`, picker).** WebView2 has no content-world API. The sketch uses CDP instead:
  1. `Runtime.addBinding` with `executionContextName: "KybernPreview"` exposes the binding only in that world.
  2. `Page.createIsolatedWorld` creates the world in the child frame.
  3. Results come back as `Runtime.bindingCalled` events.

  The child is cross-site (`tauri.localhost` vs the daemon's `127.0.0.1`), so it is an out-of-process iframe. The
  calls go to its session through `Target.setAutoAttach {flatten:true}` and `CallDevToolsProtocolMethodForSession`
  (`ICoreWebView2_11`). If this proves fragile, `ICoreWebView2Frame2::ExecuteScript` runs in the frame's main world.
  That gives up isolation, but `pick/hub.ts` already treats picker results as untrusted.
- **Snapshots.** `Page.captureScreenshot` takes a `clip {x,y,width,height,scale}`, which covers both `snapshot` and
  `snapshotRect`. It runs after `Emulation.setDefaultBackgroundColorOverride {a:0}` for transparent pages. It draws a
  fresh frame rather than "what is on screen". That is fine for freezing a visual back to its picture, and the
  existing 600 ms fallback to the daemon picture stays. `CapturePreview` is the simpler alternative; whether it
  keeps alpha is unverified.
- **Visibility and memory.** `SetIsVisible(false)` when hidden. GPUI's minimize/occlusion notifications map to
  `visibility` events. `TrySuspend` releases the renderer's tiles and timers after `hide`; macOS has no equivalent.
- **Multiple windows.** One `DesktopWindowTarget` per GPUI window. Moving a document between windows uses
  `put_ParentWindow` and re-parents its visual. macOS picks the first key window today; the same rule applies.

## Linux

### How GPUI owns the window

`gpui_linux` speaks X11 (`x11rb`) and Wayland (`wayland-client`) directly and draws with `gpui_wgpu` (Vulkan, or GL
as fallback; `wgpu_context.rs:343`). GTK is not involved. The surface alpha mode is premultiplied when the
compositor supports it (`wgpu_renderer.rs:419-440`). The fork already has a Linux `PaintSurface` that samples an
`Arc<wgpu::Texture>` in the scene (`scene.rs:1045`, `window.rs:4922` `paint_surface`, `wgpu_renderer.rs:1769`,
ported from gpui-ce #39/#121). `WgpuRenderer::gpu_context()` hands out the `Device`/`Queue`. Its fragment shader
clips only to the rectangular content mask (`shaders.wgsl` `fs_surface`). The rounded clip chain that ADE-52 ported
to the other primitives still has to be added to it.

### Options

| Option | Wayland | Z-order, rounded clip, transparency, fade | Cost | Verdict |
| --- | --- | --- | --- | --- |
| a. WebKitGTK in a `GtkPlug`/XEmbed child window | No: X11 only, and GTK4 removed `GtkPlug`/`GtkSocket` | XShape gives 1-bit holes and corners. A child X window cannot blend with GPUI's pixels. No scale animation | Small | Rejected |
| **b. WPE WebKit offscreen into a GPUI texture** | Yes: no window at all | All from GPUI's scene: popups are simply drawn after the surface, the clip is GPUI's, transparency is premultiplied alpha, fade/scale are paint transforms. `occlusion` becomes a no-op | Input, cursor, IME and "browser UI" (`<select>`, dialogs, context menu, file chooser) must be forwarded or drawn by Kybern; WPE has to be built and shipped | **Recommended** |
| c. WebKitGTK in its own transparent top-level window that follows GPUI's | No: a Wayland client cannot position its windows or stack them relative to another surface | Fragile stacking against GPUI popups even on X11; no rounded clip | Small | Rejected |
| d1. CEF off-screen rendering (`OnPaint` / `OnAcceleratedPaint` DMA-BUF) | Yes | Same as b | Chromium engine (same as Windows and the daemon renderer), mature OSR used by OBS's browser source and purego-cef2gtk. But it ships a whole Chromium (hundreds of MB) and we own its security updates. HiDPI quirk: some shared-texture builds emit 1× frames ([purego-cef2gtk](https://pkg.go.dev/github.com/bnema/purego-cef2gtk)) | Second choice, if WPE fails L-S2/L-S3 |
| d2. Servo | Embedding API pre-1.0; web compatibility gaps | — | — | Not yet |
| e. WebKitGTK 4.1 in a GTK3 `GtkOffscreenWindow` | Yes | Same as b, but software readback (`gtk_offscreen_window_get_pixbuf`) and synthetic GDK events | Distros ship and security-patch it (see packaging) | Fallback to b only for packaging reasons; GTK3 offscreen is a dead end |

Why WPE fits: its new platform API (WPEPlatform, `wpe-platform-2.0`) is built for embedders that own presentation. A
`WPEView` hands each frame to `render_buffer(view, buffer, damage_rects, n)`. The embedder calls
`wpe_view_buffer_rendered`/`_released` for flow control, and the buffer is a `WPEBufferSHM` or `WPEBufferDMABuf`
(`wpe_buffer_import_to_pixels` for CPU pixels). It also has:

- input through `wpe_view_event`
- cursors through `set_cursor_from_name`/`_bytes`
- `focus_in`/`focus_out`
- `get_accessible`
- preferred DMA-BUF formats

Sources: [WPEView](https://people.igalia.com/aperez/Documentation/wpe-platform/class.View.html),
[render_buffer](https://people.igalia.com/aperez/Documentation/wpe-platform/vfunc.View.render_buffer.html),
[WPEBuffer](https://people.igalia.com/aperez/Documentation/wpe-platform/class.Buffer.html).

There is a built-in headless display (`wpe_display_headless_new`), and the WebView has a `display` property (2.44+).
Sources: [DisplayHeadless](https://people.igalia.com/aperez/Documentation/wpe-platform-headless/ctor.DisplayHeadless.new.html),
[WebView.display](https://people.igalia.com/aperez/Documentation/wpe-webkit/property.WebView.display.html).

The older libwpe + WPEBackend-fdo path offers the same SHM export (`export_shm_buffer`, fdo 1.6+). WebKit's own
`HeadlessViewBackend` and GStreamer's `wpesrc` render that way, which shows that offscreen-to-pixels is a supported
use. Igalia describes WPEPlatform as superseding libwpe and backends; their posts put its stable release at 2.54 and
say the legacy API will then be deprecated. Sources:
[WIP 54](https://blogs.igalia.com/webkit/blog/2026/wip-54/),
[the WPE platform API](https://blogs.igalia.com/llepage/the-wpe-platform-api/),
[WPEBackend-fdo 1.6.0](https://wpewebkit.org/release/wpebackend-fdo-1.6.0.html). Target WPEPlatform; Debian sid
already ships 2.54.2.

WPE's GLib API also gives parity for free on several fronts:

| macOS feature | WPE equivalent |
| --- | --- |
| Isolated worlds | `WebKitScriptWorld`, and `webkit_user_content_manager_register_script_message_handler(manager, name, world_name)`, which gives `kybernFrame` in "KybernPreview" exactly as with `WKContentWorld` |
| Wrapper scheme | `webkit_web_context_register_uri_scheme("tauri")`: `tauri://localhost` as on macOS, already in `frame-ancestors` |
| Navigation policy | `decide-policy` |
| Non-persistent store | an ephemeral `WebKitNetworkSession` |
| Bridge API | `window.webkit.messageHandlers.kybern.postMessage`, the same JS as WKWebView |

So `webDocument` needs no change on Linux.

### Design

- **Thread.** The WebKit UI-process API is single-threaded GLib. The companion (`libkybern-webview.so`, Rust over
  WPE's C API) runs one thread with its own `GMainContext` and owns every `WebKitWebView` there. The JSON commands
  arrive on a channel. That thread takes the place of macOS's main queue.
- **Display.** A Kybern `WPEDisplay`/`WPEView` subclass, modelled on the headless one. `render_buffer` takes the
  buffer, uploads its damage rects into the document's `wgpu::Texture` (`Queue::write_texture`; `Device`/`Queue`
  are `Send + Sync`), and asks the GPUI window for a frame. On the next frame the document's element calls
  `paint_surface(bounds, texture, size)`. Release the buffer only after the upload, which bounds memory to one or
  two buffers per document. Start with SHM (`import_to_pixels`). DMA-BUF import into Vulkan through wgpu's HAL
  (`VK_EXT_external_memory_dma_buf`) is a later optimization, chosen on L-S4's numbers.
- **GPUI side.**
  - Add rounded clip-chain alpha to `fs_surface` (WGSL and HLSL). The HLSL half is unused on Windows, but the
    shared commit keeps the backends aligned.
  - Make `PaintSurface` honour Kybern's paint-only opacity and subtree transforms, so `present` fades and scales
    happen in-scene.
  - Pointer and scroll events are ordinary GPUI events on the document's element, converted to `wpe_event_*`.
    `occlusion` and `capture` become no-ops because GPUI's own hit-testing already sees popups above the surface.
- **Keyboard and IME.** While a document has focus, its element forwards key events as `wpe_event_keyboard_new`.
  That needs the keyval and the hardware keycode, so the fork's `KeyDownEvent` must expose the raw keycode it
  already has from xkb. Text input goes through WPE's input-method context to GPUI's input handler. Escape uses the
  same document-created script as Windows. Shortcuts are intercepted in GPUI before forwarding.
- **Browser UI that GTK would otherwise provide** (WPE has no toolkit):
  - `<select>` popups (`show-option-menu`): a GPUI menu
  - `alert`/`confirm`/`prompt` (`script-dialog`): a GPUI dialog
  - context menu: a GPUI menu, or disabled as on macOS visuals
  - file chooser: the XDG portal, already used by WP2
  - tooltips (`mouse-target-changed`)
  - downloads: refused

  Without these, `alert()` blocks the page.
- **Snapshots.** The last buffer is the document as it looks now, at device scale. `snapshot` encodes it as PNG.
  `snapshotRect` crops it after reading the wrapper's iframe box, the same probe as macOS. This is exact and costs
  no extra frame.
- **Scale.** Device scale goes to WPE as the view/screen scale, and logical sizes stay logical. Fractional scaling
  on Wayland (`wp_fractional_scale_v1`) and X11 `Xft.dpi` follow GPUI's scale factor.

## Feature parity matrix

**Native**: a direct platform equivalent. **Emulated**: same behaviour through a different mechanism (named).
**Gap**: not available, with the fallback.

| `webHost` / native behaviour | macOS (`webview.m`) | Windows (WebView2 + WinComp) | Linux (WPE → GPUI texture) |
| --- | --- | --- | --- |
| `create` (wrapper over private scheme, sandboxed child, non-persistent store, ≤2 previews) | WKWebView, `tauri://`, `nonPersistentDataStore` | Native: `WebResourceRequested` on `http://tauri.localhost/embedded/`, InPrivate controller | Native: `register_uri_scheme("tauri")`, ephemeral network session |
| `createDocument` (hidden renderer for Mermaid) | Never-placed WKWebView | Native (never placed, `IsVisible` false) | Native (no texture uploads while unplaced) |
| `place`: rect, clip, device-mode layout | NSView frame + wrapper `kybernLayout` | Native: visual offset/size + `SetBounds` | Native: element bounds + `wpe_view_resized` |
| `place`: own radius + `roundedClips` chain | `CAShapeLayer` mask path | Native: `CompositionGeometricClip` (Direct2D path) | Native: GPUI clip chain (needs `fs_surface` chain) |
| `occlusion`: holes for popups/composer | Path subtraction + hit-test holes | Native: path subtraction + `Mask::hit` | Native and simpler: the page is in GPUI's draw order; op is a no-op |
| `occlusion` `dim` (modal backdrop) | Shade view | Native: shade `SpriteVisual` | Native: GPUI draws the backdrop over the surface |
| `hide` / visibility (window hidden, minimized, occluded) | `NSWindowOcclusionState`, media suspended | Native: `IsVisible` + `TrySuspend`; window occlusion from GPUI | Native: `wpe_view_unmap`/visibility; occlusion from GPUI (Wayland gives little) |
| `present` fade + scale with cubic-bezier, compositor-driven | Core Animation | Native: WinComp keyframe animations + `CubicBezierEasingFunction` | Emulated: GPUI paint-only opacity/transform, frames rendered by the app (not off-thread) |
| `probe` (test seam) | Presentation layer | Emulated: targets + scoped batch | Native: GPUI paint state |
| `snapshot` (PNG at device scale, as on screen) | `takeSnapshot` | Emulated: CDP `Page.captureScreenshot` (fresh frame) | Native: last buffer → PNG (exact) |
| `snapshotRect` (CSS rect in child frame) | `takeSnapshot` with rect | Native: CDP `clip` | Native: crop of last buffer |
| `theme` / `send` / `post` (host → page script) | `evaluateJavaScript` | Native: `ExecuteScript` | Native: `webkit_web_view_evaluate_javascript` |
| `message` (page → host, wrapper only) | `kybern` handler, main frame only | Native: `WebMessageReceived` (top level only) + `Source` check | Native: `script-message-received::kybern` |
| `frame` / `frameMessage` (isolated world in child) | `WKContentWorld` "KybernPreview" | Emulated: CDP isolated world + world-scoped binding on the OOPIF session; fallback `Frame2.ExecuteScript` (not isolated) | Native: `WebKitScriptWorld` "KybernPreview" |
| `navigate` / `action` in child | Isolated-world script | Emulated: CDP or `ICoreWebView2Frame2::ExecuteScript` | Native: script world |
| Navigation policy (top level = wrapper, frames = allowed origins, no popups/schemes) | `decidePolicyFor…` | Native: `NavigationStarting`, `FrameNavigationStarting`, `NewWindowRequested`, `LaunchingExternalUriScheme`, `DownloadStarting` | Native: `decide-policy`, `create` signal refused |
| `externalNavigation`, `failed`, `terminated`, `loaded` events | Delegates | Native: same events + `ProcessFailed` | Native: `load-failed`, `web-process-terminated` |
| `focus` / click-to-focus | `makeFirstResponder` | Native: `MoveFocus` | Native: `wpe_view_focus_in` + GPUI focus on the element |
| `releaseFocus` (and on press outside, hide, Escape) | First responder → GPUI view | Native: `SetFocus(gpui_hwnd)` from the pointer filter | Native: GPUI focus moves; `focus_out` |
| Unhandled Escape gives focus back | `cancelOperation:` (only if the page left it) | Emulated: bubble-phase script (`!defaultPrevented`) | Emulated: same script (or the unhandled-key path of WPE, to check) |
| ⌘ shortcuts re-emitted while the page has focus | `NSEvent` local monitor | Native: `AcceleratorKeyPressed` with Ctrl | Native: GPUI sees keys before forwarding |
| `outsidePress` for live visuals | Mouse monitor | Native: pointer filter | Native: GPUI mouse-down outside the element |
| `capturePointer` (dock resize drag) | `hitTest` returns nil | Native: filter off | Native: GPUI capture |
| Cursor | WebKit | Native: `CursorChanged` → `WM_SETCURSOR` | Native: `set_cursor_from_name` → GPUI cursor style (bytes: gap, use default) |
| IME in page fields | WebKit | To verify (visual hosting keeps an input HWND) | Emulated: WPE input-method context ↔ GPUI input handler |
| `<select>`, JS dialogs, context menu, file chooser | WebKit/AppKit | Native (WebView2 draws them as its own popup windows) | Emulated: drawn by Kybern (see Design) |
| Transparent page (visuals) | `drawsBackground = NO` | Native: background alpha 0 (only 0/255 allowed) | Native: `set_background_color` alpha 0 |
| Accessibility of page content | WKWebView in AX tree | **Gap**: visual hosting needs the host to splice `AutomationProvider` into its UIA tree; GPUI uses AccessKit, which cannot host a foreign subtree today | **Gap**: `WPEView::get_accessible` exists, but GPUI's AccessKit tree has no foreign-subtree hook |
| Drag and drop into pages | WebKit | Gap until `ICoreWebView2CompositionController3::Drag*` is wired to GPUI's `IDropTarget` | Gap until WPE drag events are wired |
| Media suspended when hidden | `setAllMediaPlaybackSuspended` | Emulated: `TrySuspend` (suspends timers and media) | Native: `webkit_web_view_set_is_muted` + unmapped view throttling |

## Snapshots and pictures (do they remove live-view needs?)

A resting visual is a picture that the daemon drew (`visualPicture.ts` → `threads.visuals.snapshot`). The daemon
draws it with a Kybern-owned, checksum-pinned **Chrome for Testing `chrome-headless-shell` 154.0.8037.92**, driven
over CDP. It is installed lazily (about 120 MB). Builds are pinned for `mac-arm64`, `mac-x64`, `linux64`,
`linux-arm64`, `win64` and `win32`, and Windows unzips with PowerShell (`crates/kybern-daemon/src/visuals/preview.rs`
`release()`, `install()`, `Session::start`). So pictures already work on Windows and Linux daemons. Not verified on
a Linux desktop: the shell needs Chrome's system libraries, and the daemon's error text says so. Pictures are drawn
wherever the daemon runs, including remote daemons.

What pictures already cover:

- Every resting inline visual in the transcript: scrolling, clipping, fading under the composer, theme changes, the
  answered look (the `lock` key).
- Freezing back to a picture when `snapshot` is late or missing (`Visual.tsx` falls back to the daemon picture after
  600 ms). On Windows `snapshot` is a nicety, not a requirement.

What still needs a live view:

- Interacting with a visual, and especially **`await_answer` questions**: drafts and submit come from the live page.
- Previews of running dev servers (live reload, navigation).
- The Artifacts dock.
- Mermaid. It could move to the daemon's headless browser (one CDP `Runtime.evaluate` with the bundled Mermaid),
  which would remove the hidden renderer document on every OS. The cost is the lazy 120 MB browser install and
  remote daemons rendering diagrams. That is a product choice; see the questions.

An interim that is worth considering whatever else is decided: the daemon could serve an **answer page**, the visual
in the same sandboxed iframe, wrapped by a tiny daemon-served host. It would relay `kybern-visual-draft`/`submit` to
the existing answer RPC through a one-use ticket. The browser fallback (WP4) could then open it, and `await_answer`
would work on Windows and Linux before WP10 lands, and from any browser. About 2 agent-days.

## Dependencies and packaging

### Windows: WebView2 runtime

- Windows 11 includes the Evergreen runtime. "The vast majority" of Windows 10 devices have it, and "a small number"
  do not. Microsoft recommends shipping the runtime installer even in Evergreen mode
  ([distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution),
  [evergreen vs fixed](https://learn.microsoft.com/en-gb/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)).
- **Plan:** bundle the Evergreen **bootstrapper** (about 2 MB, downloads the runtime) in the NSIS installer
  (`packaging/windows/installer.nsi`). Run it only when the runtime is absent: check the
  `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` `pv` value in HKLM and HKCU, the documented method.
  Run it per-user so no UAC prompt appears. At runtime, if `GetAvailableCoreWebView2BrowserVersionString` fails,
  previews degrade to the WP4 fallback with "Install the Microsoft Edge WebView2 Runtime, then reopen Kybern" and a
  link. Fixed Version (bundling a runtime of about 180 MB) is not worth it.
- Loader: `webview2-com-sys` ships `WebView2LoaderStatic.lib` (x64, x86, arm64); link it statically so there is
  no extra DLL.
- License: the WebView2 SDK and runtime redistribution terms allow shipping the bootstrapper with the app. The
  runtime is Microsoft's and updated by Microsoft, so Chromium security fixes are not our job.
- User data folder: `%LOCALAPPDATA%\kybern-gpuix\WebView2`, never the install folder. The uninstaller deletes it.
- Windows 10 reached end of support on 2025-10-14 (ESU continues). 1809 is the floor for `CompositionGeometricClip`.

### Linux: WPE WebKit

Distribution packages cannot be relied on. Checked through the Launchpad API on 2026-10-26:

| Distro | WPE WebKit | WebKitGTK (for comparison) |
| --- | --- | --- |
| Ubuntu 22.04 | `wpewebkit` 2.36.0, release pocket only (no security updates since 2022) | 2.50.4 (security) |
| Ubuntu 24.04 | **not packaged** | 2.52.6 (security) |
| Debian sid | `libwpewebkit-2.0-1` 2.54.2: 32 MB download, 131 MB installed; depends on bubblewrap, xdg-dbus-proxy, libsoup3, GStreamer, ICU 78; built against glibc 2.43 ([packages.debian.org](https://packages.debian.org/sid/amd64/libwpewebkit-2.0-1)) | — |
| Fedora | not checked | — |

So **WPE ships inside Kybern's packages.**

- **Build.** Build WPE WebKit 2.54.x with WPEPlatform (and libwpe if still required) from source on the
  `ubuntu-22.04` lane, the same glibc 2.35 floor as Tauri and the GPUIX AppImage (PORTING-PLATFORMS G). Build only
  what is needed: no WebDriver, no GObject Introspection, GStreamer media optional. Cache the result by version.
  A cold WebKit build takes on the order of an hour or more on a 4-core hosted runner (unmeasured; spike L-S2), and
  the toolchain floor (GCC version WebKit 2.54 requires vs jammy's GCC 11) is unverified.
- **Size.** Roughly 130 MB installed for WPE alone per Debian's numbers, plus ICU, libsoup3 and whatever the
  AppImage cannot assume. Expect +60–90 MB compressed on the AppImage. This is an estimate; L-S2 measures it.
- **Layout.** A private `lib/kybern-webview/` with `RUNPATH`, the WebKit helper processes (`WPEWebProcess`,
  `WPENetworkProcess`) beside it, and `WEBKIT_EXEC_PATH` set by the companion. `.deb`/`.rpm` ship the same private
  copy because distros either lack WPE or lag.
- **Security updates are ours.** WebKit publishes security releases roughly monthly. Shipping WPE means a Kybern
  release per WebKit security release (WSA). That is an ongoing cost the Windows side does not have.
- **License.** WebKit is LGPL-2.1 (WebCore) plus BSD-2 (JavaScriptCore, WebKit). Dynamic linking from our
  companion is fine. The package must carry the license texts and offer the corresponding source (we build from
  upstream tarballs, so link those exact tarballs).
- **Sandbox.** WebKit's web processes run under bubblewrap (`bwrap`) with `xdg-dbus-proxy`. On Ubuntu 23.10+ AppArmor
  restricts unprivileged user namespaces, which `bwrap` needs unless it is the setuid system binary. Inside an
  AppImage that can fail, and the usual workaround is `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`. That is a
  real security regression for previews of arbitrary sites (spike L-S3). Prefer the system `bwrap` when present;
  otherwise warn and keep previews in the browser rather than running unsandboxed.

If L-S2 or L-S3 fail badly, the alternatives are CEF (Chromium, larger, same updating burden, robust sandbox) or
WebKitGTK from the distro, which is patched by the distro but needs option e's GTK3 offscreen hack. Both are
covered in [Options](#options-1).

## Security parity

| Guarantee | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Child page cannot reach the host bridge | Sandboxed iframe without `allow-same-origin` (daemon CSP) + handler accepts main frame only | Same daemon CSP; `WebMessageReceived` is top-level only and `Source` is checked; no host objects (`AreHostObjectsAllowed = false`) | Same daemon CSP; `script-message-received` checks the frame (main frame only) |
| Only the wrapper is top level; frames stay on the ticket's origins; no popups, downloads or external schemes | `decidePolicyForNavigationAction/Response` | `NavigationStarting` (also fires on redirects), `FrameNavigationStarting`, `NewWindowRequested` handled, `LaunchingExternalUriScheme` cancelled, `DownloadStarting` cancelled | `decide-policy` (navigation, new window, response), `create` returns NULL, downloads refused |
| Wrapper served only by the host, never the network | `tauri://` scheme handler | `WebResourceRequested` answers every URL under the prefix (404 for others). `.localhost` resolves to loopback in Chromium, so the filter must stay registered before the first navigation, as in the sketch | `tauri://` URI scheme handler |
| No persistent cookies/storage | `nonPersistentDataStore` | InPrivate controller (`IsInPrivateModeEnabled`) | Ephemeral network session |
| Host scripts isolated from page scripts | `WKContentWorld` | CDP isolated world + world-scoped binding (fallback is not isolated; picker data is re-bounded anyway) | `WebKitScriptWorld` |
| No DevTools or remote debugging | Not enabled | `AreDevToolsEnabled = false`; never pass `--remote-debugging-port`. A user who sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` already controls the machine | Inspector off (`enable-developer-extras` false) |
| Web content process sandbox | WebKit's XPC sandbox | Chromium sandbox (as in Edge) | bubblewrap; **at risk inside an AppImage on Ubuntu 24.04** (above) |
| Engine security updates | macOS updates | Evergreen runtime (Microsoft) | **Kybern releases** |

## Plan

Estimates are focused agent-days, including checks, excluding review.

### Windows (11–14 days)

| # | Item | Days | Proves in CI (`windows-2022`, WARP) | Needs hardware |
| --- | --- | --- | --- | --- |
| W-S1 | Spike: GPUI's DComp target not topmost + a WinComp topmost target on the same HWND, one WebView2 composition controller, geometric clip with a hole, a fade. Fallback B′ (hole-punch underlay) if it fails | 1 | Runs and renders; capture through Windows.Graphics.Capture or `PrintWindow` (GPUI's `captureScreenshot` never includes foreign visuals on any OS) | Real GPU: DWM composition |
| W1 | Fork commits in `Tresnanda/zed`: target not topmost; a window-procedure filter hook for mouse/cursor; expose the HWND and scale to the addon. In `Tresnanda/gpuix`: run host calls through `run_on_ui_thread` | 1 | Builds | — |
| W2 | `kybern-webview.dll` (Rust cdylib, same three C exports): environment, create/destroy/place/hide, wrapper serving, navigation policy, bridge, JSON events; `webview.ts` loader per OS and per-platform `send` in `webDocument` | 2.5 | `webview-check` subset on WARP | — |
| W3 | Mask, occlusion, shade, `present` animations, `probe` | 1.5 | Yes (pixels via capture) | — |
| W4 | Input: pointer filter, capture across drags, double-click, wheel, cursor, focus handoff, Escape script, Ctrl shortcuts, `outsidePress`, `capturePointer` | 2.5 | Synthetic `SendInput` on the runner desktop | Touchpads, pens, IME |
| W5 | CDP snapshots, isolated world on the OOPIF session, picker | 1.5 | Yes | — |
| W6 | DPI and visibility: rasterization scale, `WM_DPICHANGED` re-place, minimize/occlusion, `TrySuspend`, multiple windows | 1 | 100 % only | 125/150/175 %, mixed-DPI moves |
| W7 | Packaging: bootstrapper in NSIS, runtime check and fallback copy, user-data folder and uninstall | 1 | Install on the runner (it already has the runtime; unverified) | Clean Windows 10 without the runtime |
| W8 | Checks: port `webview-lab`/`webview-check` to Windows | 1.5 | Yes | — |

### Linux (20–24 days)

| # | Item | Days | CI (`ubuntu-22.04`/`24.04`, Xvfb + lavapipe) | Needs hardware |
| --- | --- | --- | --- | --- |
| L-S1 | Spike: WPE headless → pixels, transparency, injected input (`native/spikes/wp10/wpe-offscreen`, not run yet; see PoC) | 0.5 | Yes (container) | — |
| L-S2 | Spike: build WPE 2.54 + WPEPlatform on ubuntu-22.04 (glibc 2.35, toolchain), measure build time and size, run L-S1 against it | 2–3 | Yes (long build, cached) | — |
| L-S3 | Spike: web-process sandbox inside an AppImage on Ubuntu 24.04 (AppArmor userns), Fedora and a KDE distro | 1 | Partly (container lacks AppArmor) | Real Ubuntu 24.04 desktop |
| L1 | Fork: rounded clip chain in `fs_surface`; `PaintSurface` under paint-only opacity/subtree transforms; raw keycodes on key events | 1.5 | Yes (clip-lab variant) | — |
| L2 | Companion `libkybern-webview.so`: GLib thread, `WPEDisplay`/`WPEView` subclass, JSON channel, create/destroy/place/hide, `tauri://` scheme, `decide-policy`, script worlds, bridge, theme | 3 | Yes | — |
| L3 | Frame path: SHM damage uploads into a `wgpu::Texture`, frame requests, buffer release; measure; DMA-BUF import only if L-S4 says so (+3) | 2 | Yes (lavapipe) | Mesa Intel/AMD, NVIDIA |
| L-S4 | Measure: SHM cost for a 1600×1000 device-px preview at 60 fps; GL fallback backend draws `PaintSurface` | 0.5 | Yes | Real GPUs |
| L4 | Input: pointer, scroll (smooth and discrete), keyboard, IME, cursor names, focus, Escape, shortcuts | 3 | Synthetic | IME, touchpads |
| L5 | Browser UI: `<select>` menus, JS dialogs, context menu, file chooser via portal, tooltips | 2.5 | Yes | Portal on GNOME/KDE |
| L6 | Snapshots from the last buffer, `snapshotRect`, `present` through GPUI, visibility | 1 | Yes | — |
| L7 | Wayland and X11, fractional scaling | 1.5 | X11 only (headless Weston has no `wl_seat`, PORTING-PLATFORMS WP1) | GNOME/KDE Wayland, X11 session |
| L8 | Packaging: private WPE in AppImage and `.deb`, `WEBKIT_EXEC_PATH`, licenses and source offer, sandbox policy | 2 | Yes | AppImage without FUSE |
| L9 | Checks under Xvfb/lavapipe (`webview-check` subset, visual freeze pixels) | 1.5 | Yes | — |

### Order

1. W-S1, L-S1, L-S2, L-S3 first. They are cheap, and they decide between C and B′, and between WPE and CEF.
2. WP3 and WP4 before the rest. WP4's browser fallback is what ships if a spike fails.
3. Windows (W1–W8), because it is shorter, lower risk, and its engine is patched by Microsoft.
4. Linux (L1–L9).

The two OSes can run in parallel lanes. The shared JS work (loader, per-platform `send`, the Escape script, the
`snapshot` fallback) sits in W2.

### Riskiest unknowns

| Risk | Spike | If it fails |
| --- | --- | --- |
| WinComp topmost target + DComp target on one HWND does not compose, or WebView2 visual hosting misbehaves under it | W-S1 | B′: underlay + GPUI hole-punch, with a backing copy for transparent visuals (+2–3 days) |
| CDP on out-of-process iframes is unreliable in WebView2 | W5 | `Frame2.ExecuteScript` (not isolated) |
| IME and double-click under visual hosting | W4 | Synthesize; IME needs hardware testing |
| WPE 2.54 does not build on the glibc 2.35 / GCC 11 floor | L-S2 | Build on Debian 12 (glibc 2.36) and raise the floor, or ship CEF |
| No web-process sandbox inside the AppImage on Ubuntu 24.04 | L-S3 | System `bwrap` only; otherwise previews in the browser (no unsandboxed web content) |
| SHM frame copies too slow at HiDPI | L-S4 | DMA-BUF import through wgpu HAL (+3 days) |
| Accessibility of page content (both) | — | Documented gap; AccessKit foreign-subtree support upstream |

## Proof of concept

### Windows: `native/spikes/wp10/webview2-composition` (the sketch; `src/bin/coexist.rs` is W-S1, run in CI)

The shipped host is `native/webview-win`; this crate stays as the spike and its record.

This is a standalone crate with its own workspace, exact pins and nothing referenced by the app:

- `webview2-com =0.38.2` (WebView2 SDK 1.0.3650.58)
- `windows =0.61.3`, `windows-core =0.61.2`, `windows-numerics =0.2.0`

These are the same `windows` versions the zed fork uses, so COM pointers can be shared with `gpui_windows`.
`webview2-com` 0.39 has moved to `windows` 0.62.

Contents:

- `mask.rs`: the macOS mask and hit-test model. `cargo test` passes on macOS.
- `host.rs`, all of which type-checks against the real bindings:
  - the WinComp `DesktopWindowTarget` on a given HWND
  - an InPrivate `CompositionController` with `RootVisualTarget`
  - raw-pixel bounds and rasterization scale, transparent background for visuals
  - the wrapper served from `http://tauri.localhost/embedded/<id>`
  - navigation policy (top level, frames, popups)
  - the message bridge with a `Source` check
  - `CursorChanged`, Ctrl-shortcut re-emission
  - `place`, the Direct2D path → `CompositionGeometricClip` with holes, the dim shade
  - `present` with cubic-bezier keyframe animations
  - the pointer filter (`SendMouseInput`, focus on press)
  - CDP snapshots with a transparent background, the isolated world plus a world-scoped binding on a session
  - `TrySuspend`, `destroy`

Commands run on macOS (aarch64 host, `x86_64-pc-windows-msvc` target installed):

```text
cargo test                                            # mask: 1 passed
cargo check  --target x86_64-pc-windows-msvc          # Finished, 0 errors
cargo clippy --target x86_64-pc-windows-msvc          # 0 warnings
```

A deliberately wrong line in `host.rs` produced E0308 under the Windows target, which shows the module really is
type-checked. **What this proves:** every API the design relies on exists in the pinned bindings with the assumed
shapes, and the Windows host is about 600 lines. **What it does not prove:** anything at runtime, especially W-S1.

### Linux: `native/spikes/wp10/wpe-offscreen` (written, not run)

`offscreen.c` creates WPE's headless display and a `WebKitWebView` on it with a transparent background. It loads a
page with a 50 % red rounded box and receives frames through `WPEView::buffer-rendered`. It imports each frame with
`wpe_buffer_import_to_pixels` and checks:

- alpha 0 outside the box and about 128 inside
- a pointer click injected with `wpe_view_event` changes the page title
- time to first frame and per-frame import cost

`run.sh` builds and runs it in a throwaway `debian:sid-slim` container (`wp10-wpe-offscreen`, WPE 2.54.2).

**It was not run.** OrbStack's Docker engine stopped answering during this session: `docker ps` hung, and
`curl --unix-socket ~/.orbstack/run/docker.sock /_ping` timed out repeatedly over about an hour. OrbStack is shared,
and the task rules forbid restarting it. Running `./run.sh` is the next step; it is L-S1. The C was written against
the documented API and has not been compiled. Expect small fixes, most likely the exact `wpe_event_pointer_button_new`
argument list and the pkg-config module names, which the script discovers.

## Open questions for the user

1. **Windows runtime.** Ship the ~2 MB Evergreen bootstrapper in the installer, so first install on a bare
   Windows 10 needs the internet and adds about 1 min? The alternatives are to never install it (previews fall back
   to the browser on those machines) or the offline installer (much larger).
2. **Linux engine.** Bundle WPE and take on a Kybern release per WebKit security release (+60–90 MB AppImage,
   estimated), or ship Linux with the browser fallback only and revisit? CEF is the heavier but more robust
   alternative if the WPE spikes fail.
3. **Unsandboxed web content.** If the WebKit sandbox cannot run inside the AppImage on Ubuntu 24.04, should
   previews stay in the browser there (recommended), or run unsandboxed with a warning?
4. **`await_answer` before WP10.** Build the daemon-served answer page (about 2 days), so Windows and Linux users
   can answer interactive questions in a browser now?
5. **Mermaid.** Move rendering into the daemon's headless browser on every OS (one renderer, no hidden document;
   needs the lazy 120 MB browser and renders on remote daemons), or keep it in the embedded view per OS?
6. **Floors.** Is Windows 10 1809 acceptable as the minimum for the embedded view, and is a raised glibc floor
   acceptable for Linux if WPE needs a newer toolchain than ubuntu-22.04?

## Sources

- Code: `apps/gpuix/native/webview.m`, `apps/gpuix/src/native/webview.ts`, `web-occlusion.ts`, `focusHandback.ts`,
  `transcript/{Visual.tsx,visualDocs.ts,visualPicture.ts,mermaid.ts}`, `dock/Artifacts.tsx`, `pick/hub.ts`,
  `crates/kybern-daemon/src/previews/{files.rs,bridge.js}`, `crates/kybern-daemon/src/visuals.rs`,
  `crates/kybern-daemon/src/visuals/preview.rs`.
- Fork (`Tresnanda/zed@kybern` 7c2b5c6d4): `crates/gpui_windows/src/{directx_renderer.rs,window.rs,events.rs}`,
  `crates/gpui_wgpu/src/{wgpu_renderer.rs,wgpu_context.rs,shaders.wgsl}`, `crates/gpui/src/{scene.rs,window.rs}`,
  `Cargo.toml` (`windows` 0.61, `wgpu` 29.0.4).
- Crates: `webview2-com` 0.38.2 / `webview2-com-sys` 0.38.2 (CHANGELOG: SDK 1.0.3650.58); crates.io lists 0.39.1
  (2026-03-11, `windows` 0.62).
- WebView2: [CompositionController](https://learn.microsoft.com/ja-jp/microsoft-edge/webview2/reference/win32/icorewebview2compositioncontroller),
  [Controller2 background](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2),
  [ControllerOptions3](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions3),
  [distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution),
  [evergreen vs fixed](https://learn.microsoft.com/en-gb/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version).
- Composition: [CreateTargetForHwnd](https://learn.microsoft.com/en-us/windows/desktop/api/dcomp/nf-dcomp-idcompositiondevice-createtargetforhwnd),
  [two-target limit (Q&A)](https://learn.microsoft.com/answers/questions/337407/directx-composition-issue.html?orderby=newest),
  [CompositionGeometricClip](https://learn.microsoft.com/uwp/api/windows.ui.composition.compositiongeometricclip),
  [CreatePathGeometry](https://learn.microsoft.com/en-us/uwp/API/windows.ui.composition.compositor.createpathgeometry?view=winrt-22621).
- WPE: [WPEView](https://people.igalia.com/aperez/Documentation/wpe-platform/class.View.html),
  [render_buffer](https://people.igalia.com/aperez/Documentation/wpe-platform/vfunc.View.render_buffer.html),
  [WPEBuffer](https://people.igalia.com/aperez/Documentation/wpe-platform/class.Buffer.html),
  [DisplayHeadless](https://people.igalia.com/aperez/Documentation/wpe-platform-headless/ctor.DisplayHeadless.new.html),
  [WebView.display](https://people.igalia.com/aperez/Documentation/wpe-webkit/property.WebView.display.html),
  [WPE 2.50.0](https://wpewebkit.org/release/wpewebkit-2.50.0.html),
  [WIP 54](https://blogs.igalia.com/webkit/blog/2026/wip-54/),
  [the WPE platform API](https://blogs.igalia.com/llepage/the-wpe-platform-api/),
  [WPEBackend-fdo 1.6.0](https://wpewebkit.org/release/wpebackend-fdo-1.6.0.html),
  [Debian libwpewebkit-2.0-1](https://packages.debian.org/sid/amd64/libwpewebkit-2.0-1); Ubuntu versions from the
  Launchpad API (`getPublishedSources`, wpewebkit/webkit2gtk, jammy/noble).
- CEF OSR: [purego-cef2gtk](https://pkg.go.dev/github.com/bnema/purego-cef2gtk).

Not verified in this run: anything at runtime on Windows or Linux; WinComp + DComp coexistence; WebView2 IME under
visual hosting; `CapturePreview` alpha; WPE build floor, size and sandbox in an AppImage; Fedora packages; whether
the `windows-2022` image ships the WebView2 runtime.
