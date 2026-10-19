# Backdrop filter experiment

`RESEARCH.md` identifies native compositor materials vs scene filters. The narrow
kernel candidate is enabled in this isolated worktree; `KYBERN_BACKDROP_KERNEL=0` is the
same-addon legacy control. Large device sigma (>8) keeps all 49 original samples with precomputed weights.
No cadence/material/animation timing changes. No backdrop-pixel cache is added.

Run from `apps/gpuix`:

```
python3 perf/backdrop/build.py
bun perf/backdrop/quiet.ts bun perf/backdrop/final.ts
bun perf/backdrop/quiet.ts bun perf/backdrop/final.ts details
pnpm exec tsc -p perf/backdrop/tsconfig.json
```

The updater wrapper reserves the next native slot and owns its build marker for
its entire compile/package/check run. Its checks retain the shared bounded UI
leases. The quiet wrapper honors the shared ordered queue and build reservations,
checks `screen-state.swift` and holds only scoped `caffeinate -d -w` assertions.
Never use a locked/asleep or zero-submission active window. Scratch paths are
`perf-backdrop*`, benchmark daemon port4337. Evidence is external under
`/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/`.

Acceptance uses the shared realistic fixture (300 threads,20 projects,3000-turn
history,12405-file tree), 10s warmup and three15s samples per scenario. Native
submission interval percentiles and AGX per-PID GPU work are distinct from a
physical present fence or energy. Diagnostic trace logging runs separately.

`kernel-check.ts` compares unchanged and shifted high-frequency source in both
themes across four window/accessibility modes. It exercises the raw native
filter even under accessibility overrides, deliberately testing the shader;
product material gates require the existing live-material check separately.
Wide sigmas and fractional bounds/radii/masks remain in the lab as controls.

Desktop references are headless WebKit only. Product captures pass `--gpuix-only`
and may rescore against existing desktop images. Prior headed compositor evidence
is retained from before the monitor restriction; future runs use headless pages
and cannot establish compositor pixels. Every native window stays on the built-in
primary display; never activate/focus a window.
