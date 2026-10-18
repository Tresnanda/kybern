# Sidebar workload

Run from `apps/gpuix` with the exact installed dependencies and patched native
addon. No package or native-addon change is needed. These scripts use only
`/Users/mymac/projects/ade-gpuix-scratch/perf-sidebar`, port 4327 (cold proxy
4328), and reject normal user data. `fixture.ts` seeds 300 threads across 20
projects, including twelve 1,000–2,500-turn conversations, and removes its
scratch daemon/data on exit. It launches no agent turns.

```sh
clang -dynamiclib -fobjc-arc -framework AppKit perf/explorer/wheel.m -o perf/explorer/wheel.dylib
bun perf/sidebar/fixture.ts bun perf/sidebar/verify.ts
bun perf/sidebar/package.ts
bun perf/sidebar/quiet.ts bun perf/sidebar/fixture.ts bun perf/sidebar/final.ts
bun perf/sidebar/quiet.ts bun perf/sidebar/final.ts --cold-fixture
```

`verify.ts` checks both themes against the original and candidate sidebar:
large jumps and return, inline editor ownership, disclosure, nested children,
more threads, marquee/hover/context menus, exact project drag offsets, landing,
Escape and thirty tooltip sweep trials. Each window takes one fair UI lease.
Screenshots are separate from timed runs. Frozen settled visual comparisons in
`final.ts` also cover both themes.

`quiet.ts` joins `/tmp/kybern-gpuix-quiet-order` through Python and waits for
its first line plus the existing quiet-next/build-next reservations before
reserving its next build-free window. It never replaces another lane's marker.
A window lasts at most twenty minutes; the normal UI queue still applies.
`lease.ts` holds each UI batch for at most 295 seconds, removes only its own
queue line and reuses the parent lease in nested checks. Signal handlers stop
owned children; no wrapper may leave a fixture running after exit.

`final.ts` alternates baseline/P1/candidate order in two matched repetitions
for settled, running and mixed (collapsed groups + running children) states.
A separate same-overdraw control isolates mounting from native overdraw.
`baseline` loads Sidebar.tsx and its rows/reorder support from 564151aa with a Bun source plugin. `p1` adds
only `cacheLayout` and the fill island. The candidate also bounds rich bodies,
keeps height-correct native slots and uses 128px native paint overdraw.
The rich body buffer is 768px with a 640px refill threshold. The stable slot
array remains O(total logical rows); only rich bodies and their observers are
bounded. Disclosure groups, finishing children and active row-owned overlays/editors/drag sources
remain mounted through completion.

The native wheel producer is the Explorer AppKit tool: precise packets offered
at 120Hz, with contact and exponential momentum phases, delivered to the real
GPUIView `scrollWheel:` handler. Each active run warms for ten seconds then
samples fifteen seconds / 1,800 offered packets. All numbers use
`KYBERN_FULL_RATE=1`, 1440×900 opaque windows and the same native addon.
No automation clock advances or screenshots occur during measurements.
Baseline input backlog and undelivered packets are reported explicitly.

Native submission intervals are not physical presentation fences.
`offeredToAppKitHandlerEnd` includes the AppKit queue and handler;
`inputToCpuPaint` begins at native dispatch and ends CPU scene construction.
Neither measures input-to-photon. CPU/GPU/physical footprint come from
`perf/sample.ts`, excluding the daemon and WindowServer. Profile runs are
separate and excluded from clean acceptance tables. Idle runs use no input.

Every timed run checks native build markers before, during and after its sample,
and lists GPUIX processes before/after. Other live fixtures invalidate the run.
The initial 05:16–05:32Z data is archived under `excluded-overlap-0516-0532`
and excluded from acceptance claims. Evidence is saved under the original
conversation folder: `/Users/mymac/projects/ade/previews/gpuix/perf/sidebar/`.

`--cold-fixture` gives each packaged variant its own fresh daemon/projection
cache, alternates pair order, and repeats three times (each fixture also records a second warm launch). This is process/cache
cold; it does not purge OS filesystem caches or include daemon startup/migration.
Cold windows are explicitly 1280×820, matching the earlier startup workload.
Both packages contain the same complete app/resources/native addon; only the
sidebar-owned sources differ. The selected newest-content timeline remains measured.
