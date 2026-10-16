# Patched GPUIX native module

The client runs on our own build of `@gpuix/native`: the upstream release in
`VERSION` plus the capabilities below. The upstream checkout is disposable; all
changes are reconstructed by the checked-in patches and anchored hooks.

## Rounded overflow and Explorer motion (round 7)

`overflow: 'hidden'` plus corner radii now clips descendant quads, glyphs, SVGs,
images, paths, surfaces, selection washes and backdrop filters. Nested rounded
rectangles form an analytic intersection in the Metal fragment shaders; ordinary
containers add no offscreen layer or extra render pass. The same mask chain gates
native hit testing, including prepaint hit tests. A pooled immutable chain is
shared by scene primitives, with generations for recycled slots so stale cache
keys cannot match a new shape. Cached replay and scoped paint preserve the clip
table. Completed frames reclaim unreferenced chains; storage follows peak visible
clipped content rather than scroll history.

Post-paint `ElementBoundsEvent.roundedClips` carries the immutable mask geometry
to embedded WKWebViews. Their AppKit layer masks intersect these shapes before
overlay occlusions, and native hit testing checks that same final path. Shape
snapshots are shared with cached bounds rather than allocated for every element.
The extension is currently Metal/macOS, like scene-local backdrops; the stock npm
addon retains rectangular clips. Radii follow GPUI's existing circular-corner
representation and clamping, not CSS elliptical corner radii.
The expanded `ContentMask` changes native primitive record sizes. These rebuild
hooks target Metal; WGPU's packed WGSL/WebGL records need a separate port before
reusing this patched GPUI checkout with that backend. The app loader selects the
local addon only on macOS arm64; other platforms retain their npm addon.

Implementation: `rounded_clip.rs`, `rounded_clip_gpui.py` (reconstructed by
`backdrop_gpui.py`), the backdrop shader/renderer, bounds snapshots and the embedded
webview bridge. `native/clip-check.ts` checks actual native corner pixels, masked
input, cached replay, virtual rows and code scroll/wrap in four modes.

```tsx
const caps = renderer.getMotionCapabilities?.()
// caps === { rotate: true, physicalSprings: true }; rotate means SVG rotation.
<motion.svg source={icon} initial={false} animate={{ rotate: open ? 90 : 0 }}
  transition={{ type: 'spring', stiffness: 360, damping: 32, mass: .6 }} />
```

`rotate` is degrees about the native SVG centre. `motion.svg` shares the div
wrapper's presence, generation, cancellation and completion behavior. The raw
`<svg motion={{ initial, animate, transition }}>` form also works. Arbitrary
div-subtree rotation remains unsupported. Physical springs use analytic
under/critical/overdamped solutions in seconds; a conservative displacement and
velocity envelope determines completion, without truncating at a zero crossing.
Supplying any physical parameter selects that model (defaults 100/10/1); values
must be finite and positive and settle within 60 seconds. Without them, the
existing duration/bounce form is unchanged. Reduced motion uses `{duration:0}`.
`explorer_motion_hooks.py` and `physical_spring.rs` reconstruct this capability;
`native/explorer-motion-check.ts` verifies pixels and geometry in all four modes.

## Cached views

GPUIX rebuilds and lays out every element of the window on every frame. Any
animation (a loader tick, a 220 ms collapse) therefore pays for the whole
window. Zed and zeron avoid that with GPUI cached views: an unchanged view
replays its previous frame. The patch exposes that to React:

```tsx
<div cache style={{ width: 14, height: 14 }}>…</div>
```

In `scripts/island-lab.tsx` (300 rows, a loader ticking 10×/s) CPU drops from
9.4% to 3.9% with the rows and loader as islands. In the app (title bar, rail,
thread panel and content card are islands; 15 s samples, 2026-10-15):

| Scene | Loader ticks/s | Stock | Patched |
|---|---|---|---|
| Home, a thread running in the sidebar | 10 | 7.6% | 4.9% |
| Home, a thread running in the sidebar | 5 (default) | 4.3% | 2.8% |
| That running thread open | 10 | 10.7% | 9.9% |
| That running thread open | 5 | 6.0% | 6.0% |

These historical measurements predate virtual-row cache support. Current list-row
measurements and the resolved width-measurement issue are recorded below.

## Island rules

- **Definite size:** `width` and `height` in pixels or percent. Without both the
  element renders inline (no caching, no error). `cache="fill"` (`FILL_ISLAND`)
  is for a box its parent sizes (flex-grow, stretch).
- **Virtual-list rows are supported.** Every native row establishes full width
  before measuring percentage-sized islands; the cache still needs definite height.
- **No margins or position insets on the island itself;** put them on a parent.
  The island keeps its declared size (it does not flex-shrink).
- **Unchanged islands replay.** General changes (props, text, children, geometry, motion) invalidate the
  owning cached island and its cached ancestors. The scoped-paint path below
  skips render/layout for its narrow fill/opacity allowlist.
- **Text selection** and painted-text inspection are restored in document order
  on cached replay. Selection changes refresh the native paint, including the wash.
  Deferred overlay text is not included in these ordinary-paint snapshots; keep
  selectable overlay content outside a cached ancestor.
- **Automation** (`getByTestId`, bounds) keeps working: islands snapshot their
  bounds and re-record them when replayed.
- **New islands render inline on their first frame;** their view is created
  right after it. (Creating or touching a cached view's entity during a draw
  stops GPUI from tracking it, and it would replay stale paint forever.)
- `KYBERN_DEBUG_ISLANDS=1` logs wakes and re-renders.
- With the stock npm binary (`KYBERN_GPUIX_NATIVE=npm`), `cache` is ignored and
  everything renders inline.

## Files

| Path | What |
|---|---|
| `VERSION` | Upstream `@gpuix/native` release the patch targets |
| `patches/cache_island.rs` | The feature: island views, invalidation, bounds replay |
| `../scripts/island-lab.tsx`, `../scripts/island-check.ts` | The lab and the automated check (identity, hover, animation, late updates, lists) |
| `patches/apply_hooks.py` | Atomic anchored edits; refuses and names the anchor if upstream moved |
| `patches/patch_js.py`, `patches/patch_react.py` | Native bridge, motion identity, declarations; reproducible pnpm patches in `../patches/` |
| `tools/align_strtab.py` | Fixes Xcode 27 ld's misaligned LINKEDIT string pool, which dyld rejects |
| `update.sh` | Fetch → patch → build → repair → sign → load check → capability checks |
| `upstream/`, `build/` | Git-ignored checkout and build output |

## Staying current with GPUIX

```sh
apps/gpuix/native/update.sh 0.11.0   # new upstream release
```

It moves the checkout to the tag, re-applies the patch from scratch, builds,
bumps `@gpuix/react` + `@gpuix/native` on npm, recreates the JS patch and runs
the checks. If upstream moved code a hook anchors on, `apply_hooks.py` names the
anchor and writes nothing: adjust that one edit and rerun. Then run the app's
usual checks and commit `VERSION`, `patches/` and the lockfile.

