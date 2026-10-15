# Patched GPUIX native module

The client runs on our own build of `@gpuix/native`: the upstream release in
`VERSION` plus the capabilities below. The upstream checkout is disposable; all
changes are reconstructed by the checked-in patches and anchored hooks.

## Why

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
- **Unchanged islands replay.** Any change inside (props, text, children, style,
  a running `motion.div`) re-renders that island only, in the same frame.
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

`update.sh` runs typecheck and all six background-window capability scripts serially.
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

## Proposed embedded browser host contract (not implemented)

`src/native/webview-contract.ts` is the concrete TypeScript proposal for package 5.
It does **not** enable browser UI or claim that WKWebView is available. A native
implementation must attach one WKWebView per document to the GPUI content view,
keep its identity while moving between dock and mini-player, and cap live hosts
at two. `place` uses logical top-left coordinates and a clipping rectangle; the
native side converts to AppKit coordinates and applies coalesced frame/visibility
updates. Native browser views must not cover GPUI menus or dialogs; the integration
needs an explicit overlay/occlusion policy before it can ship.

URLs come from the existing authorized preview ticket/loopback relay flow. A
WKNavigationDelegate checks initial navigation, redirects, popups and downloads
against the allowed origins; external navigation is an event for app policy.
Never inject daemon bearer credentials into page JavaScript. The contract has no
arbitrary JS evaluation bridge. Per-environment nonpersistent website data stores
prevent session/cookie crossover; file pages still rely on the daemon's sandbox
CSP and canonical-root checks. A stale generation may not update new navigation.

Hidden hosts must lose keyboard focus, stop loading and cease presentation work;
the implementation must separately verify media/timer suspension, since hiding an
NSView alone is insufficient. Destruction removes navigation/message delegates,
event observers and views, cancels pending work, and is idempotent. A process-crash
event leaves retry UI to the app. Verification must include WebKit subprocess
footprint/CPU, repeated dock/mini-player transitions, environment switches, blocked
external navigation, clipping/hit testing, native keyboard editing and eventual
process cleanup. No WKWebView prototype was added in this package.

## Proposed event-driven layout API (not implemented)

```ts
type LayoutRect = { x: number; y: number; width: number; height: number }
type ElementBoundsEvent = {
  elementId: number
  rect: LayoutRect | null
  clippedRect: LayoutRect | null
  frame: number
}
onWindowResize(renderer, callback: (size: {
  width: number; height: number; scaleFactor: number; frame: number
}) => void): () => void
observeElementBounds(renderer, target: number | { testId: string },
  callback: (event: ElementBoundsEvent) => void): () => void
```

The helper returns an idempotent unsubscribe function. It subscribes to native
window bounds/scale-factor changes, not a JS timer. Dimensions are logical pixels;
element rectangles use the content area's top-left origin and include native
translation. Each subscription receives its current value after the next completed
paint, then only changed values. Changes coalesce by subscription to one delivery
per completed frame; callbacks run after paint through the existing event bridge,
never reentrantly during layout. A callback-triggered React update belongs to the
next frame, preventing recursive measurement loops.

`rect: null` marks unmount or an unpainted virtual row and is emitted once per
transition. Cached replay must restore observed bounds just as it does automation
bounds; observing an unchanged island must neither invalidate it nor force layout.
`clippedRect` is the intersection of the painted box with its effective clip and
window viewport. Minimize/occlusion produces no synthetic resize; use the existing
visibility signal. A test ID must resolve uniquely, otherwise subscription fails;
if its node is replaced, the subscription follows the new ID. Numeric IDs stop at
unmount and do not attach to another node. Close/unsubscribe discards queued events.

Implementation seam: the native bounds tracker records dirty observed IDs during
paint; a post-frame queue compares the final boxes, including island replay and
deferred overlays, and sends one batch. Register/unregister observer tokens on the
renderer; keep callback maps in JS, with a bounded native subscription count. This
API would let shell/window and dock rect tracking replace polling. Required checks:
resize, scale change, sidebar/dock motion, cached replay, clipped/virtual unmount,
same-test-ID replacement, rapid subscribe/unsubscribe, and no idle wakeups after
all observers detach. Current polling is unchanged in this package.

## Proposed whole-document syntax / virtual code API (not implemented)

```ts
type SyntaxDocument = { id: string; revision: number; lineCount: number }
createSyntaxDocument(renderer, { text, language, path? }): Promise<SyntaxDocument>
updateSyntaxDocument(renderer, id, {
  expectedRevision: number, text: string
}): Promise<SyntaxDocument>
releaseSyntaxDocument(renderer, id): void
// Native JSX; endLine is exclusive, offsets and line numbers are zero-based.
// <code document={doc.id} revision={doc.revision}
//       startLine={start} endLine={end} showLineNumbers softWrap />
```

The native document owns the full source, line index and whole-document parser /
highlight state. Visible `<code>` ranges share it; a range must never start a fresh
parser at `startLine`. Open strings, multiline comments, heredocs and embedded
languages therefore retain preceding lexical context. Document creation/update is
asynchronous and revisioned. Stale work is cancelled or discarded; a view requesting
a newer revision may retain readable old paint until the new one is ready but may
not label old highlighted text as the new source. An unsupported grammar falls
back to exact plain text. Use a bounded worker queue and document cache; explicit
release cancels pending work, and mounted views retain a lease until unmount.

Ranges clamp to `[0, lineCount]`; invalid reversed/noninteger ranges reject. Displayed
line numbers remain absolute. The shared model provides stable selection keys and
document offsets, so selecting/copying across adjacent virtual ranges neither loses
nor duplicates newlines. Wrapped row heights belong to the viewport measurement
cache keyed by document revision, width and typography; source remains immutable
within a revision. Copy-all/export uses full document source rather than joined
visible chunks. A document handle is renderer/environment scoped and may not be
reused after release or environment teardown.

Implementation seam: extract the existing code highlighter's parsed source and
TextRuns into a renderer-owned document registry, expose only line slices to the
code element, and keep virtual rows responsible for viewport mounting. Tests must
split multiline comments/strings and Unicode at every range boundary and compare
the final coloured runs with a single full-document render; also test edits before
the viewport, cancelled parse results, selection/copy across remounts, wrapping,
memory release and bounded work for large files. Current chunk rendering is
unchanged; this contract does not claim cross-chunk syntax parity.

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
