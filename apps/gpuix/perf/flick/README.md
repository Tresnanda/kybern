# Fast-fling scheduling

`RESEARCH.md` records the revisioned Zed/Zeron source findings. `RESULTS.md`
records the final measurements, validation and limits. Evidence stays under
`/Users/mymac/projects/ade/previews/gpuix/perf/flick/`.

The fix selects the ordinary native frame scheduler instead of the addon's
test-support eager dirty-window loop. The same-addon control is
`KYBERN_INPUT_FRAME_DRAW=0`. This preserves sparse row ownership, height hints,
anchors, formatting and native wheel accumulation. It adds no cache or timer.

From `apps/gpuix`:

```sh
# Fair build reservation; marker covers update.sh and every native check.
# Uses one own target, four low-priority build jobs and scratch data.
python3 perf/flick/build.py

# Waits for the lane's queued quiet turn and an unlocked, awake screen.
# Two same-addon variants, three windows each, all history loaded for fling.
FLICK_DEFAULT_PAIR=1 FLICK_PAIR_LABEL=continuous-final bun perf/flick/quiet.ts bun perf/flick/pair.ts

# Native timing and every slow-interval correlation remain separate from pixels.
python3 perf/flick/attribute.py perf/bench/results/continuous-final-0.json /Users/mymac/projects/ade/previews/gpuix/perf/flick/attribution-final-before
python3 perf/flick/attribute.py perf/bench/results/continuous-final-default.json /Users/mymac/projects/ade/previews/gpuix/perf/flick/attribution-final-after
python3 perf/flick/summarize.py continuous-final default

# Existing rail, copy, row-owner, list-anchor and drag assertions, plus pixels.
# Each app batch has a bounded UI lease and scoped caffeinate assertion.
python3 perf/flick/verify.py

pnpm typecheck
pnpm exec tsc -p native/tsconfig.json
pnpm exec tsc -p perf/bench/tsconfig.json
pnpm exec tsc -p perf/flick/tsconfig.json
bun test ./src
bun test perf/bench/model.test.ts
```

`build.py` temporarily routes existing native checks' output and screen gates,
then restores those scripts even after failure. Native patches still come only
from the checked-in patch reconstruction. It replaces the signed addon inode
through the updater and retains the prior addon until cleanup. Remove this
lane's disposable target/dependencies/scratch data after preserving the evidence.

`reuse.ts` changes only the existing scroll2 verifiers' scratch/output paths.
`sidebar-suite.ts` retains one synthetic 300-thread dataset across paired images.
`task-checks.py` uses the existing task/project drag verifier against port 4339.
`bench-visual.ts` checks the expanded tree and long formatted/source previews.
The visual scripts never supply timing evidence.

`code-pair.ts` is an interleaved control for the first code-preview GPU anomaly.
`profiles.py` summarizes independent `sample` diagnostics, whose cadence is
excluded from acceptance. `attribute.py` asserts its >16.7/>33 counts agree
with the exact measured submissions. Its categories describe observed work;
stripped JS symbols and uninstrumented GC cannot be assigned a cause by fiat.

Final pacing uses schema 2: five seconds of real AppKit input bridge every
resource window's controller metadata/process checks, outside the measured
15 seconds. Pipe callbacks drain before both marks. The native boundary interval
is still counted, so an actual first-frame stall cannot disappear. The earlier
`hidden-final` attempt stopped wheel production between windows; blocked pipe
callbacks then admitted buffered 5 Hz idle scenes as scroll intervals. Its raw
artifacts remain diagnostic evidence and are excluded from acceptance.

Correctness batches hold the exclusive UI lease and check screen/process gates.
They record native build overlap as context, with `timingEvidence: false`; their
images/assertions supply no cadence or resource claims. This lets deterministic
pixel/interaction checks share the fair UI queue with other updaters without
waiting for every CPU build. Final A/B samples still reject every build overlap.
`FLICK_VERIFY_CASES` selects comma-separated cases to resume a completed suite.
`quiet-check.py` runs the actual quiet wrapper against isolated coordinator
files and verifies SIGTERM/SIGINT stop its child and grandchild before release.