Prerequisites: Rust 1.97.1 (from upstream's `rust-toolchain.toml`) and Xcode's
Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`). The first
build takes a few minutes and about 2 GB in `build/`.

## Window drag regions

`<div windowDrag>` marks an empty chrome area. The native hook uses
`WindowControlArea::Drag` and, on macOS, mouse-down calls
`Window::start_window_move()` (AppKit `performWindowDragWithEvent:`). A second
click calls `Window::zoom_window()`. This is a native gesture, not JS position
updates. The title bar opts in; its buttons and rename target explicitly use
`pointerEvents: 'auto'` to occlude the drag hitbox. A custom interactive child
inside a drag region must do the same.

Anchors: `lib.rs` → `mod cache_island;`; `renderer.rs` → `// Wire up events.`.
Implementation: `patches/window_drag.rs`; React forwarding includes `motion.div`.

`native-check.ts` verifies that controls remain clickable. The separate
`window-drag-check.ts` posts real events to its own lab, checks exact 60×36px
movement without resizing, double-click zoom, then a button click. It requires
macOS event-posting permission and refuses to click a covered window. This
shell reports `CGPreflightPostEventAccess() == false`; the physical gesture is
**not verified here**. Run that check from an already authorized terminal.

## Input keys before native actions

```tsx
<textarea interceptKeys={['up', 'down', 'enter', 'tab', 'escape']}
  onKeyDown={event => {
    if (menuHandles(event.key)) event.preventDefault()
  }} />
```

The editor owns an `App::intercept_keystrokes` subscription. It suppresses an
opted-in native binding, and a first root key listener retains the complete
`KeyDownEvent` (including `isHeld`, absent from the interceptor API). A token
crosses the existing JS event bridge. The handler synchronously decides with
`preventDefault()`; a `finally` block returns that decision. Native default
handling is replayed only if focus still belongs to the original editor.
Following keystrokes queue behind the decision to preserve typing order.
Marked IME composition bypasses interception. The queue is bounded to 256;
if JS is stalled beyond that, oldest entries are dropped instead of growing
memory. No polling timer or blocking JS callback is introduced.

Anchors: `element_tree.rs` → `pub is_held: Option<bool>` and `is_held: None`;
`renderer.rs` → `with_window_menu_actions(root)`, `pub fn zoom_window(&self)`;
`custom_elements/input.rs` → `state: Option<Entity<TextEditorState>>`,
`emits_key_down: bool`, `let prop_changed = ...`, `state.emits_key_down = ...`,
`"readOnly" =>`, `"maxRows",`, `self.state = None`, and
`editor.on_key_down(move |event, _window, _cx| {`.
`patch_js.py` hooks `dispatch(event)` and adds the reply method declaration.

The composer now handles menu arrows, Enter, Tab and Escape on key-down,
including repeat, and prevents only consumed actions. Modified arrows continue
to native editing. `native-check.ts` verifies all five cancelled actions,
held keys, unprevented Shift+Enter, and a batched Shift+Enter/character sequence. Native undo is unchanged. Full IME
integration with a real input method still needs a manual pass.

## Window close decisions

```tsx
import { setWindowCloseHandler } from '@gpuix/native/host'
useEffect(() => setWindowCloseHandler(renderer, async () => {
  return await confirmThreadsStillWorking()
}), [renderer])
```

`Window::on_window_should_close` vetoes immediately, emits a request, then
`resolveCloseRequest` removes the window only for the current allowed token.
The Window-menu/⌘W action goes through the same guard. Pending attempts coalesce;
Promise rejection vetoes. Cleanup removes the handler. This exposes the hook;
it does not install the app's close-guard dialog. The current renderer owns one
window; the guard is thread-local, not a multiwindow API.

Anchors: `renderer.rs` → `.on_action(|_: &CloseWindow, window, _cx| window.remove_window())`, and
`pub fn zoom_window(&self)` for `setCloseGuard`/`resolveCloseRequest`.
Implementation: `patches/close_guard.rs`; JS `dispatch(event)`/`STATE_KEY`.
`native-check.ts` verifies ⌘W veto, AppKit `performClose:` veto (the traffic-light
close path), continued interaction, Promise rejection, and successful close after permission.
This does not add an app-quit (⌘Q) guard.

## Deferred overlays inside islands

The old snapshot canvas ran before anchored/deferred children painted. After a
cached replay their automation bounds were absent ("Element has no painted
bounds") and clicks could not target them. The snapshot is now itself deferred
at the last priority, after the island's overlays. GPUI still owns hitbox replay;
our snapshot restores the retained-tree bounds used by automation.

The replay canvas must only restore **missing** bounds. On a changed island,
ordinary children have already painted their new coordinates, but the deferred
snapshot has not run yet. Unconditionally restoring the previous snapshot here
overwrote those new coordinates and captured the stale values again. The full
shell's Settings switch then received automation clicks at its old position;
Space still worked, and dock entrance checks read stale widths. This was an
automation-bounds regression, not the title-bar drag hook swallowing input.

The isolated bisect retained every other native extension: restoring the original
non-deferred snapshot made Settings clicks pass (but lost overlay bounds). The
focused regression moves a cached child 40px: the broken extension build reports
x=0 instead of x=40. Filling missing entries only preserves both fresh ordinary
bounds and deferred overlay replay. No hit-testing, drag, key, or motion behavior
was disabled.

`cache_island.rs` → `IslandView::render` and the replay canvas in `island_element`,
no new upstream hook.
`island-overlay-check.ts` first reproduced the missing bounds, then passed
three outside updates/cached replays, moved child coordinates/clicks, and overlay clicks. The normal five
island checks still pass. Their animation fixture uses a controlled clock so
another window covering the lab does not suppress the test animation. Overlays need not move to the app root solely to
avoid this failure. Ordinary text selection now survives replay (see selection API below).

## Secure single-line input

`<input secure>` keeps the edit buffer and onChange value in application memory,
but shapes bullets instead of its contents, maps Unicode byte offsets between
the two representations, and supplies a `PasswordInput` accessibility role and
masked value. Copy and cut do nothing. Automation inspection removes `value`
and `aria-valuetext`; painted text and `textContent()` expose no plaintext.
The prop applies only to single-line input. Do not also place the secret into
labels, child text, logs or other application-controlled properties.

GPUI has no secure-event-input API in this pinned fork. A balanced Carbon
`EnableSecureEventInput`/`DisableSecureEventInput` lease follows editor focus,
window activation and entity destruction. No new timer is used.

Anchors: `custom_elements/input.rs` → `impl TextEditorState`, editor construction,
`state.emits_key_down = ...`, `let default_role = if self.multiline`,
`if ctx.props.get("aria-valuetext")...`, `fn copy`, `fn cut`,
`let (display_text, is_placeholder)`, `fn point_for_index`,
`return (line_start + index).min(self.content.len())`, and the marked-range runs;
`retained_tree.rs` → `obj.insert("customProps"...)`.
Implementation: `patches/secure_input.rs`.

`secure-input-check.ts` passes with the nonsecret fixture `a😀é`: no value in
inspection/paint, unchanged clipboard after copy/cut, correct Unicode deletion,
and undo restoration. `NATIVE_AX_TEST=1` also requests an external AX-tree
inspection. It is blocked here (`AXIsProcessTrusted() == false`). The native
AX tree and secure-event-input activation/release still need an authorized
OS-level check before treating this as fully verified secret-entry UI.

## Highlighted code wrapping

`<code softWrap>` retains the existing highlighted `TextRun`s and native text
selection. GPUI `whitespace_normal`, a shrinkable text column, and auto-height
rows wrap at the available width; line numbers stay with their logical line.
Unwrapped mode keeps upstream horizontal scrolling. Transcript `CodeChunk`
now uses this instead of its plain-text fallback.

Anchors: `custom_elements/code.rs` → `show_line_numbers: bool`,
`for (line_ix, line)`, `if self.show_line_numbers`,
`content.child(row.child(ctx.text(...)))`, `.overflow_x_scroll()`,
`"showLineNumbers" =>`, and `prop_names`.
Implementation: `patches/code_wrap.rs`.
`code-wrap-check.ts`: a 300px block grows from 80px to 260px with soft wrap,
including Unicode and a long unbroken token.
The reviewed screenshot retains syntax colours and line numbers.

## Native springs and translation

```tsx
<motion.div initial={{ translateX: 0, translateY: 0 }}
  animate={{ translateX: 200, translateY: 20 }}
  transition={{ type: 'spring', duration: 0.25, bounce: 0.3 }} />
```

The existing Rust motion clock samples a closed-form damped spring. `duration`
is seconds, `bounce` is 0…1; zero is critically damped. This is an Apple-style
parameter API, not Apple's private curve. It settles exactly at the duration;
opacity and nonnegative dimensions are clamped. Retargeting preserves current
position but does not preserve velocity. Existing ease tweens remain unchanged.

Translation wraps a subtree in an `Element` that delegates layout and calls
`Window::with_element_offset` in prepaint/paint. Siblings do not reflow; hitboxes
move with paint. It is a motion property, not a general static style transform.

Anchors: `motion.rs` → `pub border_radius`, `fallback.border_radius`,
`target.border_radius`, `struct MotionTransition`, `duration: default_duration`,
`let progress = ease(...)`, `validate_ease(...)`, `("borderRadius", ...)`,
and the opacity/width/height/radius style assignments;
`renderer.rs` → `ctx.inherited = parent_inherited;
    built`.
`patch_react.py` adds translate values and spring parameters to motion identity.

`native-motion-check.ts` uses the paused native clock: a 200px translation
overshoots by 19.0px, ends at exactly 200×20px, leaves a sibling unchanged,
and remains clickable at its translated position. The spring unit check covers
finite output, endpoints and critical/underdamped behavior.

**Scale remains unsupported.** This GPUI fork has transform matrices on glyph
sprites, not a subtree scene transform for quads, shadows, paths, surfaces,
clip masks and hitboxes together. Scaling only cached paint would leave these
inconsistent. A faithful implementation needs coordinated scene + clip + input
support in GPUI. Use translation with opacity, or layout-changing width/height
where that behavior is intended; neither is presented as scale.

## Virtual-list cache ownership

The previously suspected speculative-prepaint fault was a width-measurement bug.
A cached view deliberately has no intrinsic content width. An unfocused list row
returned its child directly, so percentage-sized islands in an auto-width row
resolved to zero. `build_virtual_child` now gives these rows the same full-width
container already used for focusable rows. No GPUI fork changes are required.
The native entity remains owned by the island registry, keyed by retained node ID;
changed subtree revisions notify it before drawing. The inline-first-frame rule
and row identities remain intact. `KYBERN_INLINE_LIST_ISLANDS=1` restores the
old inline path for diagnostic A/B measurements; it is off by default.

`native/capability-check.ts` verifies changed row text, stable nonzero width after
scrolling, and selection across replay in both appearances. The existing island
check compares the whole virtual list pixel-for-pixel with inline rendering.
Its old output label still says "inline fallback"; the current default does not
use that fallback. The registry is pruned when retained nodes unmount; callers
must continue to bound their React history window, not mount unlimited history.

## Verification commands

`update.sh` runs typecheck, the six original background-window capability scripts,
the input/selection/font/list check, layout/syntax checks, and the scratch full-shell
pointer check serially.
The physical pointer and external AX checks are separate because they require
OS permissions. `scripts/native-perf.ts` samples one full app window against an
explicit data directory and thread. Use the scratch daemon for writes; live
real-daemon measurements are read-only. Keep only one window per worktree.

The generated `native/build` (about 1.9 GiB) and `native/upstream` (186 MiB)
are retained for the integrating agent, as requested. Free disk went from
73 GiB before the first native build to 68 GiB at completion; other agents
were working concurrently, so the total change is not solely this build.

## Extension performance (2026-10-15)

Apple M1, macOS 27.0 (26A428), Bun 1.4.0, GPUIX 0.10.0, 1280×820 background
window, 10-second warmup then a 15-second `perf/sample.ts` sample. Before is the
original islands binary (`build/baseline.node`); after is this extension build.
One window at a time; concurrent agents and varying occlusion limit precision.
GPU time is per-process Metal time, not GPU percentage or energy.

| Fixed full-app scene | Before CPU / footprint / GPU | After CPU / footprint / GPU |
|---|---|---|
| Settled scratch thread, no loader | 3.07% / 176 MiB / 8.1 ms | 3.20% / 180 MiB / 1.3 ms |
| Running fixture, two 5 Hz indicators, one live tool row | 8.27% / 174 MiB / 46.0 ms | 9.80% / 174 MiB / 54.3 ms |

The running fixture uses the actual app, sidebar and transcript virtual lists;
`native-perf-fixture.tsx` freezes scratch transcript data into a running state
in this process only. It makes no daemon writes. The 1.53-point CPU difference
is below the existing report's 3-point noise threshold; this is not evidence
of a speedup. Idle is close to the existing ~3% target, slightly above it.
No new continuous timer was added by the native capabilities.

For completeness, the changing live orchestrator thread (read-only real daemon,
no warmup) measured 14.87% / 182 MiB / 51.2 ms before and 18.87% / 180 MiB /
52.9 ms after. Its content changed between samples, so it is not a controlled
regression comparison. An initial scratch run became idle during measurement;
it was discarded as an active-workload comparison.

Reproduce the controlled scene with `KYBERN_DATA_DIR`, `KYBERN_GPUIX_THREAD`,
`NATIVE_PERF_FIXTURE=1 NATIVE_PERF_ACTIVE=1 NATIVE_PERF_WARMUP=10` and
`bun scripts/native-perf.ts <label>`. Omit the two fixture/active flags for idle.
Physical footprint is not RSS. Commit time, input latency and energy were not
measured. The optional selection-range API was not implemented.


## Pointer regression verification (2026-10-15)

`combined-pointer-check.ts` reproduces full-shell Settings pointer/Space input
against an explicit scratch `KYBERN_DATA_DIR`. Set `KYBERN_GPUIX_THREAD` to a
scratch thread to also check sidebar selection, titlebar dock toggle, completed
dock entrance, adding Notes, and collapse. `native-check.ts` additionally checks
an excluded titlebar button and a direct pointer click at y=47, one pixel below
the 46px drag region. These are GPUI automation events; OS event-posting and
physical window movement retain the manual-verification limitation above.

The fixed build passes all six scripts run by `update.sh`, including the island
pixel/hover/animation comparisons, and `pnpm typecheck`. `bun test ./src` passes
15 app tests / 54 assertions. Bare `bun test` also discovers the retained
`native/upstream` checkout: that unrelated suite fails on missing upstream
packages (including `goke`) and updater executable-symlink checks. No upstream
dependencies were installed to hide that distinction.

Controlled active-scene comparison on Apple M1, macOS 27.0, Bun 1.4.0,
GPUIX 0.10.0, 1280×820 background window: the full merged app with a scratch
thread, one user message, one live tool row, and two 5 Hz indicators through
`native-perf-fixture.tsx`. Each independent launch warmed for 10 seconds, then
sampled for 15 seconds. Before is the reproduced broken extensions build;
after changes only the missing-bounds replay guard. One fixture window at a time.

| Sample | CPU | Physical footprint | Process Metal GPU time |
|---|---:|---:|---:|
| Before 1 | 7.00% | 167 MiB | 81.2 ms |
| Before 2 | 9.20% | 169 MiB | 78.3 ms |
| After 1 | 8.73% | 171 MiB | 71.8 ms |
| After 2 | 9.33% | 186 MiB | 76.5 ms |

Mean CPU changed by +0.93 percentage points (8.10% → 9.03%), within the
existing 3-point noise threshold. GPU time is similar; this does not demonstrate
a speedup. Footprint was higher by 2–19 MiB across runs; two short samples do
not establish memory equivalence or a leak. Concurrent system work and window
occlusion limit precision. Commit timing, input latency, and energy were not
measured. The guard adds no timer, retained allocation, or cache entry.

Free disk was 73 GiB before and after. The requested incremental build directory
(1.9 GiB) and upstream checkout (186 MiB) remain for integration; temporary A/B
binaries and source copies, scratch data, daemon, and fixture windows were
removed/stopped. The signed, load-checked deliverable is
`build/gpuix-native.darwin-arm64.node`.

## Native API additions (package 1, 2026-10-15)

Import `nativeCapabilities` from `src/native/api.ts` and pass the renderer from
`useGpuixRequired()`. It checks the actual binary and throws a named capability
error for an older/stock module. These additions are macOS-only. No npm dependency
or lockfile change is needed; the interface is owned by this client.

```ts
const native = nativeCapabilities(renderer)
native.getInputSelection(id) // { start, end, reversed, composing }
native.setInputSelection(id, start, end, reversed)
native.editInput(id, { start, end, text, expectedValue })
native.getTextSelection() // [{ elementId, sub, start, end, text }]
native.setTextSelection(id, sub, start, end)
native.registerFont(Buffer.from(fontBytes))
```

All offsets are **UTF-16 code units**, matching JavaScript string slicing. Negative,
fractional, out-of-range and split-surrogate positions throw. IDs are mounted
native host IDs (input refs), not test IDs. Selection direction is represented by
`reversed`; `start <= end` always. A selection read exposes no password text.
Selecting an input does not focus it; call the existing `focusElement` when desired.
Unmounted editors throw rather than silently retaining a detached edit model.
The weak editor registry prunes dead entries on subsequent input renders.

`editInput` synchronously checks `expectedValue` against the current native buffer,
replaces that range, places the caret at the inserted text's end, emits the normal
`onChange`, and creates exactly one native undo step. It preserves earlier undo
history and clears redo. The controlled React `value` must adopt `onChange`; use
the existing native echo handling rather than replacing the whole prop to format
a selection. Explicit edits reject read-only, secure and composing editors.
This is not a rich-document model or a multi-edit transaction group. A real IME
session and application menu integration still need their own verification.

Prose ranges contain the full text of each run, so selected text is
`range.text.slice(range.start, range.end)`. `getSelectedText()` still provides the
joined copy text. `setTextSelection` selects one painted run; for a host `<text>`
it selects the `sub`th descendant run, while code/Markdown use their native run
sub-index. It throws when the run is not painted. Ranges retain their text snapshot
across virtualization; consumers should not treat IDs as persistent document IDs.
Ordinary cached paint now restores text layout, start regions, painted text and
highlight inspection in order. Selection changes use GPUI refresh so cached wash
paint cannot remain stale. Deferred overlay text remains outside this snapshot;
do not wrap selectable overlay content in a cached ancestor.

Register fonts **before first use of their family**: GPUI caches font resolution.
The existing `main.tsx` `Fonts` gate already loads both bundled TTFs before mounting
App, so this native method enables it without an App/TitleBar patch. The optional
`registerBrandFonts(renderer)` helper performs that registration once per renderer.
Invalid font data propagates the native error. Registration is process-local;
it does not install fonts into macOS. The fixture changes from Helvetica to
Cal Sans and asserts different shaped glyph metrics.

`native/capability-check.ts` runs dark and light windows and checks Unicode ranges,
selection direction, native undo and redo, stale-edit rejection, font metrics,
prose range retention through three unrelated frames, changed virtual row text,
and scrolling to a previously unseen cached row. Run it after the existing six
capability scripts. `pnpm exec tsc -p native/tsconfig.json` checks these fixtures
without including the disposable upstream checkout.

## Frame scheduling and subtree scale

The pinned GPUI already implements `Window::request_animation_frame()` through
`on_next_frame`/`schedule_frame`, with `gpui_macos/src/display_link.rs` supplying
CVDisplayLink pacing and idle suspension. Native motion uses this path. The shared
JS loader clock still deliberately samples at 5 Hz and stops while hidden; making
that clock run at display rate would increase work, not fix frame presentation.
No additional timer or GPUI scheduler patch was added. This source inspection is
not a frame-interval or energy measurement.

Faithful subtree scale remains unsupported for the reasons in the native springs
section: quads, paths, masks, glyphs and hitboxes need one coordinated GPUI scene
transform. Translation is not presented as scale.

## Embedded browser host (round 5)

`webview.m` is a small AppKit/WebKit companion library, built with
`bun native/build-webview.ts`. It does not rebuild GPUI or replace its frame loop.
`native/update.sh` builds it too; `scripts/package-app.ts` stages and signs it.
The runtime loads `native/build/kybern-webview.dylib`, or the app Resources copy.

`src/native/webview.ts` owns the trusted wrapper. Each WKWebView uses a fresh
nonpersistent website store and a native generation. A WKURLSchemeHandler serves
only that document's wrapper at `tauri://localhost/embedded/...`; this origin is
already allowed by the daemon's file `frame-ancestors` policy. File and visual
children remain opaque sandboxed iframes; server children use the desktop's
server sandbox. Native navigation action and response policies restrict the
child to its ticket/relay origin and forbid top-level replacement and popups.
No bearer token is sent to a page. Only main-frame wrapper messages enter the
public message bridge; a separate isolated WKContentWorld retains the direct
child's frame for back/forward/reload/stop. Untrusted child script cannot use it.

`src/preview/relay.ts` mirrors the Tauri relay's HTTP request-head rewrite and
raw WebSocket splice. A loopback-only listener checks Host, refuses CONNECT and
absolute targets, and only targets a ticket on the configured daemon. Page
cookies/Authorization pass through; Kybern credentials are never added. The
existing daemon proxy still enforces its credential filtering and destination
checks. Closing a document destroys its relay sockets and revokes its ticket.

`src/preview/Surface.tsx` owns at most two preview documents (the selected thread
and one floating thread). Dock and mini-player publish clipped native geometry;
the WK view never moves between parents or reloads on a slot change. Hidden
docked documents unload after five minutes, with a new ticket on return. Native
window occlusion/minimize notifications pause visual bootstrap loops and suspend
media. Hidden views surrender native focus. Destruction removes both message
handlers, observers, views, media, and the last host's key monitor. Native web
input routes app shortcuts back to the existing JS shortcut handlers.

GPUI popups publish rounded occlusion paths, including a native dim layer for
modal scrims. An expanded visual inherits its popup layer so it appears above
that modal and preserves the same document. The existing composer measurement
observer also masks the native document below the floating composer. Ordinary
layout measurements do not add a polling loop.

Verification scripts: `native/webview-check.ts` exercises native AppKit pointer,
text input, Command-L, blocked external navigation, identity, visibility and
popup masking. `scripts/preview-app-check.ts` uses the scratch daemon for HTML,
localhost root assets, visual expansion, mini-player and device rotation in
light/dark and normal/reduced motion. Both acquire the round-5 UI lock and take
window-only `screencapture` images: GPUI's own screenshot API excludes child
NSViews. See the round-5 preview report for actual results and remaining gaps.

## Event-driven layout (package 2)

```ts
import { onWindowResize, observeElementBounds } from '../native/layout.ts'
const stopSize = onWindowResize(renderer, ({ width, height, scaleFactor, frame }) => {})
const stopBounds = observeElementBounds(renderer, { testId: 'right-dock' }, event => {})
// target also accepts a numeric host ID or a PublicInstance { id }.
// event: { elementId: number | null, rect, clippedRect, frame }
stopBounds() // idempotent, suppresses already queued JS deliveries
```

`LayoutRect` is `{ x, y, width, height }` in logical content-area pixels, including
native translation. Each observer receives its initial value after paint, then
only changed values, at most once per completed observed frame. A zero-size root
canvas defers comparison until ordinary paint, deferred overlays and cached replay
have finished. Callback-triggered updates therefore render in a subsequent frame.
The frame counter counts observed paints, not compositor presentations. There is
no new timer, polling read, cache invalidation or animation-frame request.

`clippedRect` intersects the box with its effective native content mask and viewport;
fully clipped boxes have a null clipped rect. `rect: null` denotes an unpainted
virtual row or removed host. Cache snapshots preserve this clipping information.
Test IDs must initially resolve uniquely. They follow a replacement host; if later
absent or ambiguous, they produce null until unique again. Numeric IDs remain tied
to that host, returning null after unmount. Unsubscribe is safe after window close;
queued JS callbacks check native subscription liveness before invoking app code.
The view drops all subscriptions on close. At most 256 observers may be active.

`layout-hooks.ts` exposes `useNativeWindowSize()` and `useElementBounds(testId)`.
The window hook performs one initial size read and then subscribes. Resize and
scale use the native painted viewport; minimize/occlusion are not synthetic resize
signals. Real cross-display scale changes remain unverified on this single-display
fixture; retain the separate visibility signal for animation suspension.

`native/layout-check.ts` checks dark/light initial values, native zoom resize,
effective clipping (including a changed ancestor clip), unchanged cached replay,
native translation, changed child coordinates, test-ID
replacement, numeric unmount, virtual unpaint, duplicate rejection, rapid/idempotent
unsubscribe and per-frame delivery identity. It also checks spring initial velocity.

## Whole-document syntax and virtual code (package 2)

```tsx
import { createSyntaxDocument, updateSyntaxDocument, releaseSyntaxDocument,
  getSyntaxDocumentText, VirtualCode } from '../native/syntax.tsx'
const doc = await createSyntaxDocument(renderer, { text, language: 'typescript', path })
// { id: string, revision: number, lineCount: number }
const next = await updateSyntaxDocument(renderer, doc.id, {
  expectedRevision: doc.revision, text: editedText,
})
<VirtualCode document={next.id} revision={next.revision}
  startLine={64} endLine={128} showLineNumbers softWrap />
getSyntaxDocumentText(renderer, next) // exact full source for Copy all/export
releaseSyntaxDocument(renderer, next.id)
```

`VirtualCode` validates integer, nonnegative, non-reversed ranges and renders the
native `<code>` document props. `endLine` is exclusive. The native adapter clamps
valid ranges to the document's line count; use the typed wrapper rather than
bypassing its validation with raw host props. Line numbers are absolute.

One immutable native source, line-offset index and whole-document neutral syntax
result serve every visible range. Parsing runs on the napi worker pool, never on
the paint thread. No range starts its own parser. Theme changes recolour the shared
spans without parsing. Mounted ranges hold an Arc lease; unmount releases it.
Updating reserves the next revision immediately: stale expected revisions reject.
A superseded/released/closed parse cannot publish a result. Work that already entered
Syntect finishes in its worker and is discarded; it is not forcibly interrupted.
The previous ready revision remains available during an update. App code should
adopt the returned handle only after its promise resolves.

Limits: 32 registered documents, 8 pending jobs, 2 MiB per source, 16 MiB of current
registered source, and 200,000 highlighted spans per document. Unknown grammars or
a span-limit/parser failure render exact plain source. Queued source copies, an
update's previous ready revision and mounted old leases are additional bounded-by-
caller storage; the 16 MiB limit is not a total-process-memory claim. Close/release
remove registry ownership and reject pending results. The app must still bound
mounted virtual rows and release handles when closing a file or environment.

Selection keys use a document-revision identity plus the absolute logical line,
so adjacent ranges and remounted ranges preserve selection and copy newlines once.
The existing selection API reports that stable document identity in `elementId`
and the absolute line in `sub`; it is not the transient `<code>` host ID. Offsets
within each selected run remain UTF-16. Source indexing is native UTF-8 internally.
Overlapping ranges should not be mounted twice in one document view. Wrapped row
height caching remains the viewport's responsibility; fixed-height Explorer rows
must not opt into wrapping without measuring their real heights.

Checks: `syntax-check.ts` compares PNG bytes to a single full-document render at
every line boundary for TypeScript multiline comments/strings, Python triple
strings, Bash heredocs, embedded HTML and unknown-grammar plain text, in dark/light.
`syntax-lifecycle-check.ts` checks exact cross-range Unicode copy, remount identity,
full-source retrieval, edits before the viewport, stale revisions/results, document
and queue bounds and release. `syntax-large-check.ts` mounts four rows from a
70,003-line, >512 KiB source and checks absolute numbers and bounded painted runs.

## Native spring initial velocity (package 2)

`transition={{ type: 'spring', duration: 0.32, bounce: 0.12,
velocityX: pointerPixelsPerSecondX, velocityY: pointerPixelsPerSecondY }}` adds the
homogeneous damped-spring response for each translation axis. Units are logical
pixels/second, not a normalized velocity, so a flick works even when source and
target are equal. Values must be finite and within ±1,000,000 px/s. Omitted axes
start at rest; this does not infer the velocity of a prior animation. Duration
zero still snaps exactly. Tweens ignore velocity. React motion identity includes
both fields, so a velocity-only change is forwarded. See `src/native/motion.ts`.

Paused-clock dark/light tests verify both axes, direction, same-target motion,
velocity-only retargeting and exact settlement. The standalone Rust spring tests
check the initial derivative, finite output, endpoints and damping behavior.

## Notifications and packaging (package 2)

OS notifications remain **blocked for the unbundled Bun host**. Do not call
`UNUserNotificationCenter.currentNotificationCenter` from that process: on this
macOS build it aborts inside `dispatch_once` with `bundleProxyForCurrentProcess is
nil`; an Objective-C `@catch` does not recover. Bun reports a C++ exception panic.
The deprecated `NSUserNotificationCenter.defaultUserNotificationCenter` returns
nil. The pinned GPUI `zed/crates/gpui_macos/src/system_notifications.rs` independently
guards its notification center with the same missing-bundle-ID check. `native/notification-check.ts` reproduces both in separate child processes,
then shows that the same native executable placed in a disposable `.app` with
`CFBundleIdentifier`, `CFBundleExecutable` and package type `APPL` can create the
modern center. The check cleans up its temporary bundle. **No authorization was
requested and no notification was posted.**

The minimal next step is an actual bundled native host or resident helper `.app`
with a stable bundle ID, a retained `UNUserNotificationCenterDelegate`, and an IPC
bridge carrying notification IDs back to the active environment/thread. The helper
must own status, permission requests, posting, and click delivery across activation
and launch. The probe establishes center creation only, not permission/display/click
behavior. It does not establish that a production signed helper is necessary for
local development; distribution signing belongs to packaging verification.

`src/native/notifications.ts` exposes a truthful unsupported status and explicit
errors for `requestPermission`, `post({id,title,body})` and `onClick`. It never
requests permission or silently substitutes in-app toasts. Keep the existing
agent toast flow until the bundled bridge has been verified. Apple references:
[UNUserNotificationCenter](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter),
[authorization](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:)),
[response delegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:didreceive:withcompletionhandler:)).

