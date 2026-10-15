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

The open-thread case gains little because its loaders sit inside two virtual
lists (sidebar row, transcript "Working" row), and islands inside list rows
render inline (below), so each tick still rebuilds both regions.

## Island rules

- **Definite size:** `width` and `height` in pixels or percent. Without both the
  element renders inline (no caching, no error). `cache="fill"` (`FILL_ISLAND`)
  is for a box its parent sizes (flex-grow, stretch).
- **Not inside `<virtual-list>` rows.** GPUI's `list` lays out rows in ways a
  cached view does not survive (rows paint blank), so islands there render
  inline automatically. Put the island around the list instead.
- **No margins or position insets on the island itself;** put them on a parent.
  The island keeps its declared size (it does not flex-shrink).
- **Unchanged islands replay.** Any change inside (props, text, children, style,
  a running `motion.div`) re-renders that island only, in the same frame.
- **Text selection** inside an island is lost on frames it is replayed; do not
  make selectable text (transcript prose) an island.
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

`cache_island.rs` → `IslandView::render`, no new upstream hook.
`island-overlay-check.ts` first reproduced the missing bounds, then passed
three outside updates/cached replays and overlay clicks. The normal five
island checks still pass. Their animation fixture uses a controlled clock so
another window covering the lab does not suppress the test animation. Overlays need not move to the app root solely to
avoid this failure. Selection-in-replayed-island limitations remain.

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

## Virtual-list islands investigation

Removing the `in_virtual_row` fallback still produces blank rows, even with
the deferred-overlay fix. The list measures elements via `layout_as_root` with
available-item space; `ViewElement::cached` requires a definite box and caches
its own layout/prepaint ranges. The existing nested wrapper does not survive
that measurement/repaint lifecycle. A correct solution needs row-level cache
ownership coordinated with list measurement and invalidation in the Zed fork.
The inline fallback is retained; no list-row CPU improvement is claimed.

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
