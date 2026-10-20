# Markdown document performance

This lane reuses the Explorer native AppKit wheel producer and sample harness.
Set scratch `KYBERN_DATA_DIR` and `KYBERN_CLIENT_CONFIG_DIR` for every invocation.
The lane uses daemon port 4326 and the scratch directory supplied in its brief.
Run `perf/explorer/seed.ts`, compile `perf/explorer/wheel.m` as described in that
harness, then `bun perf/markdown/seed.ts` to add 2MiB-class and pathological files.

`bun native/ui-lease.ts perf-markdown bun perf/markdown/run.ts <label>` owns the
UI lease. `EXPLORER_SCENES` selects files. Labels beginning `before` restore
Explorer at d4269d55 and use `native/build/markdown-before.node`, preserving the
Explorer lane's fixes. `EXPLORER_VISUAL=1` captures separately from timings;
`KYBERN_APPEARANCE=light` selects the other theme. Output is placed in the
original conversation's `previews/gpuix/perf/markdown/` directory.

The timing harness rejects native-build markers before/after/during each sample.
Do not begin a native/Cargo build while a `kybern-gpuix-quiet.*` file exists.
Use a per-lane native marker, nice priority 15 and four Cargo jobs during builds.
Native submissions and CPU-paint latency are proxies, not presentation fences or
physical input-to-photon measurements. See `perf/explorer/README.md` for the exact
input and resource methodology.

`native/markdown-document-check.ts` compares the canonical document against the
original native Markdown pixels and checks document lifecycle, references, append
state, cancellation, source identity, limits and measured heights. The original
`native/markdown-check.ts` remains in the full update suite. Pure append tests are
in `native/patches/markdown_model.rs`; a tiny rustc test wrapper can include the
patched parser module and this file, linking the already-built pulldown-cmark
release rlib with the pinned Rust toolchain. `native/update.sh` runs
`native/markdown-document-test.py` to build and execute that wrapper.

`bun perf/markdown/quiet.ts bun native/ui-lease.ts perf-markdown-pair bun perf/markdown/pair.ts`
collects the matched preview/PR Summary batch. Wait for existing quiet/build
reservations first; a quiet reservation belongs to its named lane. The helper
respects build reservations and the shared quiet-window order file. `MARKDOWN_PR=1` runs the existing
long PR action fixture through the same native wheel producer and resource
sampler. `EXPLORER_SCENES=two-mib.md,giant-paragraph.md,...` selects the extended
Markdown files. Use at most a few scenarios per lease to stay below five minutes.

`MARKDOWN_DOCUMENT_STATS=1` logs registry counts while retaining normal timings;
`EXPLORER_IDLE=1` closes the file and records 15 seconds of settled idle after a
20-second wait. `EXPLORER_LIFECYCLE=1` is a separate untimed create/close probe.
Every sample saves the process inventory before and after it and rejects other
GPUIX apps/fixtures/labs. The run, batch and quiet wrappers propagate interruption
to their children; the app runner also stops resource/profile helpers on exit.

`native/update.sh` now gives geometry, content and input checks separate bounded
UI leases. The four lock-using checks share one inherited input lease. Rust parser
checks run in the marked build phase; the document matrix runs in the content
lease, including the canonical convo9 A/B/C sources in both themes.
Do not compare measurements from the contaminated 2026-10-18 05:16–05:32 UTC window.

`bun perf/markdown/quiet.ts bun perf/markdown/measure.ts` collects the final pair,
large-document and container batches, then separate diagnostic profiles. It queues
in `/tmp/kybern-gpuix-quiet-order`, owns at most 25 minutes, and uses a fresh fair
UI lease per bounded batch. Profile samples are diagnostic, excluded from the
acceptance table. `capture.ts` refreshes the after images under a separate lease.

`bun perf/markdown/report.ts` checks the final paired inputs, rejects recorded
build overlap, verifies all six large-file reachability records, and writes
`summary.json` beside the raw evidence. It prints the resource/frame table for
the lane report. Cold first-content latency is reported separately from warm
scroll cost. `resume3-manifest.json` records source/binary hashes and fixture sizes.

The final correction builds cold measurement children inside a disposable GPUI
element arena as well as an isolated layout engine. Only sizes and owned
text/geometry survive. The UI lease cleanup also verifies that a process group
is empty before ignoring Darwin/Bun's post-exit `EPERM`; interruption still
stops the command and grandchild. Both cases are covered by `ui-lease-check.ts`.

`native/markdown-document-cost-check.ts` is a load-independent warm-layout
regression gate: 1,500-row tables and code fences must remain under 1,000 layout
calls per wheel frame, including after a real viewport resize. Indeterminate
intrinsic-size probes reuse the last measured width; a definite new width still
invalidates geometry. The original regression made approximately twice the row
count in layout calls on every frame. The check runs in the update content batch.

PR capture waits for the real native scroll handle to reach exactly -650 px and
saves the offsets. An earlier baseline light/scrolled image had captured offset
zero because wheel delivery followed the paused-clock automation response. Both
sides are now captured with the same verified offset before exact comparison.

Run the full marked `native/update.sh` before requesting the final quiet window.
The quiet measurement runner deliberately excludes individual native checks/labs;
its captures and resource trials use separate bounded UI leases.
