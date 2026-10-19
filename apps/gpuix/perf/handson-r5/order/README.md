# Startup ordering and image-close anchors

Evidence goes to `/Users/mymac/projects/ade/previews/gpuix/handson-r5/order/`.
All data/configuration uses `ade-gpuix-scratch/hr5-order*`, daemon port 4343.
The native addon is unchanged. Run UI commands through `native/ui-lease.ts`;
every fixture also sets `GPUIX_BACKGROUND=1` and verifies the hidden test display.

## What is exercised

- Startup restores the benchmark's 3,000-turn conversation in 20 projects /
  300 threads. `paired.py` runs the requested five cold and five warm launches
  per version. Both use the same rebuilt daemon/addon; the before version loads
  four original app modules from `e1ffabf63`, prepared outside the app's clock.
  Process cold clears the daemon projection cache, not the OS filesystem cache.
- `startup-frames.ts` is a separate screenshot pass in both themes. Its frames
  include synchronous capture/placement inspection overhead and must not be
  used as timing samples. `frames.json` identifies the actual selected images.
- `lightbox.ts` opens the full app and loads a 1,000-turn conversation, chooses
  a distant region, clicks the real message rail and sends real wheel input.
  It checks Escape, the close button and outside presses in the middle, 37 px
  above the end, at the end, and during 40 ms streaming deltas. It compares
  the semantic top key, native list identity/index/offset and image y coordinate.
  A final answer/image is made short in the fixture only, so the tail image is
  visibly reachable. Tail growth after closing must keep following the end.
- Escape is sent to the focused window, without an element id. Locator `press`
  first reveals its virtual ancestor and would itself move the list before the
  close handler runs.
- `desktop.mjs` uses the actual desktop `ResponseImage` and kit dialog in
  headless Playwright WebKit, in a long scroller, in both themes/motion modes.
  It is a focused behavior reference, not a full-shell screenshot parity claim.
- `regressions.ts` reuses scroll2/flick checks with this lane's own paths. The
  scroll2 image test now also asserts that closing an offscreen leased trigger
  preserves the current anchor and rail.

## Reproduce

After frozen installs in `apps/gpuix` and `apps/desktop`, from `apps/gpuix`:

```sh
python3 perf/handson-r5/order/build.py
KYBERN_COLDSTART_QUIET_LANE=hr5-order bun perf/coldstart/quiet.ts python3 perf/handson-r5/order/paired.py
bun native/ui-lease.ts hr5-order-images bun perf/handson-r5/order/lightbox.ts after
bun native/ui-lease.ts hr5-order-frames bun perf/handson-r5/order/startup-frames.ts after
bun native/ui-lease.ts hr5-order-desktop node perf/handson-r5/order/desktop.mjs
```

Pass `before` to either visual runner to prepare/use the original modules.
`build.py` reserves the shared native-build slot, uses this checkout's one target
directory, four jobs, no incremental/debug output, and nice 15. It builds only
the daemon/CLI, runs protocol/project tests and clippy, and writes logs externally.
Remove the disposable target and dependency installs after verification.

The production change requests the stored project index with
`projects.list {refresh_git:false}` first; normal Git discovery follows in the
background. Omitted parameters preserve the existing RPC behavior. The startup
paint improvement needs the updated daemon; older daemons ignore the additive
parameter and still take their usual Git-probe time. No persistent index cache,
history truncation, new idle timer or native patch is introduced. Image dimensions,
corners, outlines and motion timings retain their existing desktop mappings.