Package 2's integration patch and final measurements are in [PACKAGE-2.md](PACKAGE-2.md).

## Package 1 validation and measurements

Full-shell `combined-pointer-check.ts` passes Settings pointer and Space, sidebar
thread selection, titlebar dock toggle, completed dock entrance, Notes addition
and collapse. `settings-check.ts` passes dark and light: switch RPC/event adoption,
numeric clamp/save, every section, search, Escape, shortcut and Back. Neither run
reproduced the old `Window move completed without beginning` warning. That does
not certify a physical AppKit drag: synthetic events do not supply a real NSEvent,
and the OS-authorized physical gesture check remains outstanding. No speculative
drag-hook change was made.

All six existing native checks pass after the final native rebuild; the new
dark/light capability check also passes. Application typecheck, native-fixture
typecheck and `bun test ./src` pass (15 tests, 54 assertions). The build is signed
and load-checked at `native/build/gpuix-native.darwin-arm64.node`.

Apple M1, macOS 27.0, Bun 1.4.0, GPUIX 0.10.0, background windows, 10-second warmup
and 15-second sample per independent launch. CPU is process CPU-time delta,
memory is `footprint` physical footprint, GPU is process Metal accumulated time.
Concurrent workers and occlusion caused substantial run-to-run variation; these
are not exclusive-machine benchmarks, energy or frame-latency measurements.

