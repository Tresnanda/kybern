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

The active acceptance suite is the requested four scenarios. Dedicated idle runs
set `KYBERN_BENCH_PERSISTED_IDLE=1`, disable the inter-window counter RPC and use
20s settling followed by three 15s samples. The shared default fixture persists a
running thread; frontend-only `idle` overrides can be restored by refresh. Raw
first-iteration idle results remain archived, including late submissions.

Captures and resource windows require the window to be on-screen and wholly inside a built-in display. `window-guard.swift` uses the CoreGraphics on-screen window list and active built-in display bounds; the capture wrapper retries occlusion without moving or focusing windows. Native automation screenshots have the same pre/post guard. Resource windows guard both endpoints and reject invalid measurements.

The shared bench may repeat discarded windows. Raw discards remain in JSON; the acceptance wrapper requires the complete requested number of successful samples and excludes discarded samples from summaries.

`window-guards.jsonl` retains accepted/rejected CoreGraphics window IDs, on-screen flags and display/window bounds. Two legacy native fixture viewports use 820-point content height (the native title bar adds 32 points) to fit the built-in display.
