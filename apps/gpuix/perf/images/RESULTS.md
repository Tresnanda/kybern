# Decoded image ownership

## Finding

The editable 24-image document left 24 decoded pixel buffers alive after its document cache reported zero entries. Untimed `heap`, `malloc_history` and `leaks` traces in `owner-before/` identify 24 live `image::Frame::clone` allocations of 6,307,840 bytes each (about 144 MiB), created by `RenderImage::from_bgra` during `rich_editor::set_image`. The root path traverses the `RichEditorState.layouts` HashMap: each derived `Lay` held a strong `Arc<RenderImage>` after the editor host detached. The exact-size `heap --addresses` filter missed these derived non-object blocks; the corrected size and all-address fallback, with allocation and owner traces, are preserved in `owner-exact-filter-miss/` and `owner-before/`.

GPUI's one-frame construction also used `SmallVec::from_elem`, cloning the pixel Vec once at decode. This is an initial copy, not a paint-loop copy. Paint already shares `Arc<RenderImage>`. The source comparisons and references are in [RESEARCH.md](RESEARCH.md).

## Fix

- `native/patches/image_owner.rs` and `image_owner_hooks.py`: derived editor layouts hold `Weak<RenderImage>` and upgrade only while painting. The document image cache remains the owning lease for mounted content and undo/redo sources. Existing cache trim removes atlas tiles on release. A same-binary `KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY=0` control restores the old strong layout owner.
- `native/patches/image_frames_gpui.py`: move a decoded static frame into `RenderImage` with `SmallVec::from_buf`. Its Rust check asserts pixel-pointer identity. A same-binary `KYBERN_IMAGE_FRAME_MOVE=0` control restores the copy.
- `native/patches/apply_hooks.py` and `backdrop_gpui.py`: register those two isolated native patches.
- `perf/images/` and scoped changes in `perf/memory/`: capture editable-note round trips, traversal, real thread scroll, both themes, lightbox, and heap owners. The display gate rejects windows outside the built-in screen before timing or capture.

## Measurement

The first 24-image baseline measured 145 MiB at home, 334 MiB with the editable note, and 320 MiB after closing (a 175 MiB residual). A separate 48-image traversal baseline measured 143 MiB at home and 167–168 MiB after each of two visits. Those early samples are retained as diagnostics; their window placement was not established, so they are not used for the final before/after claim. Final paired built-in-screen values follow below.

## Verification and limits

The full `native/update.sh` completed on the image patch; its log is `native-update.log`. The frame ownership check passed both GPUI tests (`frame-checks.log`). A later environment issue required the display gate: the native fixture's level-3 window had been excluded by a layer-0 query, and the current unplaced fixture appeared at x=410..1510 on a 1920-point main screen. The helper now checks all owned window levels and parses full bounds. Final paired measurements and visual comparisons await placement of all fixture windows on the built-in screen.

`pnpm typecheck`, `pnpm exec tsc -p native/tsconfig.json`, and `pnpm exec tsc -p perf/images/tsconfig.json` pass. The earlier full `bun test ./src` run passed 337 tests. A later rerun while the built-in display was absent timed out in two tests, including one that launches a GPUIX fixture; that run is not a valid regression check. The same two tests timed out on a targeted rerun in that display state, so a fresh full run is required after the screen returns.

The built-in Retina display disappeared during the final paired run. The image gate now requires an active 2× built-in screen, an on-screen fixture window and bounds within the 1440×900 built-in area. It rejected the final run before its first resource sample. No final after measurements or verified pixel comparison exist yet.

## Resume

1. Integrate the orchestrator's validated automation window placement patch when it is handed to this lane. With the built-in Retina display active and no quiet/build marker, run `python3 perf/images/build.py` from `apps/gpuix`. This repeats full `native/update.sh`, the frame-pointer tests and native/perf TypeScript checks under a marked build slot.
2. Run `KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/perf-images python3 perf/images/pair.py baseline before-all` and then `KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/perf-images python3 perf/images/pair.py final after-all` from `apps/gpuix`. Each command queues its own build-free quiet window. The preserved `native/build/images-before.node` is the original control binary. Reject either run if the 2× built-in display, screen, window or overlap checks fail.
3. Inspect `results.json`, heap owner traces and both-theme image diffs under `/Users/mymac/projects/ade/previews/gpuix/perf/images/`. Confirm that the settled editable note is at most 40 MiB over its own home baseline, that round trips do not ratchet, and that image-thread scroll and selection/lightbox pixels remain correct. Rerun `bun test ./src` with the display available.
4. Complete the final table here, commit it, then remove the task's `native/build/target`, scratch data and daemon after checking for active users. Keep the signed addon and evidence.