| Running full-app fixture | CPU | Footprint | GPU / 15 s |
| --- | ---: | ---: | ---: |
| Before 1 | 7.53% | 176 MiB | 75.1 ms |
| Before 2 | 4.67% | 174 MiB | 72.7 ms |
| After 1 | 9.33% | 172 MiB | 75.0 ms |
| After 2 | 6.00% | 179 MiB | 61.5 ms |

The existing deterministic running-thread fixture has one live tool row and two
5 Hz indicators, not sustained token streaming. Mean CPU is +1.57 points, within
the prior report's 3-point noise threshold; mean footprint is +0.5 MiB. This does
not establish a speedup or prove exact equivalence. The fixture mounts App directly
and does not exercise startup font registration; the full-shell Settings checks do.

The isolated `native/list-perf.ts` A/B uses the **same final binary**, 300 virtual
rows and one 10 Hz row loader (plus its outside reference loader), toggling only
the diagnostic inline-row path. This avoids changes in other native capabilities.

| Virtual-list fixture | CPU | Footprint | GPU / 15 s |
| --- | ---: | ---: | ---: |
| Inline 1 | 16.13% | 171 MiB | 102.4 ms |
| Inline 2 | 9.33% | 171 MiB | 71.0 ms |
| Cached 1 | 11.73% | 170 MiB | 91.3 ms |
| Cached 2 | 13.00% | 172 MiB | 92.8 ms |

