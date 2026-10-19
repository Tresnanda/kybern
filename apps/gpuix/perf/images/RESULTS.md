# Decoded image ownership and released memory

## Result

Closing the editable 24-image note now leaves **+22/+24 MiB** over its 145 MiB start after two round trips, meeting the ≤+40 MiB goal. The same-addon System allocator control leaves **+168/+171 MiB**. Repeated 48-image traversal returns to **+2/+2 MiB**, with no ratchet. All final resource samples passed the unlocked/awake, hidden 2× display, process, quiet-window and build gates.

This combines three changes: weak derived-layout image references, moving a static frame instead of cloning its pixels, and anonymous mappings for native Rust allocations ≥4 MiB on macOS. The final pair isolates the allocator: both sides already use weak layouts and moved frames. Only `KYBERN_LARGE_ALLOCATIONS_VM=0` differs. Earlier owner/control diagnostics establish why allocator work alone would not fix strong references.

The mapped scroll pair has p95/p99 intervals 17.11/19.42 ms versus System 18.30/21.30 ms, and neither has an interval over 33 ms. CPU is effectively similar, 47.88% versus 47.17%. This single pair supports keeping the allocator; it does not establish a general GPU or frame-rate improvement.

## Root cause, owner proof and research

The original untimed `owner-before/` heap trace found 24 live `image::Frame::clone` pixel allocations of 6,307,840 bytes each (about 144 MiB) after `editorImages.entries` was zero. `history.txt` locates allocation at `RenderImage::from_bgra` → `rich_editor::set_image`; `owners.txt` follows pixels through the 112-byte `Arc<RenderImage>`, the derived `RichEditorState.layouts` HashMap, and the GPUI entity map. Undo/document blocks contain source strings, not decoded pixels. A conservative TLS trace is not counted as another proven strong owner. Exact-size filtering missed these derived blocks under stack logging; the all-address fallback and failed filter are both preserved. The hidden-display rerun in `before-note-stacks/` corroborates the retained decoded blocks.

Weak layouts eliminate those heap owners, but footprint initially remains high: `before-vm-note/home-editor-many-1-vmmap.txt` shows **153.4 MiB virtual / 150 MiB dirty `Malloc Large (empty)`** after close. The mapped counterpart has no empty-large row, zero live mapped bytes, zero image-cache entries and zero cache strong references. Across both mapped note round trips, **144 maps and 144 unmaps**, zero failures; each open holds 24 mappings totaling 104,816,640 requested bytes. Counters describe requested allocation sizes, not physical footprint; `footprint` and `vmmap` provide the physical evidence. Native sizing/decoding in this current fixture differs from the older stack-logging owner trace, so the historical 144 MiB is not substituted for current mapped-byte accounting.

The fixture-only `MallocLargeCache=0` diagnosis proved the allocator cache: normal malloc was 145→318→270 MiB; cache disabled was 142→285→170→284→174 MiB. Both diagnosis gates passed. This environment variable is not added to application startup. A bounded public pressure-relief trial returned **0 bytes twice**, maximum 1 μs, and was removed entirely from shipping hooks.

