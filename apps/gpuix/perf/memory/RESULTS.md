# Native memory results

Apple M1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina LCD.
All numbers use `KYBERN_FULL_RATE=1`, unchanged rendering defaults and a scratch
daemon. Resource samples use 10-second warmup and 15-second windows; startup
uses separate fresh-process probes. Scrolling/startup has
three accepted repeats per scenario; memory stages are single settled samples.
CPU is percent of one core; GPU time and physical footprint come from the shared
native sampler. RSS is not used. Raw evidence: `/Users/mymac/projects/ade/previews/gpuix/perf/memory`.

The memory stages are settled snapshots, not scrolling frame-rate tests. Their
full frame distributions, counts, native counters, JS heap observations and
timestamps are retained in `results.json`. The full-product Home keeps the
synthetic running sidebar row, whose 200 ms updates are intentional. The
separate idle-home scenario removes it. Startup submission gaps are not dropped
animation frames. Idle interval/work distributions are omitted when the median
window has zero submissions; any first-window transition frames remain in the
individual raw results. Latency is offered input to next scene-submission stderr
receipt; physical input-to-present latency is unavailable.

## Image and code round trip

| Workload | Footprint MiB before → after | CPU % before → after | GPU ms / 15 s before → after | Submission p50/p95/p99 ms before → after | >16.7/>33 ms before → after |
|---|---:|---:|---:|---|---:|
| home-initial | 144.00 → 145.00 | 2.86 → 2.59 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| images-0 | 737.00 → 182.00 | 2.66 → 2.46 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| home-images-0 | 737.00 → 169.00 | 2.72 → 2.52 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| images-1 | 737.00 → 182.00 | 2.66 → 2.59 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| home-images-1 | 737.00 → 170.00 | 2.72 → 2.52 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| editor-images | 1022.00 → 199.00 | 2.66 → 2.52 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| home-editor | 1022.00 → 194.00 | 2.79 → 2.66 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| code-12000 | 1275.00 → 441.00 | 2.72 → 2.52 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| home-code | 1275.00 → 302.00 | 2.66 → 2.46 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |

A separate code-only process repeats the code → Home transition twice; its
accepted footprints and native counters are retained under `codeRepeatAfter`
in `results.json`. This separates a reusable high-water allocation from growth
on each visit.

| Code-only stage | Footprint MiB | Layout node high water |
|---|---:|---:|
| home-initial | 144.00 | 14 |
| code-12000 | 407.00 | 48018 |
| home-code | 267.00 | 14 |
| code-12000-repeat | 325.00 | 48018 |
| home-code-repeat | 227.00 | 14 |

## Full product

| Workload | Footprint MiB before → after | CPU % before → after | GPU ms / 15 s before → after | Submission p50/p95/p99 ms before → after | >16.7/>33 ms before → after |
|---|---:|---:|---:|---|---:|
| thread-explorer-notes / home-initial | 216.00 → 214.00 | 6.31 → 6.05 | 127.70 → 129.50 | 199.99/216.05/217.58 → 200.00/214.75/216.37 | 77/77 → 77/75 |
| thread-explorer-notes / thread-3000 | 674.00 → 599.00 | 6.37 → 6.64 | 153.70 → 167.30 | 200.09/211.66/216.63 → 200.03/205.92/216.39 | 75/75 → 75/75 |
| thread-explorer-notes / explorer-code | 710.00 → 287.00 | 5.78 → 6.84 | 164.90 → 172.90 | 200.07/202.04/216.47 → 200.05/202.03/217.72 | 75/75 → 80/78 |
| thread-explorer-notes / note-images | 834.00 → 439.00 | 3.92 → 2.92 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| thread-explorer-notes / home-returned | 486.00 → 432.00 | 4.78 → 4.78 | 122.00 → 126.70 | 200.01/202.07/216.76 → 200.01/202.07/216.75 | 75/75 → 76/76 |
| terminal-stream / home-initial | 216.00 → 216.00 | 6.24 → 6.11 | 126.30 → 134.20 | 199.99/201.96/216.87 → 199.98/202.50/216.24 | 77/77 → 77/77 |
| terminal-stream / terminal-scrollback | 262.00 → 260.00 | 4.91 → 4.98 | 183.60 → 188.90 | 200.02/202.75/216.89 → 200.04/201.94/216.85 | 76/76 → 76/76 |
| terminal-stream / streaming | 257.00 → 256.00 | 41.94 → 40.94 | 3035.50 → 3075.80 | 16.67/18.39/24.19 → 16.67/17.75/22.15 | 385/0 → 355/0 |
| terminal-stream / home-returned | 251.00 → 250.00 | 4.45 → 4.72 | 121.30 → 121.50 | 200.02/201.91/216.63 → 200.00/202.18/216.50 | 76/76 → 76/76 |
| pull-request / home-initial | 192.00 → 195.00 | 2.86 → 2.92 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| pull-request / changes-2400 | 237.00 → 239.00 | 2.66 → 2.92 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| pull-request / home-returned | 237.00 → 238.00 | 2.66 → 2.79 | 0.00 → 0.00 | —/—/— → —/—/— | 0/0 → 0/0 |
| webviews / home-initial | 212.00 → 202.00 | 6.25 → 6.18 | 123.20 → 126.00 | 200.00/201.91/217.35 → 199.97/214.62/215.30 | 78/76 → 77/77 |
| webviews / preview-open | 242.00 → 231.00 | 4.98 → 5.11 | 131.00 → 127.30 | 200.02/202.65/216.69 → 200.04/202.69/215.87 | 76/76 → 76/76 |
| webviews / preview-closed | 242.00 → 253.00 | 4.45 → 4.78 | 121.70 → 122.90 | 200.01/215.54/217.40 → 200.01/215.47/217.82 | 75/75 → 75/75 |
| webviews / mermaid-jobs-every-3s | 285.00 → 297.00 | 5.24 → 4.91 | 126.40 → 125.60 | 200.05/215.99/217.92 → 199.98/216.28/217.48 | 76/76 → 76/76 |
| webviews / home-returned | 274.00 → 279.00 | 4.58 → 4.71 | 128.90 → 130.90 | 199.97/214.20/217.96 → 200.04/214.95/217.14 | 78/78 → 77/77 |

