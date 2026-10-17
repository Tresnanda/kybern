import{readFileSync,existsSync,writeFileSync}from'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
const read=(file:string)=>existsSync(`${out}/${file}.json`)?JSON.parse(readFileSync(`${out}/${file}.json`,'utf8')):null
const n=(v:unknown)=>typeof v==='number'?v.toFixed(2):'—'
let text=`# PR scroll geometry — round 8

Status: partial. Native input and layout fixes are implemented; strict 16.7 ms p95 and physical-trackpad acceptance require the final evidence below.

## Workload and methods

Apple M1, macOS 27, Bun 1.4.0, GPUIX 0.10.0. KYBERN_FULL_RATE=1, KYBERN_FRAME_COSTS=1, KYBERN_FRAME_TIMES=1. The same rebuilt addon is compared with KYBERN_SCROLL_LAYOUT=0 + KYBERN_SCROLL_COALESCE=0 (before) and layout=1 + coalesce=pr + KYBERN_SCROLL_ISLANDS=1 (after), with islands=0 before, while KYBERN_INPUT_FRAME_DRAW=0. Native values are submission intervals and CPU render/layout work, not physical presentation fences. No screenshots or manual clocks are used in timing runs.

Each scene warms for 10 s and receives 1,800 precise pixel RPC wheel packets scheduled at 120 Hz over 15 s. The profile alternates direction every 2.5 s, with a 1 s contact ramp followed by 1.5 s exponential synthetic momentum. Production is pipelined so frame work cannot silently throttle the offered rate; results retain actual offered duration, acknowledgement times, maximum outstanding requests and drain time. The patched automation API sends native Started/Moved/Ended markers for each contact/momentum segment. GPUI exposes no separate momentum flag. Browser input cannot set these phases. This approximates packet rate and delta decay, not a physical trackpad or OS event coalescing.

Fixture: 30 PRs, a 40-section formatted Summary, 30 files containing 2,400-line patches (bounded expansion), and 30 review entries. Process samples use perf/sample.ts for 15 s after warm-up. CPU is one-core percentage; GPU is AGX process GPU-time, not utilization or energy. Daemon and WindowServer are excluded; differences below about three CPU points are noise.

The reference is the actual desktop frontend in Playwright WebKit 2336, not a native Tauri host. It receives the same 120 Hz packet schedule through page.mouse.wheel. Native RPC acknowledgements and browser rAF timings are different stages. Native dispatch→CPU-paint probes start after entry into GPUI and end after scene construction; they exclude transport/OS queue time and GPU presentation. RPC acknowledgement includes transport queue time but precedes the deferred paint. Both are reported, along with outstanding depth and time from the last offered packet to the final CPU paint. Offered→CPU-paint receipt matches native batch packet counts to the FIFO producer only when all 1,800 timed packets are accounted for; a warm-up overlap or clamped/no-paint packet invalidates that estimate and produces a dash. Pipe delivery adds a small observation delay. The unrelated-next-submission probe remains in raw data for diagnosis and must not be called input latency. Native interval/cost statistics include any drain period; resources cover the first 15 s after warm-up. The native accumulator retains exactly one pending slot, with packet count as telemetry rather than a queue of events.

## Frame intervals

| Mode | Scene | Before p50/p95 ms | After p50/p95 ms | WebKit p50/p95 ms |
|---|---|---|---|---|
`
for(const theme of ['dark','light'])for(const reduce of ['0','1']){
 const before=read(`before-${theme}-${reduce}`),after=read(`after-${theme}-${reduce}`),ref=read(`desktop-webkit-120hz-${theme}-${reduce}`)
 for(const scene of ['list','summary','changes','timeline']){
  const b=before?.results.find((r:any)=>r.scene===scene),a=after?.results.find((r:any)=>r.scene===scene),w=ref?.results.find((r:any)=>r.scene===scene)
  text+=`| ${theme}/${reduce==='1'?'reduced':'normal'} | ${scene} | ${n(b?.p50)}/${n(b?.p95)} | ${n(a?.p50)}/${n(a?.p95)} | ${n(w?.p50)}/${n(w?.p95)} |\n`
 }
}
text+=`
## Input backlog and latency

| Mode | Scene | Variant | RPC outstanding max | RPC ack p50/p95 ms | ACK drain ms | CPU paint drain ms | Native dispatch→paint p50/p95 ms | Offered→CPU-paint receipt p50/p95 ms (matched packets) | Merged packets max |
|---|---|---|---:|---|---:|---:|---|---|---:|
`
for(const theme of ['dark','light'])for(const reduce of ['0','1'])for(const label of ['before','after']){
 for(const r of read(`${label}-${theme}-${reduce}`)?.results??[]){
 const sorted=[...r.packets].sort((a:number,b:number)=>a-b)
 text+=`| ${theme}/${reduce==='1'?'reduced':'normal'} | ${r.scene} | ${label} | ${r.maxOutstanding} | ${n(sorted[Math.floor(sorted.length*.5)])}/${n(sorted[Math.floor(sorted.length*.95)])} | ${n(r.drainMs)} | ${n(r.nativePaintDrainMs)} | ${n(r.nativeFirstPacketToCpuPaintP50)}/${n(r.nativeFirstPacketToCpuPaintP95)} | ${n(r.offeredPacketToCpuPaintReceiptP50)}/${n(r.offeredPacketToCpuPaintReceiptP95)} (${r.matchedCpuPaintPackets??0}) | ${r.nativeBatchPacketsMax??'—'} |\n`
 }
}
text+=`
## Native work and resources

Uncached calls are layout API calls minus geometry-reuse hits; they are an upper bound on flex-solver calls because GPUI can also reuse an already-computed root within the same frame.

| Mode | Scene | Cache | Render p50/p95 ms | Layout p50/p95 ms | Layout API / uncached calls p50 | Reused roots/nodes p50 | CPU % | GPU ms/15 s | MiB | Offered Hz | Drain ms |
|---|---|---|---|---|---:|---|---:|---:|---:|---:|---:|
`
for(const theme of ['dark','light'])for(const reduce of ['0','1'])for(const label of ['before','after']){
 const result=read(`${label}-${theme}-${reduce}`)
 for(const r of result?.results??[]){const resource=r.resourceText?.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
 text+=`| ${theme}/${reduce==='1'?'reduced':'normal'} | ${r.scene} | ${label} | ${n(r.renderMsP50)}/${n(r.renderMsP95)} | ${n(r.layoutMsP50)}/${n(r.layoutMsP95)} | ${r.layoutCallsP50}/${r.solverCallsP50} | ${r.cacheHitsP50}/${r.reusedNodesP50} | ${resource?.[2]??'—'} | ${resource?.[3]??'—'} | ${resource?.[1]??'—'} | ${n(r.packets.length/(r.offeredMs/1000))} | ${n(r.drainMs)} |
`
 }
}
text+=`
## Desktop WebKit resources and input

The process group includes this Playwright browser and its WebKit XPC services, identified by the cached WebKit framework path; it excludes Vite, the automation driver and other apps. Browser rAF callbacks precede paint. Native probes end CPU scene construction, so these stages are not interchangeable. WebKit does not expose native-equivalent per-frame layout/render costs through this fixture.

| Mode | Scene | CPU % | GPU ms/15 s | MiB | Processes | Outstanding max | ACK p50/p95 ms | Drain ms | DOM wheel→rAF p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
`
for(const theme of ['dark','light'])for(const reduce of ['0','1'])for(const r of read(`desktop-webkit-120hz-${theme}-${reduce}`)?.results??[]){
 const resource=r.resourceText?.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
 text+=`| ${theme}/${reduce==='1'?'reduced':'normal'} | ${r.scene} | ${resource?.[2]??'—'} | ${resource?.[3]??'—'} | ${resource?.[1]??'—'} | ${r.resourcePids?.length??'—'} | ${r.maxOutstanding} | ${n(r.packetAckP50)}/${n(r.packetAckP95)} | ${n(r.drainMs)} | ${n(r.domWheelToRafP50)}/${n(r.domWheelToRafP95)} |\n`
}
text+=`
## Read-only real PR

PR #109, file index 15 for Changes (native/README.md), same input/full-rate settings. Short/clamped real scenes may submit no frames; a dash is not a zero-cost scrolling claim.

| Mode | Scene | Variant | Frame p50/p95 ms | Render p50/p95 ms | Layout p50/p95 ms | Outstanding max | ACK p95 / drain ms | CPU % / GPU ms / MiB |
|---|---|---|---|---|---|---:|---|---|
`
for(const theme of ['dark','light'])for(const reduce of ['0','1'])for(const label of ['real-before','real-after','desktop-webkit-real-120hz'])for(const r of read(`${label}-${theme}-${reduce}`)?.results??[]){
 const resource=r.resourceText?.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
 text+=`| ${theme}/${reduce==='1'?'reduced':'normal'} | ${r.scene} | ${label} | ${n(r.p50)}/${n(r.p95)} | ${n(r.renderMsP50)}/${n(r.renderMsP95)} | ${n(r.layoutMsP50)}/${n(r.layoutMsP95)} | ${r.maxOutstanding} | ${n(r.packetAckP95)}/${n(r.drainMs)} | ${resource?.[2]??'—'}/${resource?.[3]??'—'}/${resource?.[1]??'—'} |\n`
}
text+=`
## App-wide experiments

These controls keep PR geometry caching on and use dark/normal/full rate. Wheel \`all\` removes the PR bounds gate. \`frame-draw\` disables synchronous test-support drawing and relies on platform frames; wheel controls disable the explicit accumulator to isolate scheduling. Pointer controls use 120 Hz sinusoidal native pointer RPCs with no wheel input. The ungated controls use the same native Markdown/list fixture with every PR opt-in removed, comparing pr (no batching there) with all. Repeated samples are shown rather than choosing the best run. These flags remain opt-in: the full interaction/drag surface has not been proven safe for an app-wide default.

| Variant / repeat | Scene | Frame p50/p95 ms | Render p95 ms | Outstanding max | ACK p95 / drain ms | CPU % / GPU ms / MiB |
|---|---|---|---:|---:|---|---|
`
for(const variant of ['experimental-all','experimental-frame-draw','pointer-before','pointer-frame-draw','ungated-pr','ungated-all'])for(const repeat of [0,1])for(const r of read(`${variant}-${repeat}-dark-0`)?.results??[]){
 const resource=r.resourceText?.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
 text+=`| ${variant}/${repeat} | ${r.scene} | ${n(r.p50)}/${n(r.p95)} | ${n(r.renderMsP95)} | ${r.maxOutstanding} | ${n(r.packetAckP95)}/${n(r.drainMs)} | ${resource?.[2]??'—'}/${resource?.[3]??'—'}/${resource?.[1]??'—'} |\n`
}
for(const r of read('default-pr-repeat-dark-0')?.results??[]){
 const resource=r.resourceText?.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
 text+=`| default-pr-repeat | ${r.scene} | ${n(r.p50)}/${n(r.p95)} | ${n(r.renderMsP95)} | ${r.maxOutstanding} | ${n(r.packetAckP95)}/${n(r.drainMs)} | ${resource?.[2]??'—'}/${resource?.[3]??'—'}/${resource?.[1]??'—'} |\n`
}
const idle=read('idle');text+=`
Idle after scrolling: ${idle?`${idle.draws} submissions over 15 s; ${idle.resourceText.trim()}`:'pending'}.
`
text+=`
## Root cause and implementation

The release addon enables GPUI test-support for automation. App::flush_effects consequently drew every dirty window after each App update, including physical NSEvent callbacks. A 120 Hz producer could require ~16 ms per packet and accumulate seconds of transport/OS work even when visible submissions remained near 60 Hz. Physical macOS wheel events enter Window::dispatch_event directly; native GPUI List handles offsets without a JS/native RPC. Automation adds its own per-packet transport before this shared boundary.

GPUI list re-created every visible row and called layout_as_root on each frame, while TaffyLayoutEngine.clear destroyed the previous geometry. Parse/syntax caches retained formatted content but did not avoid layout. Summary was one giant Markdown row.

- GPUI List now invokes its paint-bounds callback (it implemented InteractiveElement but skipped that callback). This makes the PR-only native viewport gate functional; the burst test requires both painted List bounds and actual merged packets. scroll_input.rs accumulates precise wheel packets in one slot for painted PR viewports, scheduling one display callback. Same-direction deltas sum; a reversal uses the latest direction. Contact/terminal markers retain axis-reset semantics; zero-distance markers do not reset List’s accumulated offset. Non-wheel events and changed target/modifiers flush pending input before dispatch, and removed targets discard stale batches. Offscreen/idle windows gain no repeating timer. KYBERN_SCROLL_COALESCE=all is an experimental app-wide wheel mode; =0 is a control. KYBERN_INPUT_FRAME_DRAW=1 experimentally bypasses the synchronous test-support draw and uses existing platform-frame scheduling for all input. Both app-wide modes remain opt-in pending wider validation.
- native/patches/scroll_taffy.rs retains root-relative geometry, styles, topology and final measurement inputs. Keys include retained list/row identity and content revision; available size, device scale, styles and measured results must match. Each measured leaf is primed once to initialize the fresh frame's TextLayout/inline state. Unchanged roots bypass the flex solver. The cache holds no frame arena IDs or AnyElements; it is bounded to 128 roots/16,384 nodes, with per-root 8,192-node limit and two-frame expiry outside the visible window.
- scroll_layout.rs is a transparent element wrapper. Prepaint and paint always run, rebuilding viewport masks, hitboxes, hover/link listeners, selection/search geometry and automation bounds at the new offset. This is layout-geometry reuse, not retained scene translation or complete paint-only scrolling.
- scroll_js.py adds optional automation touch phases and declarations without upgrading dependencies. The real renderer and phase fixture share native Window dispatch; unsupported headless phase injection fails explicitly.
- scroll_hooks.py / scroll_gpui.py reconstruct the native and GPUI edits. Shared apply_hooks.py and backdrop_gpui.py only gain their dispatch calls.
- GPUI cached views ordinarily set window.refreshing while rebuilding a dirty cached parent, which forces every nested cached child to rebuild. PR viewports use independent_scroll_cache with the retained root revision: clean siblings may reuse their layout/paint under that internal parent refresh. Explicit window refresh still invalidates selection/appearance. Any retained content/style change invalidates the revision, and active native motion builds these PR boundaries inline to preserve ancestor opacity/transform paint state. Existing non-PR cache semantics stay on the original path.
- PR_SCROLL_LAYOUT opts in the PR list, Summary, file list, Timeline and native diff rows. Diff content/theme/expansion changes increment its cache generation. No Markdown chunking, source substitution, selection splitting, sidebar drag changes or second paint-translation primitive is introduced.
- native/scroll8-check.ts compares full-layout/cached pixels in dark/light × normal/reduced after scrolling, width/source/ancestor-opacity changes and deterministic ancestor-motion frames, and verifies selection, search and link clicks. native/update.sh registers it. The preview UI lease helper accepts only a matching explicit parent lease; perf/scroll8-update.ts acquires the lease before the final short rebuild, then holds it through the native check batch.

## Evidence and remaining acceptance

Native exact-pixel controls (all four modes, full update.sh passed): ${out}/cache/. Full-app and desktop reference captures: ${out}/app-*.png and ${out}/desktop-webkit-120hz-*.png. Raw timing/resource data, packet acknowledgements and frame logs remain in this directory.

Real-daemon PRs are accessed through scroll8-real-fixture.ts, which forwards only github.pr.list/detail/page and rejects other GitHub calls. Boot/session state remains in the disposable fixture. PR #109 has 810 changed files, a 2,240-byte description and no comments; the largest file on its first page is native/README.md (1,071 patch lines). A no-comment real Timeline cannot establish long-Timeline performance.

Final acceptance, repeated controls, idle samples, final checks and cleanup are recorded below after review.
`
writeFileSync(new URL('scroll-round8-2026-10-17.md',import.meta.url),text)
