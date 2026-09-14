# Further renderer memory work

Follow-up to issue #14 and PR #15, based on main `437e09c` (v0.4.0).
The comparison baseline for this second pass is PR #18 at `887b646`, which
already includes bounded refresh/history retention and inactive-terminal cleanup.
See [the first pass](memory-reductions-2026-09-14.md) for those changes.

## Scope and result

This pass removes redundant Markdown data, unnecessary streaming allocations,
and invisible animated icon subtrees. It preserves formatted output, stable
code/row identity, selection, focus, wrapping, disclosure state, reading position,
and following new output. It does not establish a whole-app memory cap or close
the reported two-hour resting-memory issue.

The focused Markdown fixture has a clear native improvement. The full scrolling
stress workload remains variable and expensive; improvements in Node allocation
or execution time are not presented as equivalent WebKit memory reductions.

## Changes

- Keep only the last source boundary needed for incremental Markdown parsing,
  instead of retaining its complete intermediate mdast tree.
- Remove unused source locations from nested Markdown nodes, preserving every
  top-level and pre/code location needed for incremental boundaries and code
  state. This reduces retained tree metadata without changing rendered output.
- Use a bounded source-keyed highlight cache without concatenated source keys.
  Keep settled results in the renderer so worker release does not invalidate
  warm output. Release Markdown/highlight workers after two idle seconds instead
  of thirty; active jobs are allowed to finish. Clear stale highlighted/parsed content when a different source
  takes the immediate or unsupported-size path.
- Patch the affected running turn when only one work block changes. Preserve
  exposed immutable snapshots and fall back for structural changes.
- Feed dense work rows directly to virtualization, avoiding an extra wrapper
  object for every loaded block on each stream update.
- Keep the virtualizer's index callbacks stable when exact row keys and size
  estimates are unchanged. Append, prepend, reorder, eviction, and changed
  estimates still invalidate measurements. No item payloads are retained by
  this key/estimate snapshot.
- Mount both IconSwap children only during its existing cross-blur transition.
  Unmount the inactive subtree afterward, so completed Thought rows no longer
  retain invisible infinite spinners. Preserve the active icon's paint hints.

## Measurement method

Apple M1, 16 GiB, macOS 27.0 (26A5416b), system WKWebView 22625, 1100 × 720,
production frontend and CSP at `tauri://localhost`. Native runs are serialized,
in fresh fixture processes with synthetic data. The installed app/daemon are
not replaced. Normal background user/development activity continues, so these
are regression measurements without confidence intervals.

`vmmap -summary` supplies physical footprint and lifetime peak; RSS, virtual
mappings and retained-data estimates are not substituted for footprint. No GC
is forced in acceptance runs. The optional settled sample waits 30 seconds
without dropping the current document. Raw VM summaries can be saved with
`KYBERN_PERF_MEMORY_DIR`; `KYBERN_SCROLL_IDLE_MS=30000` enables the idle sample.

## Focused results

Eight Markdown documents, each with 350 sections of formatted prose, links,
inline code and tables; about 0.75 MiB source in total:

| Version | Retained output estimate | Native peak | Current after worker idle |
| --- | ---: | ---: | ---: |
| `887b646` baseline | 55.50 MiB | 319.5 MiB | 99.2 MiB |
| Intermediate-tree removal | 55.50 MiB | 259.4 MiB | 105.8 MiB |
| Plus unused nested-position removal | 31.28 MiB | 251.1 MiB | 75.0 MiB |
| Same candidate, repeat with 36 MiB data guard | 31.28 MiB | 245.7 MiB | 91.2 MiB |

The second row reduces peak by about 19% with the same retained output.
The intermediate-tree change alone does not improve the idle sample. The final
metadata cleanup reduces retained-data estimate by 43.6%. Across two candidate
runs, native peak is 245.7–251.1 MiB versus 319.5 MiB at baseline; settled
footprint is 75.0–91.2 MiB versus 99.2 MiB. The idle variation is material.
The retained-data guard is now 36 MiB; the measured old 55.50 MiB result fails it.

The durable virtualizer differential includes immutable array copies, exact
key/estimate comparison, `setOptions`, and `getVirtualItems`. On Node 24.15.0,
React Virtual 3.14.10 / Virtual Core 3.17.8, 1,600 rows × 4,000 updates × five
alternating rounds, the local run measured medians of 125.6 ms before and
47.5 ms after (2.64×). Other repeats were about 2–2.5×. An earlier ad-hoc
3–5× observation is superseded by this complete benchmark. Core key reads fall
from 6.4 million to zero; the explicit topology comparison still reads all
6.4 million keys and estimates. This is CPU-work evidence, not native RAM.

