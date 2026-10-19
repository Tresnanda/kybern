# Decoded image ownership in Zed and zeron

Research clones under `/Users/mymac/projects/ade-gpuix-scratch/research/` are read-only. Line references below name those clones, not the GPUIX generated build tree. Zed revision: `56934ec0560bce8929025497411de7f5322fb6ca`; zeron revision: `c526d6f7cfc7a53e5588e3e6c5df7484a14d649f`.

## Zed GPUI

- `zed/crates/gpui/src/assets.rs:43–69`: `RenderImage` owns `SmallVec<[image::Frame; 1]>`, **not Arc buffers per frame**. `RenderImage` itself is shared through `Arc<RenderImage>`. Its constructor moves the frames. `as_bytes` borrows frame storage (`:72–76`); drawing an Arc does not clone pixel buffers. `RenderImageParams` (`:35–40`) is only image ID plus frame index, so the atlas key has no decoded pixels.
- `zed/crates/gpui/src/elements/img.rs:40–50, 535–580`: `ImageSource::Render` directly shares a decoded Arc; `Image` is encoded bytes plus a decode task; `Resource` goes through the explicitly scoped cache when present and otherwise through the application asset cache. `remove_asset` removes the application task, not atlas tiles. Resource identity distinguishes path, URI and embedded assets; resource decoding returns a shared Arc.
- `zed/crates/gpui/src/app.rs:3092–3127`: application assets are `CachedLoad` entries keyed by asset type and source hash. A completed entry keeps its shared output until removed. Dropping an element alone does not remove that application entry.
- `zed/crates/gpui/src/elements/image_cache.rs:165–219`: `ImageCacheItem` owns `CachedLoad`; dropping an entry cancels a pending load. `ImageCache` is responsible for unloading window images. `ImageCacheProvider` supplies the entity for a render scope.
- `zed/crates/gpui/src/elements/image_cache.rs:222–294`: despite a stale comment mentioning LRU, `RetainAllImageCache` is a HashMap retaining **all** entries until explicit remove/clear or entity release. Its release observer drops each completed image from every window. Clear/remove use the same path. Do not assume it has a byte bound.
- `zed/crates/gpui/src/elements/image_cache.rs:14–18, 116–118, 154–157, 307–335`: `image_cache(retain_all(id))` ties the cache entity to element state; layout and prepaint push it onto the window cache stack. `div.rs:1825–1827, 1936–1944, 2032, 2074` also scopes descendants with `.image_cache(...)`. `img.rs:222–234` resolves explicit image cache first, then nearest ancestor, then app cache. Resource loading uses the scope; raw Render sources share the caller's Arc.
- `zed/crates/gpui/src/window.rs:5192–5205`: `window.drop_image` removes every `(image_id, frame_index)` atlas tile. It does not force destruction of other CPU Arc owners. `app.rs:3185–3197` applies this to every window, including an explicitly supplied window currently outside the app's window map.
- `zed/crates/gpui/src/elements/img.rs:256, 397–419`: the persistent image state owns a delayed loading-indicator task, reset once loaded. This timer is distinct from the asset decode/load task. Scoped cache entry cancellation is effective; an app asset task outlives an element until explicitly removed.

## zeron

- `zeron/crates/ui/src/tool_images.rs:1–7, 21–33`: tool-image previews decode off the UI thread directly into bounded BGRA thumbnails (1120×440), bypassing the application asset cache. Four previews per chip; a 600 ms collapse grace reuses pixels through rapid toggles; a 64 MiB CPU+GPU budget considers previews unpainted for at least two seconds eligible. Painted content is protected even if it exceeds the budget.
- `tool_images.rs:174–215, 237–276`: ready states hold one `Arc<RenderImage>` and paint clones that Arc. Loading states own `Task<()>`, whose drop cancels work. Holders map expanded chip IDs to image keys.
- `tool_images.rs:312–360`: hidden or removed rows release their chip holders. Chat switch clears holders, cancels the sweeper, drains entries and resets byte accounting immediately.
- `tool_images.rs:365–447`: asynchronous completion updates the owning view weakly; a released entry rejects a late result before upload.
- `tool_images.rs:449–526`: eviction removes the least recently painted stale image; the sweeper runs only for pending release deadlines. Visible/overscan content is not evicted every frame.
- `tool_images.rs:529–558`: accounting includes CPU pixels plus GPU copy; deferred cleanup calls `cx.drop_image(image, None)` for all windows after the current update. Draining loading states cancels their tasks.
- `tool_images.rs:561–592`: decode creates `Arc::new(RenderImage::new(vec![Frame::new(pixels)]))`, moving rather than cloning frame pixels.
- `zeron/crates/ui/src/transcript.rs:3575, 4769, 8008`: release observer/chat reset clear the image owner, and hiding a row releases its previews. `:6999` paints a shared Arc with `img(image.image.clone())`.

