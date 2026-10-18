# Long transcript measurements

The standalone fixture loads all 1,000 or 3,000 synthetic turns at once. It includes Markdown tables, quotes, two code languages, long collapsed fences, tool calls, user and response images, plus an optional live formatted tail. It does not contact a daemon or inherit the production data directory.

Run from `apps/gpuix` after installing the pinned dependencies and staging the patched native addon:

```sh
python3 perf/transcript/lease.py bun perf/transcript/slot-pair.ts 1000
python3 perf/transcript/lease.py bun perf/transcript/slot-pair.ts 3000
python3 perf/transcript/lease.py bun perf/transcript/slot-pair.ts 1000 stream
python3 perf/transcript/lease.py bun perf/transcript/remaining-checks.ts
python3 perf/transcript/lease.py bun perf/transcript/checks.ts
# After checks pass, in your reserved build-free quiet window:
python3 perf/transcript/lease.py bun perf/transcript/final-pair.ts 1000
python3 perf/transcript/lease.py bun perf/transcript/final-pair.ts 3000
python3 perf/transcript/lease.py bun perf/transcript/final-pair.ts stream
# Or take/release your turn in the shared quiet-order file automatically:
python3 perf/transcript/final-run.py
python3 perf/transcript/summarize.py
# Short ordered rerun of a rejected 3,000-turn pair, preserving old evidence:
python3 perf/transcript/retry-run.py
```

`slot-pair.ts` compiles the shared bench package's process-local AppKit event injector, then compares the baseline source, body window, reused slot elements, and coalesced wheel path. `p1-pair.ts` preserves the earlier native RPC experiment. The RPC driver caps outstanding requests; compare its offered counts before interpreting throughput. The AppKit driver supplies contact/momentum fields directly to this fixture's own window. Both paths report the admitted input and hash their driver.

`final-pair.ts` replays the same 1,800 indexed contact/momentum packets for both sources; backpressure can extend delivery, and dispatch/paint telemetry reports it. Earlier exploratory AppKit cases phase input by wall time instead. Treat those as separate experiments. The six final cases, split into three leases, cover settled 1,000/3,000 turns (including before/after idle) plus a live 1,000-turn tail.

Each timing process uses `KYBERN_FULL_RATE=1`, ten seconds of warm-up, fifteen seconds per active/resource sample, and ten seconds of settling before the idle sample. Native submission intervals and dispatch-to-CPU-paint telemetry are not physical display presentation or input-to-photon measurements. There are no screenshots or synthetic clock advances in timing samples.

The lease wrapper uses the shared FIFO UI queue, limits each batch to 290 seconds, and rejects native-build overlap. Keep a build-free quiet reservation for final measurements according to the common perf brief. Separate capture checks use a paused clock to compare pixels in both themes and motion preferences.

Active runs reject a capture with neither native render work nor submissions.
The native wheel readiness probe after warm-up verifies that the logical anchor
moves, then normalizes both sources to the tail before sampling. Raw results
include those anchors; `TRANSCRIPT_PREFLIGHT=0` is a historical control.
`diagnose.ts` is a separate untimed 3,000-turn AppKit/RPC anchor and screenshot
probe with coalescing on/off. Do not mix its screenshots into timing samples.

Evidence is written to `/Users/mymac/projects/ade/previews/gpuix/perf/transcript/`; scratch controls and the small event injector go under `/Users/mymac/projects/ade-gpuix-scratch/perf-transcript/`. `TRANSCRIPT_BASE_REF` defaults to `9befd131`. The bench injector/input files resolve from the integrated `perf/bench` directory, with the sibling perf-bench worktree as a temporary fallback.

The window keeps stable, measured native row slots while rich bodies and bounds observers are disposable. Selection, focus, running/fresh content, active transitions, and row-owned overlays retain their owners. The lightweight slots and React fibers remain proportional to loaded history; this is not a fully sparse native list.

Native post-paint list observers include changed logical scroll anchors. This keeps programmatic jumps live when no previous rich body is still visible, without a timer or idle frame. Row geometry caches use each row revision rather than the entire list revision.

The default transcript uses fresh prepaint/bounds with row geometry reuse.
`KYBERN_SCROLL_ISLANDS=1` remains an experimental control here: the large-jump
and image-overlay check exposes stale endpoint bounds that hide the rail.
Final timings use the correct default with transcript islands disabled.
`p1-visual.ts` compares baseline source with the final source in both themes and
motion preferences, requiring exact content pixels and reporting the old
source's stale rail highlight separately. A second, windowed cache-off control
requires exact pixels including the rail. Screenshots use no timing samples.

Visited interactive HTML cards retain their owners to preserve arbitrary WebKit document state; they are an explicit exception to the rich-body bound. A transcript-owned disclosure map survives disposal of more than 2,000 row bodies.