The 3,000-turn traversal loads all earlier history and visits logical anchors
every 20 turns; it does not paint every pixel or every image. The image lab
separately traverses 48 large image sources twice. Active documents/hosts retain
their images, so the dormant-cache budgets do not bound all visible content.
WebKit candidate PIDs/resources remain separate in `results.json`; they are new
XPC services during this fixture and can be confounded by external app launches.

| Thread/Explorer/note stage | JS heap MiB before → after | React host-node count before → after |
|---|---:|---:|
| home-initial | 29.75 → 29.71 | 1036 → 1036 |
| thread-3000 | 509.39 → 529.10 | 40787 → 37288 |
| explorer-code | 529.01 → 41.58 | 5231 → 5231 |
| note-images | 536.93 → 29.33 | 142 → 142 |
| home-returned | 36.02 → 32.30 | 1036 → 1036 |

These are single settled samples. Garbage-collection timing differs visibly: the
baseline retains its large JS heap through Explorer/note, whereas the final run
collects it earlier. Do not attribute the entire full-product difference to
native image eviction. Active 3,000-turn data still consumes hundreds of MiB;
React counts are structural observations, not exact native-tree or Fiber bytes.
The returned Home footprint remains well above its initial level despite empty
image caches; this pass does not establish universal return to baseline.

## Startup and scrolling regression suite

| Scenario | Side | p50/p95/p99 ms | >16.7/>33 ms | Submission proxy p95 ms | CPU % | GPU ms / 15 s | MiB |
|---|---|---|---:|---:|---:|---:|---:|
| startup-cold | before | 219.50/219.50/219.50 | 2.00/2.00 | — | — | — | — |
| startup-cold | after | 29.35/542.91/542.91 | 2.00/1.00 | — | — | — | — |
| startup-warm | before | 287.61/287.61/287.61 | 2.00/2.00 | — | — | — | — |
| startup-warm | after | 47.58/363.20/363.20 | 2.00/2.00 | — | — | — | — |
| code-scroll | before | 16.66/18.76/199.20 | 312.00/21.00 | 139.52 | 27.36 | 1670.40 | 278.00 |
| code-scroll | after | 16.66/18.91/199.91 | 331.00/20.00 | 144.51 | 26.30 | 1793.30 | 276.00 |
| pr-changes | before | 16.69/18.61/18.90 | 449.00/0.00 | 9.55 | 39.89 | 2526.70 | 243.00 |
| pr-changes | after | 16.67/18.38/18.68 | 256.00/0.00 | 15.39 | 40.35 | 2788.10 | 242.00 |
| idle-home | before | —/—/— | 0.00/0.00 | — | 3.05 | 0.00 | 233.00 |
| idle-home | after | —/—/— | 0.00/0.00 | — | 2.79 | 0.00 | 235.00 |
| explorer-scroll | before | 16.67/19.82/199.87 | 313.00/21.00 | 144.69 | 35.13 | 1393.50 | 298.00 |
| explorer-scroll | after | 16.67/21.04/200.09 | 324.00/22.00 | 142.14 | 35.14 | 1328.50 | 308.00 |
| thread-scroll | before | 16.67/18.70/20.95 | 296.00/0.00 | 14.97 | 52.99 | 1306.20 | 265.00 |
| thread-scroll | after | 16.65/18.82/20.22 | 412.00/0.00 | 15.81 | 53.27 | 1802.40 | 261.00 |
| markdown-scroll | before | 33.33/35.38/35.91 | 449.00/316.00 | 29.91 | 70.26 | 1283.60 | 333.00 |
| markdown-scroll | after | 33.34/34.87/35.28 | 450.00/372.00 | 25.44 | 69.68 | 1316.80 | 340.00 |

