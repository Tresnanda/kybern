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
FLICK_DEFAULT_PAIR=1 FLICK_PAIR_LABEL=final-frame bun perf/flick/quiet.ts bun perf/flick/pair.ts

# Native timing and every slow-interval correlation remain separate from pixels.
python3 perf/flick/attribute.py perf/bench/results/final-frame-0.json /Users/mymac/projects/ade/previews/gpuix/perf/flick/attribution-final-before
python3 perf/flick/attribute.py perf/bench/results/final-frame-default.json /Users/mymac/projects/ade/previews/gpuix/perf/flick/attribution-final-after
python3 perf/flick/summarize.py final-frame default

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