Run the separate transcript grouping allocation workload with
`node --expose-gc scripts/profile-transcript-churn.mjs`. Its explicit collections
are diagnostic Node measurements only and are never used for native acceptance.

## Remaining native cost

The unchanged eight-scenario scrolling workload exercises 160 historical turns,
800 tools mixed with reasoning, active streaming, expanded thinking/tools and
5,000 lines of code. It samples 200 frame steps per scenario (1,600 total).

| Candidate | History lifetime peak | Full lifetime peak |
| --- | ---: | ---: |
| Second-pass baseline | 422.7 MiB | approximately 1.0 GiB |
| Grouping change | 405.9 MiB | 995.2 MiB |
| Markdown retention changes | 419.6 MiB | 907.1 MiB |
| Renderer caches, 30 s worker control | 406.5 MiB | 809.3 MiB |
| Same source, 2 s worker diagnostic | 387.0 MiB | 767.2 MiB |
| Inactive icon unmount, 30 s workers | 415.2 MiB | 802.6 MiB |
| Stable virtualizer callbacks | 423.8 MiB | 943.5 MiB |
| Plus metadata pruning, 2 s workers | 408.6 MiB | 759.8 MiB |
| Same final source, 30 s control | 401.6 MiB | 795.1 MiB |

These results do not establish a reliable reduction below 400/800 MiB for the
full workload. They retain all content/anchor checks, with per-scenario frame
p95 generally 18–19 ms. A separate dense-streaming-only control fell from
464.1 MiB immediately after scrolling to 154.4 MiB after 30 seconds while the
same dense view stayed mounted; this is not a reproduction of the issue's
uncontrolled two-hour session.

## Attribution and rejected experiments

A separate Web Inspector diagnostic found 24.29 MiB of live JavaScript heap
objects across the page and both workers. Heap snapshots force collection and
therefore are not footprint benchmarks. A separate observational Memory capture
at mixed streaming reported approximately 155.92 MiB JavaScript heap/owned data,
15.55 MiB JIT and 267.96 MiB Page allocator data. The Page bucket is bmalloc plus
libc allocations, not a DOM-only measurement. [WebKit memory inspection](https://docs.webkit.org/Infrastructure/MemoryInspection.html),
[InspectorMemoryAgent](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/inspector/agents/InspectorMemoryAgent.cpp).

Direct LayerTree accounting was about 41.4 MiB at that checkpoint. The Memory
API reported zero Layers on this runtime despite nonzero LayerTree backing,
so that zero is not evidence of free graphics. Snapshot-excluded owned data,
dead objects, allocator capacity/fragmentation and native WebCore data remain
plausible contributors; the current evidence does not assign every byte.

Paint-host pooling, lower overscan, additional containment, content-visibility
and removal of settled transforms did not produce a reliable win; some caused
blank frames, large anchor jumps or ResizeObserver errors. Removing active icon
filter/transform/promotion hints raised history peak to about 1.8 GiB and was
rejected. Only inactive icon lifecycle cleanup is retained. An alternative
Oniguruma/WASM highlighter used more memory in the isolated Node diagnostic;
no engine or production CSP change is included.

## Reproduction and verification

From `apps/desktop`:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node --experimental-strip-types scripts/profile-virtual-topology.mjs
node scripts/check-rendering-memory.mjs
node scripts/check-rendering.mjs markdown-memory
node scripts/check-rendering.mjs icon-swap
node scripts/check-rendering.mjs worker-lifecycle
node scripts/check-rendering.mjs
node scripts/check-rendering.mjs interaction
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs interaction
node scripts/check-rendering.mjs work-stream
node scripts/check-rendering.mjs scaling
node scripts/check-rendering.mjs history-retention
```

The icon fixture checks real intermediate cross-blur, keyed rapid reversal,
active/inactive animation lifecycle, 14px/16px slot geometry, copy/check swaps,
reduced motion and preserved active paint hints. Both interaction widths pass
selection/focus, wrapping, navigation, prepend anchoring and follow gestures.
Shared transcript changes pass mobile's 108 tests, typecheck and Android/iOS
exports. Desktop tests (187), typecheck, lint and production build pass.

The worker-lifecycle fixture passes with the shipped two-second default: two
workers are constructed, both terminate after idle plus a 500 ms grace window,
and cache-only revisits create none. New Markdown/highlight inputs create two
new workers, preserve full revisions and exact formatted output, then release
both. Cancellation before queueing and while queued also passes. This verifies
resource lifecycle rather than inferring worker destruction from a memory dip.
The Markdown-data, icon and worker lifecycle checks are included in macOS CI.
