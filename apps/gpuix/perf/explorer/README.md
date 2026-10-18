# Explorer scroll reproduction

Use exact dependencies in both `apps/gpuix` and `apps/desktop`, and the existing
patched addon. No package upgrades or native-addon rebuild is required.

From `apps/gpuix`, start the installed daemon against a disposable directory on
port 4323. Set `KYBERN_DATA_DIR` to that directory and
`KYBERN_CLIENT_CONFIG_DIR` to a subdirectory of it for every command below.
The scripts reject the normal Kybern data directory.

```sh
clang -dynamiclib -fobjc-arc -framework AppKit perf/explorer/wheel.m -o perf/explorer/wheel.dylib
bun perf/explorer/seed.ts
EXPLORER_SCENES=tree bun native/ui-lease.ts perf-explorer bun perf/explorer/run.ts final-tree
EXPLORER_SCENES=preview.md bun native/ui-lease.ts perf-explorer bun perf/explorer/run.ts final-preview
EXPLORER_SCENES=long.md,long.ts,minified.ts,large.json bun native/ui-lease.ts perf-explorer bun perf/explorer/run.ts final-source
EXPLORER_SCENES=long.ts,preview.md EXPLORER_COMBINED=1 EXPLORER_IDLE=1 bun native/ui-lease.ts perf-explorer bun perf/explorer/run.ts final-combined
EXPLORER_SCENES=tree EXPLORER_MAGNITUDE=30 bun native/ui-lease.ts perf-explorer bun perf/explorer/run.ts final-fast-tree
bun native/ui-lease.ts perf-explorer bun perf/explorer/checks.ts
```

Labels beginning with `baseline` load the original Explorer and MotionFileTree
from `ef2251e2` through a Bun source plugin. Override `EXPLORER_BASE_REF` for a
different fixed source. Run each baseline tree/Markdown-preview scene in its
own process: its AppKit queue can remain badly backlogged after input production
ends. An overloaded process is killed after a two-second close deadline.

The wheel producer runs on a native background thread at 120 Hz, independent
of JS/render stalls. Synthetic precise NSEvents enter the actual GPUIView
`scrollWheel:` handler through AppKit's main-thread selector delivery. Each
2.5-second burst has one second of contact, then exponential momentum, followed
by a reversal. Contact and momentum phases are supplied separately. No cursor
movement, Accessibility grant, automation wheel RPC or hardware event is used.
This is repeatable native-path input, not a physical trackpad certification.

The harness checks native-build markers before/after each resource run and polls
them during it. A contaminated run fails with a discard/repeat message.

Each scene warms for 10 seconds, then receives 1,800 packets over 15 seconds.
`KYBERN_FULL_RATE=1` is explicit. Frame timestamps are native scene submissions,
not physical presentation fences. `offeredToAppKitHandlerEnd` includes queued
input and the handler, but coalesced painting may happen later;
`inputToCpuPaint` ends CPU scene construction after native dispatch and excludes
the AppKit queue. Neither is input-to-photon latency. Undelivered packets at
producer completion are reported explicitly. CPU/GPU/footprint use the existing
`perf/sample.ts`; daemon and WindowServer are excluded.

`EXPLORER_PROFILE=1` adds a separate five-second `sample` capture; use those
runs for diagnosis, not clean acceptance. `EXPLORER_IDLE=1` samples again after
closing the final file and waiting 20 seconds. `EXPLORER_LIFECYCLE=1` logs native syntax-document counts
after file open/close, without timing. `EXPLORER_VISUAL=1` instead captures
initial/scrolled views; select `KYBERN_APPEARANCE=light` for the other theme.
Screenshots and timing never share a run. The window is floated without
activation and ignores unrelated physical mouse input.

Evidence goes to `previews/gpuix/perf/explorer/` in the original conversation
checkout. Remove this task's daemon data, disposable dependency installs and
generated wheel dylib when finished; retain sources and evidence.

`EXPLORER_COMBINED=1` restores the complete tree after finding/opening a file.
Without it, the search result remains filtered; keep the modes separate in
reports. `EXPLORER_MAGNITUDE=30` crosses the rich-row buffer repeatedly.
The regression suite retains the existing dock assertions and Explorer motion
checks. Its test-only preload waits for the asynchronously resolved scratch
client before the older dock fixture wraps it. Keyboard checks let native motion
settle with the test clock; the timing harness never advances that clock.
