# Decoded image ownership

## Finding

The editable 24-image document left 24 decoded pixel buffers alive after its document cache reported zero entries. Untimed `heap`, `malloc_history` and `leaks` traces in `owner-before/` identify 24 live `image::Frame::clone` allocations of 6,307,840 bytes each (about 144 MiB), created by `RenderImage::from_bgra` during `rich_editor::set_image`. The root path traverses the `RichEditorState.layouts` HashMap: each derived `Lay` held a strong `Arc<RenderImage>` after the editor host detached. The exact-size `heap --addresses` filter missed these derived non-object blocks; the corrected size and all-address fallback, with allocation and owner traces, are preserved in `owner-exact-filter-miss/` and `owner-before/`.

GPUI's one-frame construction also used `SmallVec::from_elem`, cloning the pixel Vec once at decode. This is an initial copy, not a paint-loop copy. Paint already shares `Arc<RenderImage>`. The source comparisons and references are in [RESEARCH.md](RESEARCH.md).

## Fix

- `native/patches/image_owner.rs` and `image_owner_hooks.py`: derived editor layouts hold `Weak<RenderImage>` and upgrade only while painting. The document image cache remains the owning lease for mounted content and undo/redo sources. Existing cache trim removes atlas tiles on release. A same-binary `KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY=0` control restores the old strong layout owner.
- `native/patches/image_frames_gpui.py`: move a decoded static frame into `RenderImage` with `SmallVec::from_buf`. Its Rust check asserts pixel-pointer identity. A same-binary `KYBERN_IMAGE_FRAME_MOVE=0` control restores the copy.
- `native/patches/apply_hooks.py` and `backdrop_gpui.py`: register those two isolated native patches.
- `perf/images/` and scoped changes in `perf/memory/`: capture editable-note round trips, traversal, real thread scroll, both themes, lightbox, and heap owners. The display gate rejects windows outside the hidden 2× test display before timing or capture.

## Method and current validation

All new samples use the hidden virtual display (1440×900 logical pixels, 2×, 60 Hz), an unlocked session, scoped caffeinate, exclusive UI leases and build-free quiet windows. The gate verifies an on-screen fixture window wholly inside CG x −1440..0 and y 900..1800 before and after sampling, and records those bounds. CoreGraphics quotes negative values in its dictionary description; the parser accepts that numeric representation. The first resume attempt rejected a correctly placed window before taking a resource sample; its log is `diagnostic-quoted-negative-window-bounds.log`.

The archived `images-before.node` predates hidden-display placement and is not launched. Final A/B uses the same rebuilt addon with `KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY=0` and `KYBERN_IMAGE_FRAME_MOVE=0` as the legacy control. The owner-only control restores frame copying while retaining weak layouts. This isolates both image changes while keeping placement and every other native patch identical. `KYBERN_FULL_RATE=1` is used throughout.

The preserved early diagnostics measured 145 MiB at home, 334 MiB with the editable 24-image note, and 320 MiB after closing (+175 MiB). A 48-image traversal measured 143 MiB initially and 167–168 MiB after two visits. Their placement was not established, so they are excluded from final comparisons and archived under `diagnostic-previrtual-*`.

The resumed full `native/update.sh` passed end to end, followed by both extracted GPUI frame tests, native TypeScript and image-harness TypeScript checks. `pnpm typecheck` also passed. Evidence: `native-update.log` and the fresh `native-checks/`. Addon SHA-256: `6c525b4b0ee5dfe3c474b9a60af00e67ba7323c464386d601b176725cc194f3d`.

One initial retained-translation capture comparison failed. Waiting 150 ms before each untimed OS capture produced zero pixel differences in all eight theme/motion/region combinations and the complete update then passed. The inferred cause is sampling before presentation settled; the original failure log and captures remain under `native-update-first-capture-failure.log` and `first-capture-failure-*`. Pixel tolerances and renderer behavior are unchanged.

## Resume changes, file by file

Native image patches (already present at the parked commit):

- `native/patches/image_owner.rs`: weak decoded-image handles in derived editor geometry; strong legacy control.
- `native/patches/image_owner_hooks.py`: apply that ownership type at layout creation/paint and expose reference counters.
- `native/patches/image_frames_gpui.py`: move one decoded frame into SmallVec and assert pixel-pointer identity; legacy copy control.
- `native/patches/apply_hooks.py`, `backdrop_gpui.py`: additive reconstruction hooks.

Resumed placement and validation:

- `native/patches/automation_display.rs`, `automation_display_hooks.py`, `src/shell/window.ts`, and `perf/test-display/`: cherry-picked placement commits 29268adf and c1ab6aaf, preserving all existing image hooks.
- `native/subtree-translation-check.ts`: settle before untimed OS captures.
- `perf/images/window-onscreen.swift`, `onscreen.ts`: require the active hidden 2× display and correct on-screen bounds; accept quoted negative coordinates.
- `perf/images/build.py`: reserve the next build slot before waiting for current builds/quiet windows, avoiding starvation; hold the build marker throughout update and checks.
- `perf/images/pair.py`: same-addon controls, queued runs, isolated regression tests and both-theme lightbox pixel comparisons.
- `perf/images/summarize.py`, `visual-diff.ts`, `verify.ts`: compact gate-checked result collection and functional pixel comparisons.
- `perf/memory/lab-run.ts`, `run.ts`, `visual.ts`, `metadata.ts`: display evidence, accurate display metadata and wheel-send-to-scene-submission proxy timestamps.

## Remaining validation

Final legacy/fixed samples, heap comparison, both-theme image/lightbox diffs and the fresh full `bun test ./src` are still pending in the shared UI/build queue. The earlier full source test run passed 337 tests; the later two timeouts while the display was missing are not a valid regression result. No final memory or scroll improvement is claimed until the new paired records exist.

The final report must include settled note residuals (goal ≤40 MiB), repeated 48-image and note round trips, active image-thread frames/input proxy/CPU/GPU/footprint, and the before/after live allocation evidence. Native submission timestamps and CPU construction proxies are not physical presentation fences; this 60 Hz virtual display cannot certify real trackpad feel, energy use or 120 Hz presentation.

Free disk before resumption was 91 GiB; after the validated rebuild it was 86 GiB. The volume is shared with other lanes. Task build/dependency/scratch cleanup and the final disk reading remain pending; retain the validated signed addon and runtime webview dylib.
