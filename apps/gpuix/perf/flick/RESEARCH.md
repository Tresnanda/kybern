# Fast-fling source research

Read-only clones under `/Users/mymac/projects/ade-gpuix-scratch/research`.
Zed revision `56934ec0560bce8929025497411de7f5322fb6ca`; Zeron revision
`c526d6f7cfc7a53e5588e3e6c5df7484a14d649f`. Line references below refer to these
clones, not the older revisions linked by earlier lane reports.

## Variable-height List

Zed `crates/gpui/src/elements/list.rs:63–71` stores `SumTree<ListItem>`, logical
scroll top and pixel overdraw. The summary has counts and measured/hinted height
(`:290–305`, `:1638–1685`); unknown new rows contribute zero, **not a universal
average-height estimate**. Invalidated rows retain their prior size hint
(`:458–470`). `ListOffset` is an item index plus pixels within it (`:1433–1440`).
Splicing before the anchor adjusts its index by the count delta; replacing the
anchor moves it to the splice start (`:511–550`). Remeasuring changed content
preserves absolute pixels within the anchor; whole-list resize preserves its
fraction (`:401–457`, `:1080–1102`). This avoids treating changing estimated
height above the viewport as a new absolute document scroll position.

Overdraw measures ahead and behind the viewport (`:310–314`). Layout renders
visible items, reuses known heights for offscreen overdraw, measures unmeasured
items lazily, and replaces the measured SumTree slice (`:1062–1125`,
`:1178–1208`). This bounds construction to local content but **does not impose a
per-frame CPU budget**. A single expensive row or a large overdraw of cheap,
short rows can still burst. `measure_all` is explicitly opt-in (`:333–339`).
Scrollbar dragging freezes its reported height while measurements correct
(`:740–790`). GPUIX already adds semantic-key height retention and hinted
splices in `native/patches/sparse_list.rs`; throwing that away for a new list
would lose an existing guarantee.

`uniform_list` measures a representative item, calculates total height by
multiplication, and converts pixel offsets directly to a visible index range:
`crates/gpui/src/elements/uniform_list.rs:371–397,474–509`. It is appropriate
for fixed-height source/tree rows, not variable-height transcript bubbles.

## Scroll and momentum

Zed editor `crates/editor/src/element/mouse.rs:483–590` captures a frame's scroll
snapshot and coalesces deltas with `ScrollDelta::coalesce`; precise pixel input
passes through the scroll manager filter, line deltas use glyph/line metrics,
and clamped unchanged positions do not notify. `List` similarly captures the
painted `ListOffset`, accumulates input and scrolls from that base:
`crates/gpui/src/elements/list.rs:1590–1627`. This is frame-relative accumulation,
not a queue that rebuilds a document for every wheel packet.

macOS `crates/gpui_macos/src/events.rs:258–292` preserves precise fractional
pixel deltas and maps contact phase. That event translation **does not carry
NSEvent's independent momentumPhase**. Do not claim it does. AppKit provides the
momentum events/deltas; Zed's native touch-gesture momentum path in
`crates/gpui/src/window.rs:5884–5886,5959–5967` is distinct. The display link's
main-queue source coalesces vsync notifications (`gpui_macos/src/display_link.rs:297`),
not arbitrary wheel packets. GPUIX's own `scroll_input.rs` adds a bounded pending
batch for painted `cacheLayout` targets (`native/patches/scroll_hooks.py:23–33`),
which now include transcript and sidebar as well as PR lists. Its default mode
is still named `pr`; that name does not limit the current renderer's target
discovery to PRs. Global `all` mode remains a separate experiment.

Zed `crates/gpui/src/app.rs:2104–2134` limits the eager test draw loop to
`GpuiMode::Test`, then schedules ordinary frames for dirty windows, pending
presentation or next-frame callbacks. Selecting that ordinary scheduler is the
relevant transfer when a release embedding accidentally pays test draw work
between display callbacks. The pinned GPUIX fork already has a diagnostic switch
for that loop; this lane measures it before changing its default.

The historical `perf/scroll-round8-2026-10-17.md` app-wide experiment also records
a missing-painted-bounds failure. `getAutomationTree` requests invalidation and
then reads a snapshot; under deferred drawing that snapshot can precede its
requested paint. A narrowly scoped explicit snapshot barrier is needed before
promoting the frame scheduler. Ordinary painted-bounds reads should remain
reads. The updater also caught an immediate-hover screenshot of the prior
scene; explicit image capture needs
the same barrier before rasterization. The deterministic spring verifier also
requires eager painting while its automation clock is paused/set/advanced.
That exception is scoped to the controlled window and is removed on resume;
normal runtime input remains on the platform scheduler.

## Zeron conversation work

Zeron `crates/ui/src/transcript.rs:1–25` describes stable semantic block rows,
per-entry content fingerprints and minimal row splices. The implementation holds
one Transcript entity, ListState, rows and fingerprinted CachedRows
(`:3158–3163,3201–3203`, `:2654–2657`), rather than one cached entity for every
message. It uses 320 px overdraw (`:68–69`, `:3563`) and renders through List's
on-demand row processor (`:7269–7310`, `:10325`). Visible row callbacks still
clone the row, resolve theme/workspace and construct elements each frame.
These are cached row **models**, not a prebuilt permanent element tree.

Markdown `RenderCache` retains flattened strings, runs, code lines and laid-out
formulas, keyed by stable row/block and style generation:
`crates/ui/src/markdown/render.rs:430–503`. `retain_rows` keeps the prior
viewport/overdraw only (`:461–469`); Transcript calls it and clears the visited
set on render (`transcript.rs:10136–10139`). Re-entry can rebuild derived text.
It therefore does not establish that every offscreen message remains shaped
forever. Stable data identity and bounded caches are the transferable technique.

## Text layout cache limits

Zed `crates/gpui/src/text_system/line_layout.rs:458–494` has current/previous
frame maps of Arc line and wrapped-line layouts plus used-key ranges. Keys
include text, font size/runs and wrap width (`:615–626`, `:651–660`). Wrapped
layout hits reuse the shaped line and wrap boundaries (`:629–649`); normal line
misses call the platform shaper (`:690–717`). `reuse_layouts` moves prior used
ranges into the current frame (`:523–566`), and `finish_frame` swaps and clears
the obsolete generation (`:584–603`). Font database generations invalidate the
cache. Caller-provided hashed keys allow allocation-free probes (`:471–486,722+`).

This is cross-frame reuse for retained/visible work, **not an unlimited history
cache**. A row gone for multiple frames can need shaping again unless its owner
retains an Arc layout separately. GPUIX's rollback/draw-generation guard must
remain around paint reuse; prior scroll2 evidence reproduced a crash when ranges
were replayed against the wrong frame. Cache lifetime, invalidation and memory
must be measured together before adding a history cache.

## Documentation cross-check

Context7 resolve + docs were run on October 19 for GPUI (`/websites/rs_gpui`),
following the checkout's documentation rule. The generated [ListState docs](https://docs.rs/gpui/latest/gpui/struct.ListState.html)
and [List source docs](https://docs.rs/gpui/latest/src/gpui/elements/list.rs.html)
confirm local lazy measurement and pixel overdraw. The exact implementation
claims above use the revisioned read-only clones; current published docs are
not substituted for the pinned native fork.