These are distinct image paths; static file-icon caches and other attachment/background caches also exist. The tool-preview policy is not proof that every zeron image disappears immediately on leaving the viewport.

## Static frame construction and GPUIX

Zed `crates/gpui/src/platform.rs:3322` constructs a static frame with `SmallVec::from_elem(Frame::new(data), 1)`. `smallvec` clones that frame even for one inline item; `image::Frame::clone` clones its pixel Vec. This is an initial decode copy, **not a clone on every paint**. The pinned GPUIX fork has the same static decoder at `native/upstream/zed/crates/gpui/src/platform.rs:2636`, and its additional `RenderImage::from_bgra` does the same at `assets.rs:74`. Moving a single frame into a one-element array avoids these copies without changing pixels or animation frame delays. Allocation stacks must still distinguish a transient decode copy from a retained image owner.

The current GPUI API was also checked through Context7 (`/websites/rs_gpui_gpui`): [ImageCache](https://docs.rs/gpui/latest/gpui/trait.ImageCache.html), [RetainAllImageCache::clear](https://docs.rs/gpui/latest/gpui/struct.RetainAllImageCache.html), and [Context::drop_image](https://docs.rs/gpui/latest/gpui/struct.Context.html#method.drop_image). The pinned sources above establish implementation details that current API documentation alone cannot certify.

## Cancellation differs between the research revision and pinned GPUIX

Current Zed `asset_cache.rs:14–64` keeps a single owner task beside a weakly referenced result state. The completion task cannot keep that state alive after the cache disappears, and publishing a result cannot cancel its own task. Subscribers are entity IDs deduplicated in a set, not additional load-owner tasks. `window.rs:4298–4308` accesses this owned cache directly.

The pinned GPUIX fork still uses `Shared<Task<Output>>` in `app.rs` (`fetch_asset`), with an additional detached waiter in `window.rs::use_asset`. Removing the app entry therefore need not immediately cancel a pending load while that waiter owns a shared task. It does release completed cache output once all owners disappear. This distinction must be retained when interpreting cache counters or porting current Zed's cancellation approach; the newer implementation was researched rather than silently assumed to be present.

## Optional 3,000-turn JavaScript inspection

The integrated checkout already contains the later sparse-list lane. Its recorded `perf/scroll2/RESULTS.md:120–122, 155–158` shows roughly 364–368 MiB active / 356 MiB idle for the synthetic 3,000-turn sparse transcript, versus 664/652 MiB in its dense control. These are that lane's historical measurements, not a new image-lane result.

Source inspection does not show a second persistent raw-event history in the ordinary thread model: `packages/kybern-client/src/transcript.ts:80–94, 107–121` stores projected blocks; GPUIX `src/state.ts:145–180` shares a session between panes and drops unused sessions. `src/transcript/store.ts:255–277` retains an event replay buffer only while an older page hydrates and unregisters it in `finally`. The loaded logical blocks and identity/height metadata still scale with loaded history, while the sparse window bounds mounted rows. Discarding those blocks without designing paged rehydration would risk older-history anchors, selection and row identities. This lane does not make that unrelated product change or attribute physical footprint to raw history without heap-owner evidence.

## GPUIX retained owner, measured on the preserved addon

The untimed `owner-before` diagnostic recorded 24 live `image::Frame::clone` allocations of 6,307,840 bytes each (144.4 MiB including stack-logging allocator overhead), after `editorImages.entries` fell from 24 to zero. `history.txt` attributes allocation to `RenderImage::from_bgra` called by `rich_editor::set_image`. `owners.txt` traces a pixel buffer through its 112-byte `Arc<RenderImage>` allocation into a HashMap allocation owned by a live `RichEditorState` entity, then the GPUI application entity map. The table is the derived `RichEditorState.layouts`: `native/patches/rich_editor.rs:1081–1096, 1186–1202, 1346, 2968–2969` stores a strong image Arc in each `Lay`, even after the host has detached. Document blocks and undo snapshots contain image source strings, not decoded pixel buffers. This explains why the main image-cache counter alone missed the owner. The conservative trace also finds a TLS table path; removed HashMap buckets can contain stale pointer bits, so this is not treated as a second proven strong owner.

Re-running the corrected exact-size filter still returned no addresses: stack logging changes the allocation size, and the derived non-object class does not match literal `malloc[size]`. Enumerating all live blocks sorted by size and accepting both whitespace and colon after each address yielded a real allocation for `malloc_history` and `leaks --traceTree`. Both attempts are preserved under `owner-exact-filter-miss` and `owner-before` in the evidence directory. These probes ran without performance/resource claims; paired timed results use separate quiet windows.

The fix makes `Lay` hold `Weak<RenderImage>` (`native/patches/image_owner.rs` and `image_owner_hooks.py`). Existing document-cache leases protect mounted editor documents and their undo/redo image sources (`rich_editor.rs:3468–3487`); paint upgrades a weak handle temporarily. Closing releases the single cache owner and existing deferred `trim_images` removes atlas tiles (`:3504–3532`), even if GPUI retains an editor layout entity. A same-binary `KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY=0` control restores strong layout owners. Separately, `image_frames_gpui.py` moves one static decoded frame into SmallVec; `KYBERN_IMAGE_FRAME_MOVE=0` restores the initial pixel copy for attribution. Neither path clones pixel buffers per paint.

## Pinned source links

- [Zed RenderImage ownership](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/assets.rs#L43): one frame collection inside a shared RenderImage.
- [Zed scoped image-cache release](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/elements/image_cache.rs#L222): cache removal and entity release unload completed images.
- [Zed atlas release](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/window.rs#L5192): dropping atlas tiles does not remove independent CPU Arc owners.
- [zeron tool-preview ownership](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/tool_images.rs#L312): hidden rows release their holders; chat switches drain them.
- [zeron static-frame construction](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/tool_images.rs#L561): pixels move into a frame, then painters share the outer Arc.

## Darwin allocator retention after the ownership fix

On the hidden display, weak layouts remove all 24 live decoded-image blocks,
but `vmmap` still identifies roughly 120–150 MiB of empty large malloc regions,
sometimes compressed rather than resident. Footprint remains charged. A bounded
native `malloc_zone_pressure_relief(NULL, goal)` experiment returned zero bytes
on both closes (maximum 1 microsecond). That hook was dropped.

The unprofiled fixture-only `MallocLargeCache=0` control isolates this cause:
cache-on was 145→318→270 MiB; cache-off was 142→285→170→284→174 MiB.
Both closed-note residuals (+28/+32 MiB) meet the +40 MiB goal. Every sample's
screen, hidden 2× display, build and process gates passed. The cache-off flag
is a diagnosis; the normal application launch environment is unchanged.

The replacement is an addon `#[global_allocator]`: native Rust allocations
of at least 4 MiB, with alignment no greater than a system page, use anonymous
zero-filled mappings and `munmap` on release. Small and over-aligned allocations
retain `System`, and small reallocations keep System's optimized path. A static
C getenv/atomic configuration avoids allocating recursively inside the allocator.
`KYBERN_LARGE_ALLOCATIONS_VM=0` provides the same-binary System control. Counters
report requested mapped bytes, peak, calls and failures; these are not a physical
footprint measurement. Native mapping balance, vmmap and footprint must agree.
Per-frame performance and complete native/image regressions remain acceptance
checks before keeping this replacement.

Primary contracts: [Rust GlobalAlloc](https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html),
[Apple mmap/munmap](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/mmap.2.html),
[Apple libmalloc pressure-relief API](https://github.com/apple-oss-distributions/libmalloc/blob/main/include/malloc/malloc.h),
and [large-cache startup control](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/malloc.c).
The N-API Buffer drop path was inspected: JS-owned buffers release their N-API
reference, while Rust-owned Vec buffers use their stored length and capacity.
Native/GPUI source inspection found no foreign malloc buffer adopted as a Vec.