| Startup | Shell ms before → after | First content ms before → after |
|---|---:|---:|
| startup-cold | 1013.84 → 1118.70 | 1190.76 → 1385.52 |
| startup-warm | 650.99 → 662.79 | 974.25 → 1121.16 |

| Scenario | Side | Render p95 ms (includes layout) | Included layout p95 ms | React commits / window |
|---|---|---:|---:|---:|
| code-scroll | before | 11.80 | 1.67 | 75.00 |
| code-scroll | after | 12.10 | 1.72 | 75.00 |
| pr-changes | before | 6.04 | 1.36 | 0.00 |
| pr-changes | after | 6.17 | 1.43 | 0.00 |
| idle-home | before | — | — | 0.00 |
| idle-home | after | — | — | 0.00 |
| explorer-scroll | before | 14.81 | 1.20 | 75.00 |
| explorer-scroll | after | 15.08 | 1.20 | 75.00 |
| thread-scroll | before | 9.37 | 0.87 | 113.00 |
| thread-scroll | after | 9.33 | 0.86 | 114.00 |
| markdown-scroll | before | 22.42 | 4.99 | 75.00 |
| markdown-scroll | after | 21.48 | 4.74 | 75.00 |

Thread and Markdown rows use a follow-up matched RPC-input control, with the
same 120 Hz contact/momentum schedule on both addons. The original Markdown
comparison selected different AppKit/RPC backends and is archived separately
under `*-mixed-input.json`; it is excluded from performance claims.

| Control (RPC input) | Scenario | CPU % | Render p95 ms | Footprint MiB |
|---|---|---:|---:|---:|
| before-matched | thread-scroll | 52.99 | 9.37 | 265.00 |
| before-matched | markdown-scroll | 70.26 | 22.42 | 333.00 |
| after-disabled | thread-scroll | 52.66 | 9.27 | 260.00 |
| after-disabled | markdown-scroll | 70.75 | 21.83 | 332.00 |
| after-matched | thread-scroll | 53.27 | 9.33 | 261.00 |
| after-matched | markdown-scroll | 69.68 | 21.48 | 340.00 |

The follow-up startup control uses three fresh processes per scenario, ordered
final addon with all memory features disabled, final addon enabled, then baseline.
It is a timing control rather than a randomized experiment. Flags and addon
hashes are retained with each control.

| Fresh control | Startup | Shell median ms | First content median ms |
|---|---|---:|---:|
| disabled | startup-cold | 838.06 | 1162.64 |
| disabled | startup-warm | 678.17 | 995.95 |
| enabled | startup-cold | 752.80 | 1101.52 |
| enabled | startup-warm | 655.59 | 968.46 |
| baseline | startup-cold | 754.14 | 1105.91 |
| baseline | startup-warm | 656.46 | 985.39 |

Startup content timings and per-frame CPU render/layout distributions remain in
`results.json`. This 60 Hz display does not demonstrate 120 Hz readiness. The
existing Markdown/layout workload can exceed an 8.3 ms CPU budget; memory
reclamation does not establish smoothness for every screen. The first startup
batch was slower on the final addon; the fresh enabled/disabled/baseline control
did not reproduce that slowdown. Explorer interval p95 increased by 1.22 ms even
though render p95 changed by 0.27 ms and CPU was unchanged. GPU time varied
substantially, including a higher thread-scroll total; no uniform GPU or energy
improvement is claimed. These tails need a combined integration recheck.

## Isolation and remaining footprint

The early exploratory controls use the same host and 15-second resource windows,
but predate per-stage ten-second warmup and addon-hash metadata. They are retained
separately under `diagnosticControls`; final matched runs above are the acceptance
evidence.

The original image lab retained about 288 MiB of decoded pixels plus roughly
288 MiB of image atlas pixels after its first carousel. Closing the image
screen now drops both owners, and editor images are released on screen close.
Shared visible/overscan owners and editor undo/redo references stay protected.
The code case grows Taffy storage to about 48,000 nodes; replacing its retained
slot storage after a large collapse reduced its isolated Home footprint from
439 MiB to 299 MiB in the image-only versus frame-storage control.