Mean CPU is 12.73% inline versus 12.37% cached, footprint is 171 MiB for both;
GPU is 86.7 versus 92.1 ms. Variation dominates the small mean differences. The
rendering correctness fix is established; a meaningful CPU saving is not.

Affected issue #108 statuses:

| Line | Status | Evidence / remaining work |
| --- | --- | --- |
| 1.9 | Done | Full-shell dock toggle/entrance passes. |
| 1.10 | Partial | Native drag hook retained; warning not reproduced, physical gesture unverified. |
| 9.8 | Partial | Input selection/atomic undo API available; rich tokens and real IME integration belong to composer. |
| 16.6 | Partial | Selection formatting transactions available; Notes UI must consume them. |
| 22.1, 22.3 | Done | Full Settings dark/light interaction and RPC/event checks pass. |
| 24.15 | Partial | Unicode transaction undo/redo passes; rich editor/IME/menu integration still pending. |
| 25.4 | Done | Shared loader clock preserved; list-row caching now works. |
| 26.6 | Done | Native registration loads both bundled fonts through existing startup gate. |
| 28.11 | Done | Virtual rows, cached updates and newly scrolled rows pass. |

No App.tsx or TitleBar.tsx patch is required. Embedded WKWebView, event-driven
layout and virtual whole-document syntax are proposals only. Native notifications
were not part of the implementation brief handled here and were not added.

