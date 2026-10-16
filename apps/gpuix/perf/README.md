# GPUIX vs Tauri resource use (2026-10-14)

Historical baseline. Current frame scheduling, passive loop changes, opt-in
region/text rendering and acceptance gaps are documented in
[round-seven pacing](pacing-round7-2026-10-17.md). The smooth loop integration is
opt-in pending its resource gate; the old 5 Hz clock's low resource cost is not an
acceptable smooth-motion target.

`bun perf/sample.ts 30 Tauri=<pids> GPUIX=<pid>` samples both apps over the
same 30 s: physical footprint (`footprint`), CPU time (`ps`), and Metal GPU
time per process (`accumulatedGPUTime` from `ioreg`, no sudo).

Workload: the same running Claude thread (a live agent turn, the sidebar
running glyph and the transcript's "Working" loader both animating). M-series
Mac, macOS 27, kybern.app 0.9.1 (one window, 12 h uptime, in front) and the
GPUIX app (`@gpuix/native` 0.10.0, fresh, opened behind it with
`GPUIX_BACKGROUND=1`).

| | Tauri (main + WebContent + GPU + Networking) | GPUIX (one `bun` process) |
|---|---|---|
| Memory | 750 MiB (WebContent 633) | 176 MiB |
| CPU | 32.0% | 17.3% |
| GPU time | 784 ms / 30 s (2.6%) | 146 ms / 30 s (0.5%) |

GPUIX with nothing animating: 149 MiB, 2.5% CPU, 0 GPU.

## What drives GPUIX CPU

GPUI is immediate mode: any change rebuilds and lays out (Taffy) every built
element in the window. `sample` shows Taffy's flexbox pass dominating. A
continuous loader therefore costs a whole-window layout per step, unlike
WebKit, which animates CSS loops in the compositor.

| Change | CPU with a loader running |
|---|---|
| Sidebar as a plain scroll container, two independent JS loaders | 28% (home) / 36% (thread) |
| Sidebar on `<virtual-list>`, panel unmounted when collapsed | 11% (home) |
| + one shared 200 ms loader clock (`MatrixLoader.tsx`) | 17% (thread) |

## Limits

- The Tauri app had run for 12 h with this long thread loaded; a fresh
  desktop window measured ~270 MiB of WebContent in earlier work. GPUIX loads
  the newest 120 transcript entries only.
- The GPUIX window sat behind the Tauri window; occlusion can reduce its
  presented frames, so its GPU figure is a lower bound.
- `kybernd` is shared and excluded from both.
- One 30 s run per row; treat differences under ~3 points as noise.

## Animation cost (2026-10-14, later)

Measured with `KYBERN_LOADER_TICK_MS` and `bun perf/sample.ts` (CPU over 15 s).

| Setup | CPU |
|---|---|
| Empty window, loader ticking 10×/s (`scripts/frame-baseline.tsx`) | 4.6% |
| Empty window, loader ticking 60×/s | 16.9% |
| Full app, loader 10×/s | 20.7% (without sidebar 13.1%, without main 14.1%) |
| Full app, loader 5×/s (default) | 12.7% |
| Full app, minimized (loops paused by `native/visibility.ts`) | 2.5% |
| Full app, nothing animating | 2.3% |

- Every tick has a fixed cost (React commit, GPUIX batch, GPUI frame, about
  3–5 ms of CPU) plus layout that grows with what is on screen. GPUIX has no
  subtree caching: each frame rebuilds every element (400 bare divs ≈ 5 ms).
- GPUI's debug "frame time" includes waiting (see upstream #91: frames wait for
  an 8 ms JS tick instead of vsync), so judge cost by CPU, not by that stat.
- Mounted-but-closed overlays cost nothing (they render `null`); colour string
  parsing per frame is real but minor (hex vs rgba made no difference).
- Rules that follow: transitions are short native `motion.div` bursts
  (`src/motion/kit.tsx`); loops step on MatrixLoader's shared clock, which stops
  when no loader is mounted, under Reduce Motion, and while every window is
  covered, minimized or on another Space.
- The real fix for smooth continuous loops at low CPU is subtree caching in
  GPUIX (rebuild only the animated subtree), scoped at 6–10 days with a small
  fix in its Zed fork.