The separate code-only allocator probe measured 143 → 405 → 265 MiB. `heap`
reported 37.7 MiB of live malloc allocations; the footprint region histogram
reported 105 MiB as reclaimable Malloc Small pages. Both all-zone and explicit
default-zone `malloc_zone_pressure_relief` calls returned zero and did not lower
the physical footprint. The ineffective production allocator call was removed.
Residual footprint is reported rather than subtracted as if reclaimed.

A stricter editable-note probe loads 24 images in one document. Its final-addon
footprint was 144 → 322 → 307 MiB even though the editor image cache dropped from
24 entries to zero. Heap inspection reported 24 remaining 6 MiB allocations.
An additional experiment cleared detached editor layout storage at a safe frame
boundary. Its counter confirmed execution, but the disabled and enabled round
trips were 144 → 334 → 319 and 144 → 335 → 320 MiB respectively. Allocator relief
again released zero bytes. That native experiment was reverted; its patch and
negative-control measurements are retained separately for review.

The final allocation-diagnosis run used the production addon and native-child
stack logging. Its heap attributed 24 allocations (144.4 MiB including logging
overhead) to `image::animation::Frame::clone` in the native addon. This identifies
the allocation site, not the retaining owner. The exact-size `malloc_history`
filter missed them because logging inflated 6,144 KiB to 6,160 KiB. The helper
now uses the observed size, but that correction was only typechecked. No timing
or resource values from the logging run are used in acceptance comparisons.

Metal counters showed a 2 MiB instance target and approximately 1 MiB of atlas
capacity after image closure in the isolated fixture. No Metal-pool shrinking
was added without evidence of a large retained pool. Image pixel estimates,
last-submission Metal device allocations, JS heap and physical footprint are
distinct measurements; native retained-tree bytes cannot be assigned exactly
from React node counts. No packaged startup or physical presentation-fence
measurement is claimed.

## Shipped changes and validation

Native patches are separate from product JavaScript: `image_memory_gpui.py`,
`image_memory.rs` and `image_memory_hooks.py` add source leases, byte bounds,
asset-task and atlas eviction, and GPU-safe atlas reuse. `rich_editor.rs` tracks
document/undo image owners, bounds dormant images, drains atlas removals and
exposes actual image residency. `frame_memory_gpui.py` shrinks oversized frame
arenas and replaces Taffy storage after a large collapse. `memory_counters_gpui.py`
and the minimal backdrop hook expose opt-in Metal ownership counters.

`src/editor/images.ts` verifies native residency before reusing a resolved load,
shares in-flight work, avoids retaining large data-URL keys, and passes the exact
Buffer byte range. Transcript/windowing/Markdown product code was not changed.
The `perf/memory` fixtures, matched-input benchmark hooks, native UI leases and
process-group cleanup make the measurement and validation runs reproducible.

The production addon SHA-256 is
`91ad37caae54c6cceda948d17607859318a5ffee9a707e69fc888fcf38f14e58`;
the baseline is
`17ecd86ebd97c1fae86839ef31e41ceaf0b73027a31162a18638f155163adabe`.
The successful production `native/update.sh` output is `native-update.log`
(also `native-update-3.log`) in the evidence folder. The rejected experimental
build log is separate and does not validate a different shipped binary.

Checks passed: complete production native update/check suite, eight frame-arena
unit tests, spring/rich-document Rust tests, product/native/tooling TypeScript,
`bun test ./src` (322 tests, 5,813 assertions, 49 files), editor-image unit tests,
and UI-lease child/grandchild cleanup. A pre-existing baseline line-layout cache
panic invalidated one initial Explorer process; its evidence was archived and
three fresh repeats passed. This lane does not claim to fix that crash.

The 16 before/after visual pairs cover both themes, rounded images, a shared
visible peer through 47 evictions, image/editor reopen, failed-load retry and
code closure. All 3,144,192 sampled functional-canvas pixels matched, excluding
window chrome/corners. Actual light editor-reopen and dark shared-peer captures
were also inspected. Evidence is under `before-final-visual/`,
`after-final-visual/` and `visual-diff.json`.

Integration must preserve the Markdown lane's additional document checks when
combining `native/check-update.sh` and `update.sh`; this branch started before
those checks existed. Combined startup, scrolling and GPU tails need a recheck.

## Cleanup

Free space was approximately 85 GiB before task builds.
Immediately before/after cleanup it was
81.79 → 83.91 GiB
on the shared APFS volume; other lanes can change that volume concurrently.
Removed this task's native target (1.8 GiB), generated upstream (185 MiB),
disposable GPUIX/desktop dependencies (188/633 MiB), scratch data (119 MiB),
baseline/intermediate addons and generated unit-test binaries. The validated
25 MiB final addon and 104 KiB runtime bridge remain for integration. Evidence
and benchmark archives remain outside the worktree. No own fixture, sampler,
build, daemon listener or open native build file remained before deletion.
