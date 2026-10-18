# Native memory residency

Use a scratch daemon/data directory and the shared UI lease. These fixtures
reuse `../bench` seeding, resource sampling, build-overlap and orphan-process
checks. They never measure RSS as a substitute for physical footprint.

```sh
export KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/perf-memory
export KYBERN_CLIENT_CONFIG_DIR="$KYBERN_DATA_DIR/client"
export KYBERN_URL= KYBERN_TOKEN=
# Optional override; default is this task's original-workspace evidence folder.
export KYBERN_MEMORY_EVIDENCE=/Users/mymac/projects/ade/previews/gpuix/perf/memory
bun perf/memory/lab-run.ts after
bun perf/memory/run.ts after
bun perf/memory/visual.ts after
```

`lab-run.ts` creates 48 distinct 1536×1024 image sources, traverses them twice,
visits 24 image editors, and opens/closes a 12,000-line code node. Each settled
sample has a 10-second warmup followed by 15 seconds of CPU, GPU time and
physical footprint. It saves `footprint` region histograms and `vmmap -summary`
alongside native ownership and Bun heap counters. The code source exceeds the
existing 512 KiB highlighting limit: this deliberately exercises the existing
plain-code layout path, without changing its output or limit. Scene-to-next-
submission latency is an IPC/stderr proxy, not an image-ready or presentation
fence. `KYBERN_MEMORY_CODE_ONLY=1` isolates the code round trip;
`KYBERN_MEMORY_CODE_ROUNDS=2` repeats it in the same process;
`KYBERN_MEMORY_RELIEF=1` adds a harness-only Darwin allocator relief experiment.

`run.ts` exercises the full product in separate processes and leases:

- Load all 3,000 turns, visit logical scroll anchors every 20 turns, then
  Explorer Markdown/code and a 24-image note, finally returning Home.
- Populate terminal scrollback with 12,000 lines, stream paragraphs at 25 Hz,
  close the terminal, and return Home.
- Scroll a 2,400-line PR Changes fixture and return Home.
- Open/close a local HTML preview, keep Mermaid's hidden renderer alive with
  jobs every three seconds, then allow its existing ten-second idle release.

Use `KYBERN_MEMORY_GROUPS=webviews` (or a comma-separated subset) to isolate a
group. These screen samples retain the synthetic running sidebar row. Use the
separate `bench/run.ts idle-home` scenario to verify fully idle behavior.
The thread traversal visits logical anchors, not every pixel or every image;
the image lab independently stresses image ownership. WebKit samples list newly
created XPC service PIDs as candidates, separately from the main app; an external
app launch can confound that attribution. Exiting XPC services are recorded as
unavailable rather than fabricating a zero-memory result.

`visual.ts` captures only the fixture window, in both themes. It checks shared
image leases, eviction with a still-visible peer, last-owner release and editor
reopening, failed-load retry and code-to-Home layout resets. Screenshots run separately from timed measurements.

Labels beginning `before` load `native/build/memory-before.node`; explicitly
preserve the approved baseline there before rebuilding, or override
`NAPI_RS_NATIVE_LIBRARY_PATH`. Other labels load the current addon. Do not copy
over a mapped signed addon: remove/replace its inode first.

## Ownership and counters

Native `<img>` adapters lease shared image sources. Dormant entries have a
16 MiB CPU-plus-estimated-GPU budget and a 128-entry limit. Mounted owners are
protected, so the total can exceed that budget; the last owner leaving flushes
the cache. Eviction drops the asset task and the image's atlas tiles. Previous
GPU submissions finish before their atlas regions can be reused.

Rich editor images use a 16 MiB dormant budget and the existing 48-entry limit.
Current documents and undo/redo image references remain protected. Destroying
an editor removes its ownership immediately; reopening asks native residency
before reusing a resolved JavaScript load promise. The existing downsampling
limit is unchanged.

`getMemoryStats()` reports decoded CPU bytes, estimated GPU image pixel bytes,
leases, dormant bytes and evictions. It also reports retained frame-arena bytes
and layout-node high water. With `KYBERN_MEMORY_COUNTERS=1`, `metalGauges` contains
the last submission's Metal device allocated bytes, instance target bytes,
cached instance buffers, actual atlas texture capacity, path texture bytes and
backdrop scratch bytes. These gauges are snapshots, and pixel estimates are
neither atlas capacity nor physical footprint. Bun heap usage and React node
counts are separate observations; the residual footprint cannot be assigned
exactly to a language/runtime from those counters alone.

For controlled diagnosis, `KYBERN_IMAGE_MEMORY=0` disables `<img>` ownership,
`KYBERN_EDITOR_IMAGE_MEMORY=0` disables editor trimming,
`KYBERN_FRAME_MEMORY=0` disables frame-storage shrinking. Default behavior adds no
idle timer or idle render loop. `build.py` is a task-local low-priority build
wrapper, including shared build/quiet markers and scratch environment settings.
Its build marker covers compilation, all native checks, and native/tooling TypeScript checks.
The local `native/build/memory-final-pending` gate holds final measurements until
that entire validation passes. `pair.py` waits for
this lane's quiet turn and runs the three-repeat startup/scroll/idle A/B suite;
`pair.py --memory` uses a separate bounded quiet turn for memory and visuals.
`pair.py --controls` runs fresh startup controls and matched RPC-input scroll
controls with native ownership counters, including all memory features disabled.
The optional `KYBERN_BENCH_RPC_ONLY=1` benchmark hook leaves normal backend
selection unchanged. The controls replace thread/Markdown rows only after addon
identity is verified, preserving the original mixed-input artifact separately.
Both honor build reservations and the current quiet holder's UI priority.
`pair.py --resume` retries failed/missing benchmark scenarios in fresh processes,
retains accepted runs, verifies addon/settings/workload identity, and archives
the failed attempt separately before producing the accepted comparison.
`pair.py --remaining` resumes the product/code-repeat/visual jobs after the image
labs, with a scratch-only preview grant and an untimed preview/Mermaid smoke
check first. Full-product A/B runs use identical fixture imports and setup.
`summarize.py` preserves accepted compact results and generates `RESULTS.md`.

The allocator-relief probe tested both all zones and the explicit default zone.
Both returned zero pages and did not lower physical footprint on this host; no
allocator-relief call is included in the production patch. `KYBERN_MEMORY_HEAP=1`
adds a separate post-sample `heap -s -H` ownership inspection.
