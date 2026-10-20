# Code-close memory ownership, hands-on round 5

Research source: `/Users/mymac/projects/ade-gpuix-scratch/research/zed`, revision
`56934ec0560bce8929025497411de7f5322fb6ca`. This is a source comparison, not a
Zed benchmark. The GPUIX updater pins its own older GPUI submodule; do not assume
the research checkout and shipped GPUI have identical implementations.

## Zed ownership

- `crates/project/src/buffer_store.rs:86–88,1020–1043`: completed open-buffer
  entries hold `WeakEntity<Buffer>`, and release emits `BufferDropped`. Closing
  an editor can release the buffer when no other editor, snapshot or operation
  owns it; the project index itself does not unconditionally pin every buffer.
- `crates/language/src/buffer.rs:125,1332–1334`: a buffer owns its `SyntaxMap`;
  a buffer snapshot clones the syntax snapshot. Other snapshots can therefore
  legitimately outlive an editor tab.
- `crates/language/src/syntax_map.rs:32–72`: `SyntaxSnapshot` owns the layer
  SumTree. Its destructor moves the tree onto a background drop channel because
  dropping deep Tree-sitter trees can block the UI. This changes where release
  happens, not whether other live snapshots retain shared tree nodes.
- `crates/gpui/src/text_system/line_layout.rs:458–485,586–601`: `LineLayoutCache`
  has current/previous frame maps and used-key vectors. `finish_frame` swaps
  them and clears the older frame. Unused shaped text is released at frame
  completion; allocation capacity can remain. Cached-view replay moves only
  referenced layout ranges (`:521–568`), and lookups move a prior layout into
  the current frame (`:628–640,694–704`). This is a frame cache, not a file cache.
- `crates/gpui/src/text_system.rs:878–879` forwards frame completion. GPUIX's
  pinned `Window::draw` also calls this before swapping/clearing its frame.
- `crates/gpui/src/platform.rs:1703–1718,1803–1830`: atlas keys identify a glyph,
  SVG or image rather than an editor buffer. Atlas removal deletes the key and
  passes its tile to the backend. Do not infer that buffer-close evicts shared
  font glyphs.
- `crates/gpui_apple/src/metal_atlas.rs:24–30,49–51,69–97`: removing a tile
  deallocates its atlas region; a texture is returned to the free list when its
  reference count reaches zero. A shared glyph texture need not disappear when
  one document closes.