Free workspace-volume space was 73 GiB before and 72 GiB after, with other workers
active. The requested pre-existing incremental build (1.9 GiB), upstream checkout
(186 MiB), and reused dependencies (283 MiB) remain for integration. No second
build directory or daemon build was created. Scratch fixtures remove their daemon
data and close their own windows; no task process remained at handoff. Final
screenshots/logs are in `/Users/mymac/projects/ade/previews/gpuix/p1/`; redundant
task screenshots were removed from the native build directory. The installed app,
port 4219 and normal user data were not changed.

## Cached scroll requests and decorated inputs (package 3)

`renderer.scrollToItem(elementId, index, offsetInItem?)` now wakes every cached
ancestor of a pending virtual-list scroll before invalidation. Pending offsets
survive root element construction until cached child views have built; unused
requests are discarded by a deferred callback after the draw. Child-splice
ordering stays unchanged. The regression nests a **48-row** virtual list under
`cache="fill"` and a second cached island: its logical top changes from `[0, …]`
to `[35, …]` and remains there through an unrelated update. The TaskWindow effect's
manual `setRange({start: …, end: …})` pre-mount workaround can be removed; keep its
normal `onVisibleRange` overscan and focused-row mounting. A declaration is in
`src/native/api.ts` (`CachedListCapabilities`).

```ts
import { decoratedInputCapabilities, type InputDecoration } from '../native/api.ts'
const api = decoratedInputCapabilities(renderer)
api.setInputDecorations(inputId, [
  { start: 6, end: 15, id: 'computer', atomic: true,
    style: { color: '#b5d8ff', backgroundColor: '#244263', fontWeight: 600 } },
], 'Hello @Computer') // expectedValue is required: stale effects reject
api.hitTestInputDecoration(inputId, windowX, windowY) // string | null
```

