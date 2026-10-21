# GPUIX memory: the autorelease leak and memory kept after use (ramfix, 2026-10-21)

The installed 0.10.1 app had a 339 MiB physical footprint (peak 410 MiB) after 13.75 h. Two problems: an
unbounded leak, and memory kept after content closed.

## The leak

`heap` on the installed app counted 172k `NSMutableArray`s — each a copy of `[GPUIWindow, TUINSWindow]` — 59k `CFString`s and 877 `@autoreleasepool content` pages, all growing linearly. Bun's
main thread has no autorelease pool, so every object AppKit autoreleased for a call made outside `pump_events` lived
forever:

| Source | Rate | Fix |
|---|---|---|
| `native/visibility.ts`: `[NSApp windows]` every 400 ms while a loop/state listener exists | 2.5 arrays/s | read on AppKit window-state events only, inside `withPool` |
| `shell/window.ts` `readPlatformState`: `[NSApp windows]` + `stringWithSavedFrame` every 900 ms | 1.1 arrays/s + 1.1 strings/s | same |
| napi calls during React commits outside `pump_events` (CoreText variable-font instances: `SFNS.ttf#postscript-name=…;var:Weight=650`) | per new font instance | per-tick pool in `tick()` (native) |

3.6 arrays/s × 49,500 s = 178k, matching the installed app; 1.1 strings/s × 49,500 s = 54k of the 59k strings. The
font-path strings are the remainder: CoreText creates them for a new variable-font instance (weight/optical size)
during text layout, which runs in napi calls outside the pump. The scratch probe (`font-strings.ts`) did not reproduce
their growth (+17 strings with `KYBERN_TICK_POOL=0`, +59 with the pool, both within what caches legitimately keep), so
the attribution rests on the live sample's contents and the code path, not a stack trace (Bun refuses debugger
attach; `heap` does not print string contents).

Idle growth on a scratch window (Home, no running row, `idle-leak.ts`):

| | NSMutableArray / min | CFString / min | pool pages / min | footprint |
|---|---:|---:|---:|---|
| before (10 min) | +65.4 | +64.8 | +0.6 | 213 → 220 MiB |
| after (12 min) | 0 | −0.5 | 0 | 207 → 212 MiB |

Neither poll runs any more (the addon reports occlusion, key, move, screen, appearance and accessibility-display
changes); an addon without the callback falls back to the polls, now inside pools.

Visibility, pause and resume (`visibility-check.ts`: minimize and restore twice on the hidden test display, compaction
on, loops in the scene with `KYBERN_COMPOSITOR_LOOPS=0` so they show as app frames):

| | hidden after minimize | visible after restore | frames / 2 s visible, minimized, restored | background release |
|---|---:|---:|---|---|
| before (400 ms poll) | 636 / 610 ms | 611 / 536 ms | 120, 0, 120 | — |
| after (AppKit events) | 654 / 637 ms | 542 / 540 ms | 120, 0, 120 | 60.1 s after launch |

AppKit reports occlusion after the minimize/restore animation, so both settle at about 0.55–0.65 s; hidden-window
compaction follows 400 ms later as before.

## Memory kept after use

Workload (`retained.ts`, one scratch window on the hidden test display, `GPUIX_BACKGROUND=1`): Home → 3,000-turn
thread with all history visited every 25 turns → 1,000-turn thread whose newest 48 turns carry distinct 1536×1024
images → Explorer Markdown and a 12,000-line TypeScript file (closed) → a note with 24 distinct 1536×1024 images →
Home. Samples at Home before, 5 s after the workload, after the release (where a real window would go to the
background) and after two idle minutes; then reopen times (request to painted bounds / decoded image count, not
presentation). Final runs were in quiet windows (no native builds), interleaved, three each; external load average
3–7 (simulators), and reopen times swing ±30% with it.

| Runs (median of 3) | Home | After workload | After release | After 2 min idle | Peak | Reopen thread / code / note ms |
|---|---:|---:|---:|---:|---:|---|
| before (original source, addon 75c1ec2a) | 216 | 333 | — | 319 | 602 | 113 / 799 / 328 |
| after (default: native release) | 215 | 410 | 408 | 317 | 602 | 114 / 795 / 330 |