## Reproduced owners

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/handson-r5/memory/`.

The original addon reproduces the 12,000-line high water in the existing
`lab-run.ts`: 143 → 408 → 269 → 327 → 225 MiB across initial Home, first open,
first close, reopen and second close. These are unprofiled, separately gated
10-second warmup / 15-second samples on the hidden 2× display. The first close
retains +126 MiB and the second +82 MiB; historical +145 MiB is not a fixed
constant. No idle frames or GPU work occur in the settled lab samples.

`owner-unprofiled/` separates live storage from allocator accounting:

| Stage | Physical footprint | Default malloc live bytes | Dirty bytes | Fragmentation |
| --- | ---: | ---: | ---: | ---: |
| Home | 142.6 MiB | 15.4 MiB | 18.0 MiB | 2.6 MiB |
| Code open | 407.9 MiB | 198.2 MiB | 230.6 MiB | 32.4 MiB |
| Code closed | 268.6 MiB | 21.5 MiB | 124.5 MiB | 103.0 MiB |

The baseline close has 75.8 MiB of dirty **Malloc Small (empty)** regions.
A separate untimed public `malloc_zone_pressure_relief` probe returns zero for
both all zones and the default zone; footprint stays 268.3 MiB. Merely requesting
pressure relief does not solve this workload. It is not shipped.

`owner-stacks/open-heap.txt` versus `closed-heap.txt` proves the native layouts
release: `LineLayoutCache::layout_wrapped_line` allocations fall from 24,003 to 2;
`layout_line` allocations from 12,002 to 1. The source-size limit declines
highlighting for this 889,779-byte raw `<code>` source, so this case has no large
cached Syntect result. Separate whole-document virtual-code checks exercise
actual syntax leases and their release.

`owner-stacks/closed-history-1.txt` allocates a 1 MiB GPUI arena chunk while
building `CodeElement` / selectable text. `closed-owners-1.txt` traces it through
the arena chunk vector into `AppCell`. Most chunks have already been freed;
the live small Home arena is intentional. The open heap has dozens of arena
chunks plus temporary table growth below the original 4 MiB mapping boundary.
Malloc stack logging rounds 1 MiB allocations to 1,040 KiB, so literal-size
filters must account for profiler overhead. Traces are diagnostic only; their
higher footprints are excluded from unprofiled comparisons.

`owner-js/*.heapsnapshot` are Bun V8-format heap graphs. `summary.json` records
node counts/self sizes; `source-owner-path.json` records a root-to-source path.
Total node self sizes are 28.51 → 29.62 → 29.31 → 29.03 MB (initial/open/closed/
explicit GC). The one 889,795-byte source string remains through React's retained
fiber props reachable from the fixture's state dispatcher. That is less than
1 MiB, not the 100+ MiB native remainder. No JS syntax-token array is created by
the native syntax path. `heapStats` and snapshot self sizes measure different
engine accounting categories and must not be substituted for physical footprint.

Metal gauges are unchanged in the raw-code round trip: roughly 45 MB device
allocated size and a 1 MiB atlas. Images have zero entries. Mapped native live
bytes fall from 94.2 MB to 16.8 MB after close. Neither a growing glyph atlas nor
an unreleased 12,000-line native layout explains the 103 MiB malloc-fragment
charge. Shared warm frame/table capacity still exists and is reported separately.

## Fix under test

`code_alloc.rs` extends the existing anonymous-mapping allocator to Rust buffers
of at least 64 KiB. This covers 1 MiB frame-arena chunks and temporary layout
hash/vector tables that formerly used Darwin's small/large region caches.
Dropping them now unmaps their pages. Over-aligned allocations use the selected
small allocator; other platforms and mapping failure behavior remain unchanged.
`KYBERN_CODE_MEMORY=0` restores the 4 MiB image-only boundary in the same addon;
`KYBERN_LARGE_ALLOCATIONS_VM=0` retains the original System control.

No glyph eviction, syntax colour, frame scheduling, document cancellation,
selection, scrollbar, theme or content-retention policy changes. Added diagnostic
counters report current/previous shaped-layout counts, syntax-cache size and the
actual per-App arena. The older `elementArenaBytes` counter reads the fallback
thread-local arena and can underreport a real App's arena; it remains present
for compatibility, with `appElementArenaBytes` supplying the correct owner.

The second retained owner is spare capacity in the two `DispatchTree.nodes`
vectors (`crates/gpui/src/key_dispatch.rs`). `Frame::clear` drops their live nodes
but Vec capacity survives. `code_frame.rs` / `code_frame_gpui.py` now trim both
frames only after a large collapse: over 4,096 allocated slots, with current
workload below one eighth of capacity. They retain twice the current workload
and at least 256 slots. A cleared backup frame uses the live frame's workload
as its hint, so a large open document keeps its warm double buffer. Every
DispatchNodeId is a frame-local index; shrinking preserves live indices and
contents. `dispatchFrames` reports current live count and both allocated buffer
byte counts. `KYBERN_CODE_FRAME_MEMORY=0` isolates the allocator-only change
inside the same final addon. The final measurements must distinguish this
capacity owner from freed malloc-region retention.

Current public GPUI documentation was fetched through Context7
(`/websites/rs_gpui_gpui`, resolve and docs output in the evidence root). It
confirms [cached views](https://docs.rs/gpui/latest/gpui/struct.AnyView.html)
reuse previous layout/paint, and distinguishes
[entity-release observers and asset removal](https://docs.rs/gpui/latest/gpui/struct.Context.html).
The private frame-cache, buffer and atlas implementations above are established
by the pinned source files, not inferred from those public API descriptions.

The first same-addon prototype is preserved under `prototype/`: 4 MiB control
149→413→274→332→231 MiB; 256 KiB allocator only 150→405→211→428→186;
256 KiB plus dispatch trimming 149→405→196→325→164. This isolates the exact
16 MiB dispatch buffers: `dispatchFrames` is `[19,8388608,8388608]` after close
without trimming and `[19,32768,32768]` with it. Mapped live bytes fall by the
same 16,777,216 bytes. The valid first-close result remains +47 MiB, so that
prototype is insufficient for the ≤40 MiB goal; the second close's +15 MiB is
not substituted for the first.

The final candidate also returns the unused hash-table and used-key Vec
capacity in both `LineLayoutCache` frame caches. It preserves live Arc values,
key ordering and cached-view layout indices, and uses the active frame's counts
for the cleared backup frame. `textLayoutCapacities` distinguishes this spare
storage from the already-released shaped-layout values. The mapping boundary
is 64 KiB, keeping medium growth buffers out of Darwin's retained size classes;
ordinary small layout allocations use the private allocator described below. The prototype and
final binary identities must not be mixed when reporting paired results.


## Small-region allocator owner

The 64 KiB / frame-capacity prototype is preserved under `prototype64/`, SHA
`712ada1ebd402c5a6db41e4984879d35a0af3f15a00c3f163c631bd08761741d`.
It returns the first raw close to 196 MiB from 150 MiB (+46), and the second
close to 164 MiB (+14). The product heavy-session Home remains 263 MiB from
214 MiB (+49). Those are **insufficient first-close/Home results**, not passes.
Its first raw close still has 55 MiB of dirty default-malloc storage against
about 8 MiB of live blocks: 47.2 MiB fragmentation, including 28 MiB of empty
Small regions. The second close's dirty storage is 22.9 MiB with 15.1 MiB
fragmentation. This is freed small-region retention remaining below the new
mapping boundary, independently of the already-trimmed dispatch buffers.

`code_small.rs` / `code_small_hooks.py` add exact macOS Rust dependencies
`mimalloc = 0.1.52`, `libmimalloc-sys = 0.1.49`. Rust allocations below the mmap
boundary, and over-aligned allocations, use its aligned `GlobalAlloc` methods.
The process launch flags determine one immutable allocation/reallocation/free
route; legacy `CODE_MEMORY=0`, `CODE_SMALL_MEMORY=0`, and `LARGE_ALLOCATIONS_VM=0`
controls retain System's small route. There is no libc override or interpose
feature. `mimalloc-features.txt` records the actual Cargo feature graph;
`mimalloc-symbols.txt` shows the linked `mi_*` entry points are non-external,
private symbols in this addon, separate from Bun's own allocator.

After at least 8 MiB of mapped buffers are freed, the existing AppKit pump
coalesces one `mi_collect(true)` after returning from frame/arena destruction.
It never collects inside the global allocator, adds no timer or frame request,
and records collection counts in `smallAllocator`. The
[documented collection API](https://microsoft.github.io/mimalloc/group__extended.html)
can return unused pages aggressively; the
[Rust aligned allocator implementation](https://docs.rs/mimalloc/0.1.52/src/mimalloc/lib.rs.html)
preserves the requested allocation/reallocation alignment. API documentation
was fetched through Context7 and checked against the exact downloaded crate
source. Standalone tests cover threshold crossings, zeroed/aligned buffers,
small aligned realloc, cross-thread release, and coalesced collection in the
new, medium-only, legacy and System controls.

The research Zed checkout also contains an **optional** mimalloc global
allocator (`crates/zed/src/main.rs:83–85`, `crates/zed/Cargo.toml:167`). Its feature
is not enabled by that manifest's default feature list; this source observation
is not evidence that the installed macOS release uses it. The Zed comparison
above remains about ownership and release, not an allocator benchmark.

## Post-frame release boundary

The pump-only private-allocator prototype (`small8-prototype/`, SHA
`0a2cbfe703dbdedb612ceca6a0daf708527c45c878f94374046ca626190c3565`)
returns the raw-code first/second/third closes to +8/+8/+9 MiB. It does not
solve the product workload: heavy-session Home is 272 MiB from 203 (+69),
versus the same addon's legacy 262 from 216 (+46). After the final release,
3,302,400 mapped bytes are pending below the collection threshold. Those
measurements are a failed intermediate policy, preserved rather than omitted.

The final policy requests collection on large reconciler destruction batches
and syntax/Markdown document release, then coalesces at the drawn App's arena
clear. A request remains armed through an earlier pump so that destructor
order cannot lose it. `ArenaClearNeeded::clear` checks that no nested arena
scope deferred the clear, releases the arena borrow, and invokes a safe
`OnceLock<fn(bool)>` callback. Event arenas do not invoke it. Large arena
contraction keeps the chunks actually used instead of twice that amount.
`CODE_POST_FRAME_MEMORY=0` restores the pump-only policy and original slack
in the same addon. No collection occurs on ordinary idle frames without a
request, contraction or 8 MiB of released mappings.

## Final same-addon resource observations

Validated addon SHA-256:
`705475ccb3b7c0d07fc3821f631d3d051953ea1856be03ecf14602fb6305f400`.
The full updater and allocator controls passed. The final quiet windows use the
hidden display as the only display, CG `(0,0,1440,900)` at 2×; earlier
prototypes used CG `(-1440,900,1440,900)`. Do not mix their active GPU timings.
The guard now reads current display bounds on every check.

| Final workload | Legacy Home/open/close/reopen/close MiB | Candidate MiB | Status |
| --- | --- | --- | --- |
| Raw 12,000-line code | 150/415/276/333/233 | 163/414/170/421/176; third open422/close177 | ≤40 MiB close target met (+7/+13/+14) |
| Real FileCode + 25s native wheel per round | 150/179/197/202/203 | 155/196/191/205/197 | +36/+42; second close misses target by2 |
| Real FileCode, no scrolling | — | 151/188/179/192/183 | +28/+32, target met |
| Product thread/code/24-image note/Home | 224→304 Home | 222→271 Home | improved +80→+49, residual remains |

The scrolled FileCode rows omit the active-scroll intermediate footprints:
legacy204/209 and candidate201/214 MiB. Raw candidate mapped bytes after every
close are exactly12,145,432, App arena1MiB, atlas1MiB, with no map/unmap failures.
The native owners no longer track the12,000-line document high water. JS
uncollected fixture strings and HTTP input buffers are measured separately;
normal resource rows never force collection. Repetition diagnostics establish
the later bound rather than assuming three rounds prove an indefinite bound.

The product comparison is a partial improvement, not a ≤40 MiB Home pass.
The final Home has zero syntax-document leases, zero image entries, a73,536-byte
neutral syntax cache,4MiB App arena and23,488,557 mapped native bytes versus
13,447,384 initially. Its live IOSurface total stays48MiB in both stages.
Default-malloc dirty storage rises12.5→18.9MiB (live6.7→11.6MiB), rather than
reproducing the original103MiB freed-region fragmentation. GPU-driver and
App-Specific Tag1 dirty categories also warm; those broad VM categories do not
identify individual Rust or JSC owners, so the remaining49MiB is not fully
attributed to a single cache. The pump-only control ends268 from203 (+65);
initial GPU backing differs, so271 versus268 is not proof of an absolute
post-frame improvement.

Reopen readiness is a fixture-control/bounds proxy, not physical presentation.
Raw legacy reopen232ms versus candidate308/243ms; real FileCode legacy1822ms
versus candidate1706ms. Reopened raw footprint is higher (421 versus333MiB),
although both first opens are414–415MiB. Returning pages has a warm-allocation
tradeoff; this work does not claim universally lower open footprint or latency.

`visual/diff.json` contains12 exact content-canvas pairs across both themes:
large code, syntax, real pointer selection, native scrolling, Home and reopen.
All differ by zero pixels. `visual/syntax-colours.json` independently requires
red/blue syntax ink. AppKit chrome and12pt compositor edges are excluded.
`desktop-reference/` contains actual desktop headless WebKit code/syntax/scroll
images and geometry in both themes. Desktop kit.css:1282–1334 uses13px/21.45px,
while existing GPUIX FileCode uses12px/20px; that pre-existing cross-app geometry
difference is preserved, not represented as pixel parity. No product styles,
font sizes, colours or selection behavior were changed.

## Repeat and JavaScript transport proof

`repeated-owner/cycles.json` adds ten unprofiled raw-code open/close cycles,
without manual GC or pressure relief until all observations finish. Closed
footprints are160/161/162/162/162/162/162/162/162/162MiB; mapped native bytes
are12,145,432 throughout. Initial footprint151.7MiB, first close157.3MiB.
Default-malloc dirty13.0→13.2MiB, with empty Small dirty800KiB unchanged.
This is a measured plateau over eleven closes, not an indefinite guarantee.

`virtual-owner-js/` exercises actual FileCode plus25s native wheel, native
syntax-document creation and close. Registry ownership is one889,779-byte
document while open and zero documents/source/pending after close. V8 graph
self sizes are30.71→33.84→33.02→32.80MB (initial/open/closed/explicit GC).
One889,795-byte source remains through the fixture HTTP callback→module state
dispatcher→React alternate Fiber→previous props.content; the exact path is in
`source-owner-path.json`. Buffer graph counts/self sizes stay stable.

Before the open snapshot, process.memoryUsage reports658,459 ArrayBuffer bytes
from the wheel-driven workload; immediately after snapshot it reports zero.
The snapshot operation changes engine retention/collection, so later profiled
footprints are excluded from resource comparisons. It demonstrates temporary
test-transport garbage, not a growing retained document or syntax-token cache.
The second normal scrolled close still honestly misses40MiB by2; no bytes are
subtracted from accepted observations and no production forced-JS-GC was added.

## Active performance and limits

`scroll-performance-summary.json` records four15s samples per flag: two rounds
in the long resource run plus two fresh runs in candidate/control/control/
candidate order. Medians (legacy→candidate):

| Metric | Legacy | Candidate |
| --- | ---: | ---: |
| CPU, one core equivalent | 26.03% | 26.73% |
| Frame-interval p95 | 18.736ms | 18.706ms |
| CPU render p95 | 4.650ms | 4.674ms |
| CPU layout p95 | 0.983ms | 1.008ms |
| Driver GPU accumulated time /15s | 175.8ms | 335.5ms |

GPU readings vary widely (legacy12.2–343.5ms; candidate272.5–507.1ms). The
median is higher for the candidate and is an unresolved resource-validation
risk; these results do not establish equal GPU cost or improved energy use.
No hardware GPU timing or energy trace was captured. The fresh paired run
first gives343.5→311.4ms, whereas the other gives12.2→359.5ms; the difference
cannot be assigned to allocator code from this driver counter alone.
Frame pacing and CPU have no large measured regression in this workload, but
this is not a universal performance claim. Settled raw-code/Home samples have
zero submitted frames and zero driver GPU time. The collector adds no timer.