The APIs are native renderer methods; the TS helper checks availability. All
external ranges are ordered UTF-16 character boundaries (surrogate splits reject).
`setInputDecorations(id, decorations, expectedValue)` replaces the entire list,
including clearing with `[]`, without changing text or adding an undo step. It
requires the exact current buffer. Unmounted/secure/composing editors reject.
Read-only inputs can be decorated. Validation is all-or-nothing: nonempty ranges,
at most 4096 spans, unique nonempty IDs when supplied, finite weights 100–900,
valid native colors, `fontStyle: 'normal' | 'italic'`, and nonoverlapping atomic
spans. Ordinary styling spans may overlap; later explicitly specified properties
win. Identical updates do nothing and decoration updates preserve typing's undo
coalescing.

Supported appearance: color, background, font weight/style, and underline.
Backgrounds paint before selection and glyphs using an input-local painter over
GPUI's existing wrapped geometry. `borderRadius` accepts finite nonnegative pixel
values; `backgroundOutsetX` is a finite nonnegative visual-only horizontal outset.
It is capped to half the adjacent undecorated whitespace and the input edges.
Adjacent same-color spans retain separate corners. Wrapped fragments round only
the span's external ends. `paddingX` still accepts only zero; nonzero values throw. This is styled source text, not arbitrary inline React views, replacement
labels, hidden Markdown syntax, a monospace-family override, or layout-padded
chips. Atomic means editing as one unit; it does not make a long token unbreakable
when wrapping. The actual buffer, copy text, accessibility text and IME text remain
identical; no placeholder characters or separate hidden document are introduced.

Caret navigation and mouse placement cannot leave the caret inside an atom.
Movement snaps in the direction of travel; `setInputSelection` snaps an interior
collapsed position to the end and expands partial nonempty selections outward.
Backspace, forward delete, cut, typing over a selection and `editInput` replacement
expand intersected atomic ranges. A native edit shifts untouched spans, discards
spans intersected by the edit, and retains IDs. Insertion at either boundary stays
outside the span. Undo/redo snapshots contain text, selection and decorations, so
deleted atoms return as atoms. External replacement through the `value` prop clears
decorations together with the upstream undo reset; normal `onChange` echoes retain
both. Apps should derive formatting again after ordinary text edits when desired.

IME: explicit decoration/selection/edit APIs reject while a marked range exists;
atomic snapping is bypassed during composition. Initial composition replacement
expands an intersected atom before editing, then the native marked-range pipeline
owns subsequent replacements, selection and commit. Its underline takes priority.
No key interception, text substitution or new composition callback is introduced.
A real input-method candidate/commit/cancel session remains a manual integration
check; automated key tests do not certify OS IME behavior.

`hitTestInputDecoration` takes logical window content coordinates, checks the
editor's content bounds, uses the native nearest-character hit test (including
scroll/wrap geometry), and returns the last matching identified span. Outside the
input or without an identified range it returns null. It is a query; it does not
activate a reference or suppress native caret behavior. A caller must decide which
pointer gesture should open a link.

`DecoratedTextarea` in `src/native/decorated-input.tsx` preserves ordinary textarea
props and refs, subscribes to post-paint bounds for mount/remount readiness, and
applies current decorations after changes and key-up. Stale/composition updates
wait for the next edit/key-up; there is no timer. `input-marks.ts` supplies a known-
reference token adapter and a deliberately limited source-mode Markdown adapter
(single-line backticks, `**bold**`, `*italic*`, simple links, atomic `kybern://task/`
links). It skips code/escaped delimiters; it is not a CommonMark or rich-document
parser. Existing editors remain responsible for their storage/serialization.

`native/decoration-check.ts` runs dark/light and verifies styled runs, the mounted
React adapter, ID hit testing, invalid/stale requests, atomic caret jumps,
deletion, partial transaction replacement, Unicode rebase, native undo/redo and
the nested cached-list regression. Screenshots show the actual background,
weight, italic and underline. `update.sh` runs it with all prior capability checks.
`app-integration-3.patch` is an **unapplied** patch for Composer, Notes, task
descriptions and TaskWindow; see `PACKAGE-3.md` for evidence and limits.


## Rounded input backgrounds (package 4)

See `PACKAGE-4.md` for the exact Tauri style mapping, reproducible lab, performance
samples and unapplied integration patch. `native/rounded-check.ts` verifies actual
pixels in dark/light: radius, adjacent same-color identity, outset clamping at
neighbours/input edges, square continuation ends, selection over a pill and atom
caret movement. `update.sh` includes it. No Zed/shared `TextRun` patch is needed.
The painter does not alter glyph advances, wrapping, selection, hit tests or IME.

```ts
style: { backgroundColor: '#28517c', borderRadius: 5, backgroundOutsetX: 4 }
```

Outset borrows existing whitespace; it does not create padding. Zero is the
integration default. Rounded backgrounds are used only for Notes/task-description
inline code. Tauri composer reference chips and resting task atoms have no fill:
`referenceDecorations` now uses weight 500 and no background; pass `t.accentBlue`.
`noteInputMarkColors(t)` resolves Notes' foreground/transparent mixes (4% light,
5% dark code fill; 60% task text). Native source-mode editors still show Markdown
syntax and cannot reproduce Tauri's icons, replacement labels or per-run font size.


## Markdown style controls (package 5)

`theme.markdown` adds optional table grids, cell padding, quote paint/spacing,
list gutters/markers, heading rhythm, fenced-code wrapping, and mixed-size padded
inline-code boxes. Import `withMarkdownStyle`, `transcriptMarkdownStyle` or
`notesMarkdownStyle` from `src/native/markdown.ts`; the structural helper carries
the new fields through the existing theme prop. Importing the adapter also
augments `GpuixTheme` with the optional field; no npm declarations are replaced.
The native renderer reads them from its normal theme override, with no extra bridge.

```tsx
<markdown source={source} theme={withMarkdownStyle(theme, {
  tableGrid: true, tablePaddingX: 7.2, tablePaddingY: 5.6,
  tableBorder: border, quoteBorder: border, quoteBackground: 'transparent',
  quoteText: muted, quotePaddingLeft: 12.8, quotePaddingY: 0,
  inlineCodePaddingX: 5.6, inlineCodePaddingY: 1.6,
  inlineCodeSizeRatio: 13 / 14, codeWrap: wrap,
})} />
```

Inline radius and fill remain `metrics.mdInlineCodeRadius` and `codeWash`.
`inlineCodePaddingX` reserves real width; it is unrelated to the input decoration
API's zero-only `paddingX`. The mixed-font flow measures source ranges first,
creates GPUI fragments only inside the viewport, and retains original bytes,
links, paragraph-wide search and one selection group. Fragment identities use
source offsets, so reflow retains selection. No synthetic padding characters,
per-frame timer, new parser, highlighting worker or global cache was added.

For mixed-direction paragraphs the renderer deliberately retains its original
whole-paragraph shaping path; padded/smaller code is not yet supported there.
Whitespace-containing code spans use an inline box (wrapping within that box when
wider than the viewport), not WebKit's full inline-fragment line-breaking algorithm.
Neither limitation should be described as full CSS layout parity.

`native/markdown-check.ts` covers dark/light pixels, Unicode selection, paragraph
search, reflow, hard breaks, code wrapping and reaching the end of a large document.
It runs in `native/update.sh`. `native/markdown-webkit.*` render the actual desktop
Markdown component for the same sample. See `PACKAGE-5.md` for the audited CSS
values, images, measurements, remaining differences and unapplied integration.