| After 2 min idle, MiB | JS heap (App-Specific Tag 1) | IOAccelerator (driver) | IOAccelerator (graphics) | Untagged | Malloc Small | JIT code |
|---|---:|---:|---:|---:|---:|---:|
| Home before the workload | 113 | 8.4 | 7 | 12 | 13 | 2.1 |
| before | 168 | 34 | 11 | 18 | 22 | 5.8 |
| after | 167 | 35 | 9 | 19 | 22 | 5.7 |

What was tried, and what stays:

- **Native release** (`releaseIdleMemory`, 0.4–0.5 ms): drops the 21 MiB path target, cached instance buffers (4 MiB),
  backdrop scratch and the passive region target. GPUIX never paints GPUI paths, so the path target is allocated but
  not resident; the measurable effect is graphics 11 → 7–9 MiB. Reopen times are unchanged. This is the default.
- **`Bun.shrink`** (`KYBERN_IDLE_SHRINK=1`): returns the most — 351 → 290 MiB right after the release, 277 vs 322 MiB
  after two minutes (quiet window, two runs each) — but discards compiled JS (5.7 → 1.6 MiB), and the next opens were
  slower: long thread 197 vs 145 ms, code file 1150 vs 967 ms. Opt-in.
- **Full GC only** (`KYBERN_IDLE_GC=1`): 356 → 327 MiB after release, 305 after two minutes, but a full GC also ages out
  compiled code (5.8 → 4.9 MiB) and reopen was slower again (207 / 1498 ms, under load 7–16). Opt-in.
- **Recreating the Metal command queue** (`KYBERN_IDLE_QUEUE=1`): no effect on the driver memory (35 → 33 MiB with,
  37 → 34 MiB without). Opt-in for experiments only.
- **mimalloc options**: Bun's mimalloc 3.5.0 already purges free pages after 100 ms (`MIMALLOC_PURGE_DELAY`); what
  remains is fragmentation in partly used pages and JSC's own blocks. JSC returns a comparable amount by itself within
  two idle minutes (no-release control: 131 MiB JS heap after idle).

Remaining, not released:

- **Driver memory (`IOAccelerator`, +25 MiB)**: private AGX driver heap, not Metal resources this app allocates
  (`device.currentAllocatedSize` grows only with the atlas). It grows with rendering variety — opening the 3,000-turn
  thread +13, visiting it +10, Markdown +6, code +5 — and is unchanged by `KYBERN_COMPOSITOR_LOOPS=0` or a new queue.
  The 2026-10-18 full-product memory runs (`previews/gpuix/perf/memory/after-final-app`, source be7230c0) show 64 KiB
  here across the same kinds of workload, so a native change since then raised it; bisecting the native patches
  between be7230c0 and this branch is the next step.
- **JS heap fragmentation (+55 MiB over Home)**: only `Bun.shrink` returns it, at the reopen cost above.
- **Untagged (+6) and Malloc Small (+9)**: live large Rust allocations and freed small-zone pages; the round-5
  allocator work (`perf/memory/HR5-RESEARCH.md`) found `malloc_zone_pressure_relief` releases nothing here.

## Running

```sh
export KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/motion-ramfix KYBERN_BENCH_PORT=4386
export KYBERN_CLIENT_CONFIG_DIR=$KYBERN_DATA_DIR/client KYBERN_GPUIX_RESOURCES= KYBERND= KYBERN_URL= KYBERN_TOKEN=
bun perf/ramfix/idle-leak.ts after 12            # heap class counts while idle
KYBERN_RAMFIX_RELEASE=1 bun perf/ramfix/retained.ts after   # workload, release, idle, reopen
KYBERN_RAMFIX_ADDON=/path/to/old.node bun perf/ramfix/retained.ts before
bun perf/ramfix/visibility-check.ts               # minimize/restore: events, compaction, release, frames
bun perf/ramfix/font-strings.ts                   # CFString growth with KYBERN_TICK_POOL=0
python3 perf/ramfix/summarize.py before-1,before-2 after-1,after-2
```

Evidence: `/Users/mymac/projects/ade/previews/motion/ramfix/` (`idle-*`, `retained-*` with footprint and vmmap per
sample, `visibility-check`, `font-strings`). The addon with these patches is sha256 891a0170.
