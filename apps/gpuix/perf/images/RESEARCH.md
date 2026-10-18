# Decoded image ownership in Zed and zeron

Research clones under `/Users/mymac/projects/ade-gpuix-scratch/research/` are read-only. Line references below name those clones, not the GPUIX generated build tree. Zed revision: `56934ec0560bce8929025497411de7f5322fb6ca`; zeron revision: `c526d6f7cfc7a53e5588e3e6c5df7484a14d649f`.

## Zed GPUI

- `zed/crates/gpui/src/assets.rs:43–69`: `RenderImage` owns `SmallVec<[image::Frame; 1]>`, **not Arc buffers per frame**. `RenderImage` itself is shared through `Arc<RenderImage>`. Its constructor moves the frames. `as_bytes` borrows frame storage (`:72–76`); drawing an Arc does not clone pixel buffers. `RenderImageParams` (`:35–40`) is only image ID plus frame index, so the atlas key has no decoded pixels.
- `zed/crates/gpui/src/elements/img.rs:40–50, 535–580`: `ImageSource::Render` directly shares a decoded Arc; `Image` is encoded bytes plus a decode task; `Resource` goes through the explicitly scoped cache when present and otherwise through the application asset cache. `remove_asset` removes the application task, not atlas tiles. Resource identity distinguishes path, URI and embedded assets; resource decoding returns a shared Arc.
- `zed/crates/gpui/src/app.rs:3092–3127`: application assets are shared tasks keyed by asset type and source hash. A completed shared task keeps its output until removed. Dropping an element alone does not remove that application entry.
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