## Diff style controls (package 6)

`theme.diff`, `desktopDiffTheme`, `NativeDiffHeader`, and `DesktopDiff` match the
desktop plain unified diff while preserving native virtual rows. See
[PACKAGE-6.md](PACKAGE-6.md) for the API, refreshed unapplied integration patch,
dark/light WebKit pairs, bounded-paint checks, performance evidence and limits.


## Package 7: link controls and scene-local backdrops

```tsx
import './native/backdrop.ts' // HostProps augmentation
<anchored deferred backdrop={{blur:16,saturation:1.25,radius:16}}>
  <div style={{backgroundColor:'rgba(30,32,37,.78)'}}>…</div>
</anchored>
<markdown theme={{...theme,markdown:{...theme.markdown,
  link:{color:'#368ded',underline:'hover',weight:500}}}} source={source}/>
```

`theme.markdown.link` has optional `color`, `underline: 'none'|'always'|'hover'`,
and `weight`. Omission preserves native defaults. Both ordinary shaped prose and
mixed inline-code flow retain link byte ranges, selection, and per-link clicks.
Hover uses native mouse events and repaints on range transitions, with no timer.

`backdrop` works on ordinary elements and on the **anchored element itself**.
The latter filters inside the deferred layer and opts out of its otherwise opaque
fallback backing. Putting a filter on a child of an unmodified anchored surface
would sample that opaque backing. `{blur:0}` explicitly makes that backing
transparent without filtering. Use one filter per surface; keep fill/children above
it. `blur` is logical pixels (clamped 0–64), `saturation` is a ratio (0–3, default
1), `radius` clips the filtered corners, and `fadeTop` is the fraction of height
for a linear transparent-to-full filter fade (0–1, used by the live caption).

The macOS Metal backend gets an ordered scene primitive, not an AppKit subview.
It ends the current render pass, samples the already-rendered target into a cropped
horizontal Gaussian pass, then draws the vertical pass with saturation, content-mask
clipping, rounded bounds and inherited opacity before the surface's fill/children.
Scene replay retains the primitive for cached views. A draw-order barrier prevents
primitive batching from moving preceding text after the filter.

Two 49-tap separable passes approximate a Gaussian with a 3-sigma halo. One scratch
texture per renderer grows to the largest visible cropped region and is reused
across filters and frames on the ordered command queue. It is released when the
scene has no filters; compiled pipeline state stays cached for the window's lifetime.
Offscreen, unmounted and zero-opacity regions add no filter primitive. No continuous
repaint or polling is introduced; a changed frame still recomputes its visible
filters even when the change was elsewhere in the window.

This is a **macOS-only** native build extension. It samples GPUI's scene, not other
windows or the wallpaper under NSVisualEffectView. It does not add subtree blur,
scale transforms, arbitrary CSS filter strings or general mask-image support.
The Gaussian/underline rasterization is not pixel-identical to WebKit.

`native/patches/backdrop_gpui.py` reconstructs the GPUI changes from the pinned
submodule HEAD during `update.sh`, alongside the existing GPUIX hooks. No upstream
submodule commit or npm dependency is required. See `PACKAGE-7.md` for results,
`BACKDROP-AUDIT.md` for exact desktop values and exceptions, and the **unapplied**
`app-integration-7.patch` for the app changes. Run `bun native/check-integration-7.ts`
to typecheck that patch without editing app files.


## Round 3: scoped leaf paint

`paint_replay.rs`, `paint_hooks.py`, and `paint_gpui.py` add a conservative
paint-only path to the pinned GPUI fork. `update.sh` reconstructs the GPUI edits
alongside `backdrop_gpui.py`; no upstream submodule commit is needed.

A fixed-size passive leaf with no children, text, event handlers, hover/active
styles, motion, backdrop, border or shadow can update either a div's solid
`backgroundColor` or an SVG's `opacity` without invalidating ancestors. The
renderer tags its original scene primitives with the element ID and inherited
opacity. A style-only batch validates every tag before changing quad fills or
monochrome-sprite tint, then requests presentation without element rendering,
Taffy layout, prepaint, hitbox rebuilding or focus changes. Scene replay keeps
clipping, layer order, atlas tiles, cached ranges and backdrop ordering intact.

Unknown paint, missing/unpainted/clipped tags, geometry changes, custom props,
structural updates and mixed batches use normal invalidation. Other platforms
and the test host keep ordinary revision behavior unless the production host
has enabled scene replay. The scene tags live only as long as the rendered
scene. `KYBERN_SCOPED_PAINT=0` is the full-render A/B reference.

This is **not a dirty-rectangle Metal compositor**: GPUI still submits the whole
scene. It removes ancestor render/layout work for the supported leaves; it does
not promise less GPU time or remove the application's React commits.

`native/paint-check.ts` uses **window-ID OS captures** for live pixel assertions:
GPUIX's automation screenshot method forces a full refresh and would hide stale
cached paint. The check covers repeated fills, SVG opacity, a genuinely changed
parent, movement, hit testing, focus/editing and removal/remount, in dark/light.
The existing native suite covers selection, overlays, scrolling, virtual rows,
layout observers, decorated inputs, native springs, Markdown and syntax.
See `ROUND3.md` for measurement results and the exact remaining work.


## Round 3 resume: ancestor pointers, clipboard, experimental frames

Implicit filled boxes now use an ancestor-preserving hitbox behavior. A painted
child continues to occlude unrelated overlapping controls but no longer makes its
parent lose hover or click routing. Explicit pointer barriers and deferred overlays
remain hard barriers. `pointer-check.ts` exercises dwell-before-click and overlap.

The native renderer additionally exposes `readClipboardImage(): {data: Uint8Array,
mediaType: string, name: string} | null` and `readClipboardPaths(): string[]` through
GPUI's clipboard. They do not change clipboard contents. The automation
`simulateFileDrop` accepts `{x,y,paths}` and dispatches the same native drop events
as the platform to existing `onFileDrop` handlers.

The frame APIs and `paintAnimation` prop are experimental; see `ROUND3.md` before
integrating their app changes. `subscribeAnimationFrames(callback)` returns a token;
the callback receives `(error,{timeMs})`. Acknowledge with
`acknowledgeAnimationFrame(token)` to allow the next delivery; unsubscribe with
`unsubscribeAnimationFrames(token)`. Deliveries are bounded, and consumers must
ignore already-queued stale callbacks after unsubscribe. `src/native/frame.ts`
shares one subscription and handles generations. Hidden-window behavior is a
required regression check, not something inferred from callback counts.

`paintAnimation: {kind:'matrix'|'breathe',cycleMs:number,delayMs?:number}` is allowed
only on passive fixed-geometry div fills or SVG tints. Native paint samples the
same easing without per-frame React updates, while still replaying/submitting the
whole scene. Reduced motion omits the prop. The optional embedded-host wake is
`KYBERN_VSYNC_WAKE=1`; inactive full-rate motion is `KYBERN_FULL_RATE=1`. Neither is
enabled by default. `frame-check.ts` captures actual window pixels plus bounded
submission cadence, callback backpressure, unsubscribe, minimize and unmount.

The experimental frame app and frame-check fixtures are retained on
`gpuix/native` at `f9e5e2a7`, not enabled in the integrated port. The shipped
app still uses its existing loader clock until full-app performance acceptance.