Research supports explicit ownership and release rather than cache-counter inference: [Zed's scoped image-cache release](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/elements/image_cache.rs#L222), [separate atlas release](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/window.rs#L5192), and [zeron's hidden-row/chat holder release](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/tool_images.rs#L312). [zeron moves static frame storage](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/tool_images.rs#L561). GPUI painting already shares the outer Arc; the frame clone was at construction, not every paint. Current Zed asset cancellation differs from this pinned GPUIX fork. Full source distinctions and current API checks are in [RESEARCH.md](RESEARCH.md).

Allocator contracts: [Rust GlobalAlloc](https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html), [Apple mmap/munmap](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/mmap.2.html), [libmalloc pressure relief](https://github.com/apple-oss-distributions/libmalloc/blob/main/include/malloc/malloc.h) and [large-cache startup control](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/malloc.c).

## Method

Apple M1, macOS 27.0.1, Bun 1.4.0, GPUIX 0.10.0. Hidden virtual display 1440×900 logical pixels at 2×, 60 Hz; all launches `GPUIX_BACKGROUND=1`, all samples `KYBERN_FULL_RATE=1`. Window bounds are wholly inside CG x −1440..0, y 900..1800; every result records before/after 2× display checks. Scoped caffeinate, isolated scratch daemon/data (port 4340), exclusive UI leases and no build overlap. Native rebuild is low-priority, four Cargo jobs, own target, incremental disabled; build marker held through all update checks.

Each row has a 10-second warm-up and 15-second CPU/GPU/physical-footprint sample. Static fixtures are blurred to remove caret activity and correctly submit **zero frames / zero GPU ms**; no frame quantiles or input latency are claimed for their idle windows. Transition proxy values are cumulative host-request-to-next-scene-submission observations outside the idle sample, not physical presentation latency. Traversal uses 48 distinct 1536×1024 PNG files twice, then 24 read-only editor visits and a 12,000-line code fixture. The editable note opens 24 images and closes twice.

Product scroll uses a synthetic 1,000-turn mixed-content thread containing 48 image references. Both sides offer and acknowledge exactly **1,800 native wheel RPC packets over 15 seconds**, at 120 Hz with reversals and synthetic exponential momentum; maximum outstanding 3/4, drain 0.247/0.158 ms. Warm-up scrolling precedes capture. The active viewport cache holds two images on each side. This does not assert all 48 images are simultaneously decoded. No screenshots or clock fast-forward occur in timed runs. Resource sampling and telemetry have slightly different endpoints; GPU total / submitted frame is a rough ratio, not a GPU fence duration.

## Static resource pairs

Cells are **System → mapped**; both retain the weak-owner and frame-move fixes. All rows below have zero submitted frames, no >16.7/>33 ms intervals, zero GPU ms, and no idle input samples.

| Scenario | Footprint MiB | CPU % | Transition proxy p50/p95/p99 ms (System → mapped) |
|---|---:|---:|---|
| note: home-initial | 145 → 145 | 4.05 → 4.25 | —/—/— → —/—/— |
| note: editor-many | 323 → 286 | 3.85 → 4.25 | 21.85/21.85/21.85 → 21.56/21.56/21.56 |
| note: home-editor-many | 313 → 167 | 4.05 → 4.05 | 21.85/21.85/21.85 → 21.56/21.56/21.56 |
| note: editor-many-1 | 326 → 283 | 3.91 → 4.25 | 21.85/21.85/21.85 → 21.56/21.56/21.56 |
| note: home-editor-many-1 | 316 → 169 | 3.91 → 4.05 | 21.57/21.85/21.85 → 14.90/21.56/21.56 |
| lab: home-initial | 144 → 144 | 4.05 → 4.05 | —/—/— → —/—/— |
| lab: images-0 | 174 → 171 | 3.98 → 3.65 | 42.14/47.42/49.26 → 39.25/48.52/51.26 |
| lab: home-images-0 | 162 → 146 | 4.11 → 3.72 | 41.62/47.42/49.26 → 38.98/48.52/51.26 |
| lab: images-1 | 174 → 170 | 4.51 → 3.65 | 39.44/49.26/51.41 → 36.79/48.01/51.26 |
| lab: home-images-1 | 168 → 146 | 3.45 → 3.98 | 39.44/49.26/51.41 → 36.79/48.01/51.26 |
| lab: editor-images | 193 → 173 | 3.78 → 3.45 | 39.25/48.73/51.41 → 37.61/48.01/51.26 |
| lab: home-editor | 189 → 164 | 3.52 → 3.58 | 38.79/48.73/51.41 → 37.46/48.01/51.26 |
| lab: code-12000 | 436 → 428 | 3.85 → 3.25 | 38.79/48.73/51.41 → 37.46/48.01/51.26 |
| lab: home-code | 296 → 289 | 3.65 → 3.58 | 38.79/48.73/51.41 → 37.46/48.01/51.26 |

The note's closed residual is +168/+171 → **+22/+24 MiB**. Traversal's closed residual is +18/+24 → **+2/+2 MiB**. Read-only editor close is +45 → **+20 MiB**. Code close remains +152 → **+145 MiB** and is an unresolved separate high-water mark.

## Product resource and frame pairs

The synthetic running sidebar row intentionally refreshes around 5 Hz on home. Those ~200 ms intervals are its animation cadence, not missed 60 Hz deadlines. The separate static fixture above demonstrates zero-frame idle.

| Scenario | MiB System → mapped | CPU % System → mapped | GPU ms / ~15 s System → mapped | Frames System → mapped | Intervals p50/p95/p99 ms System → mapped | >16.7/>33 ms System → mapped |
|---|---:|---:|---:|---:|---|---|
| home-initial | 216 → 197 | 6.38 → 6.84 | 257.7 → 172.0 | 83 → 82 | 199.97/200.96/201.78 → 200.01/200.91/216.58 | 81/80 → 81/81 |
| image-thread-scroll | 310 → 293 | 47.17 → 47.88 | 3082.5 → 1281.5 | 954 → 957 | 16.66/18.30/21.30 → 16.67/17.11/19.42 | 439/0 → 363/0 |
| home-returned | 304 → 275 | 4.98 → 5.37 | 205.1 → 248.2 | 81 → 80 | 200.01/201.21/215.21 → 199.94/201.80/216.88 | 80/80 → 79/79 |

| Active-scroll cost/proxy | System | Mapped |
|---|---:|---:|
| Host wheel send → next submission p50/p95/p99 ms | 7.46/15.47/17.35 | 7.83/9.36/11.60 |
| Native dispatch → scene, first packet p50/p95/p99 ms | 15.90/17.60/20.14 | 13.75/15.79/17.36 |
| Native dispatch → scene, last packet p50/p95/p99 ms | 8.51/10.52/11.94 | 12.64/15.26/16.96 |
| CPU render p50/p95/p99 ms | 5.98/7.64/9.37 | 5.96/7.88/8.98 |
| CPU layout p50/p95/p99 ms | 0.88/1.32/1.57 | 0.85/1.33/1.51 |
| GPU total / submitted frame, approximate ms | 3.231 | 1.339 |
 
Native dispatch proxies exclude host/OS queueing, GPU completion and physical presentation. The last-packet proxy is higher in the mapped run although the host-send proxy and frame p95 improve; do not collapse those different clocks into a universal latency improvement. Render p99 remains above 8 ms on both sides. Mapping counters are 4 maps / 2 unmaps while scrolling, then 4/4 at home, zero failures: the allocator does not add a mapping syscall per rendered frame in this workload. Small allocation/reallocation paths retain System. The 60 Hz test display cannot certify 120 Hz presentation or real trackpad feel, and no energy measurement is claimed.

## Changes by file

Native patches:

- `image_owner.rs`, `image_owner_hooks.py`: derived `Lay` image fields become weak; mounted editor cache/undo-source leases remain strong; paint temporarily upgrades. Legacy flag restores strong ownership for diagnosis; expose reference counters.
- `image_frames_gpui.py`: move one decoded frame with `SmallVec::from_buf`; preserve animation delays and pixels. Extracted tests assert pixel pointer identity. The legacy construction-copy control remains.
- `large_alloc.rs`: macOS addon global allocator maps native Rust allocations ≥4 MiB with page-compatible alignment and unmaps at release. Kernel zero-fill supports `alloc_zeroed`. Smaller and over-page-aligned allocations stay on System; small realloc remains optimized, cross-threshold realloc copies before freeing. C getenv plus an immutable atomic configuration avoids allocator initialization recursion. Failure/size/call counters; same-addon `KYBERN_LARGE_ALLOCATIONS_VM=0` control. No idle timers, private reclaim APIs or startup MallocLargeCache override.
- `large_alloc_hooks.py`, `apply_hooks.py`, `backdrop_gpui.py`: isolated additive reconstruction hooks and native allocation stats. Every existing hook retained. N-API buffer ownership and native/GPUI foreign-buffer adoption were audited; no foreign malloc buffer adopted as Rust-owned Vec was found.
- `automation_display.rs`, `automation_display_hooks.py`: required hidden-display native placement from 29268adf/c1ab6aaf.

Placement and verification:

- `src/shell/window.ts`, `perf/test-display/`: required placement cherry-picks; test-display helper is never started/stopped/reconfigured by this lane.
- `native/subtree-translation-check.ts`: settle before untimed OS capture. `native/stroke-draw-check.ts`: preserve/retry black presentation captures without changing paused scene time or comparison tolerances.
- `perf/images/window-onscreen.swift`, `onscreen.ts`: reject wrong/missing/non-2× display; accept CG's quoted negative coordinates; bounded presented-pixel capture rejects black/incorrect known fixture background and preserves rejected captures.
- `build.py`: next-build reservation, post-screen recheck and simultaneous-marker arbitration; marker spans full update and checks. `check-frames.py`, `check-large-alloc.py`: nice-15 pinned Rust tests, including a separate disabled-control process.
- `pair.py`: queued, bounded quiet windows, explicit scratch/background env, same-addon controls and separate resource/check batches; clean owned subprocesses on failure.
- `summarize.py`: validate every sample gate and collect both controls. `visual-diff.ts`, `verify.ts`, `verify-run.ts`: exact functional canvas comparisons, both themes, lightbox/selection/history checks.
- `perf/memory/lab-run.ts`, `run.ts`, `visual.ts`, `metadata.ts`: allocator capability/control assertions, zero-failure assertions, display/capture gates, focused heap owner diagnostics, source/addon/flags metadata, nonambiguous multi-image wait and host-wheel timestamp proxy.

## Tried and dropped

- Zero cache entries as proof of release: insufficient; traced the actual strong owner and then the allocator's empty pages.
- Native public pressure relief: zero released bytes, removed. No unsupported private release hook.
- MallocLargeCache=0: useful fixture-only diagnosis, not shipped in app startup.
- Unsafe archived pre-placement addon: never launched after the hidden-display rule; use same-addon switches. Early previrtual resource samples are diagnostic only.
- First negative-bounds parser rejection: no sample taken, corrected numeric parsing. Initial native translation capture failed until presentation settled; one later stroke capture was black. Rejected originals remain preserved; pixel thresholds were not loosened.
- Old relief trial visual pair: one black/corrupt presented capture and a one-LSB image difference failed strict parity. Preserved under `diagnostic-noop-relief-*`; final mapped checks must independently pass.

## Visual and regression validation

All **20 functional canvases match exactly** (zero differing pixels) across both themes: shared/evicted/reopened images, editor reload, undo/redo, selected image/text, code and home. Both pinned lightbox canvases also match exactly. No final capture needed a black/background rejection retry. Both controls passed first/middle/tail rail navigation, image overlay surviving trigger disposal, Escape, Unicode native selection after row disposal and formatted final answer. Representative image/selection/lightbox captures were inspected visually. The fresh full `bun test ./src` passed **337 tests, 0 failures, 6,912 assertions across 58 files** in 8.15 seconds, resolving the previous display-missing timeouts.

The full native rebuild passed end to end, including all update.sh checks and `pnpm typecheck`; 2 extracted frame tests; 3 allocator tests plus the separately run disabled control; `pnpm exec tsc -p native/tsconfig.json`; and image-harness TypeScript.

Addon SHA-256 **fe5605070bfa27f79b2e2209f318116100ba8a4a23f4538e15087f61308d1a41**; native source at build: `8920e7cbcaef09df46b49754ab57a2d7e9eab45b`. `codesign --verify` passed. No native code changed after the validated build.

## Evidence and limits

All evidence: `/Users/mymac/projects/ade/previews/gpuix/perf/images/`.

- `paired-summary.json`: full six-case final resource pair with runtime/addon metadata, gates, quantiles, work and counters. Raw `results.json`, `*-resources.txt`, `*-footprint.txt`, `*-vmmap.txt` in `before-vm-note/`, `after-vm-note/`, `before-vm-lab/`, `after-vm-lab/`, `before-vm-thread-app/`, `after-vm-thread-app/`.
- `owner-before/`, `owner-exact-filter-miss/`, `before-note-stacks/`: original/rooted owner evidence. `after-vm-note/home-editor-many-heap.txt`: no retained decoded malloc blocks after final close; mmap balance and physical footprint provide the release proof for mapped storage.
- `allocator-cache-on/`, `allocator-cache-off/`: cache diagnosis. `diagnostic-relief-paired-summary.json`, `diagnostic-noop-relief-native-*`: ineffective relief trial, excluded from final allocator comparison.
- `native-update.log`, `native-checks/`, `native-validation.json`: full build/check evidence and signed addon identity.
- `before-final-visual/`, `after-final-visual/`, `visual-diff.json`: 20 exact image canvases. `lightbox-before/`, `lightbox-after/`, `lightbox-diff.json`: both-theme overlay/selection/rail captures and 2 exact lightbox canvases. `src-tests.log`, `lightbox-before.log`, `lightbox-after.log`: regression outcomes. `cleanup.json`: removed generated paths, retained artifacts and volume readings.

Remaining gaps: the separate large-code high-water mark; product return-home residual +78 MiB; one active-scroll A/B pair and variable GPU work; physical input-to-presentation and energy unmeasured; no 120 Hz display proof. Existing interaction/appearance checks are required, and no removed content/effect or empty renderer is counted as an optimization.

## Handoff and cleanup

Branch `gpuix/perf-images`; the final report commit is the branch tip reported in the handoff. All source/native changes and this report are committed; `git status --short` is clean. No app, fixture, scratch daemon, build or benchmark from this lane remains alive; its quiet/build/queue entries are released.

Free disk before resumption: **91 GiB**. Cleanup measured **79.7 → 81.6 GiB available** on the shared volume (other lanes also use it). Removed this lane’s 1.9 GiB Rust target, generated upstream 185 MiB, disposable dependencies 188 MiB, test binaries/fixtures, unsafe old addon, scratch daemon/client/image/stack-log data and allocator prototype. No user data, installed daemon, shared research clone, other lane’s output or worktree registration was removed. Retained only the validated **27,350,512-byte signed addon** and **103,024-byte runtime webview dylib** under `native/build/`, plus approximately 170 MiB of requested evidence in the original conversation folder. The addon SHA and signature were verified again after cleanup.
