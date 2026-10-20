# Right dock verification — 2026-10-15

## Workload and method

Apple M1, macOS 27.0 (26A428), Bun 1.4.0, GPUIX 0.10.0.
One background window from this checkout, 1280 × 820 logical pixels; narrow
check at 980 × 820. Patched native module from the main GPUIX checkout,
except the explicitly labelled stock control. No native rebuild or install.
Each sample is 15 s using `perf/sample.ts`: process CPU time from `ps`, physical
footprint from `footprint`, accumulated Metal GPU time from `ioreg`. Daemon and
other agents are excluded. The window was backgrounded; GPU is a lower bound,
not a foreground frame-rate or energy claim. Concurrent agents can affect
scheduling and occlusion.

Scratch daemon on port 4219; settled six-line file-writing thread. The retention
fixture comprises two distinct 10,000-line TypeScript files, 627,780 / 647,780
bytes. Explorer reads at most 256 KiB (same limit as desktop); Diff loads one
file patch only after expansion. No screenshots during retention measurements.

## Final per-pane run

| State | CPU | Physical footprint | GPU / 15 s |
| --- | ---: | ---: | ---: |
| Fresh, dock never opened | 3.27% | 177 MiB | 0 ms |
| Agents, empty settled lineage | 2.87% | 181 MiB | 0 ms |
| Diff, 10,000 added lines, native virtual scroller | 2.60% | 199 MiB | 0 ms |
| Explorer, 256 KiB read, 64-line virtual chunks | 2.47% | 210 MiB | 1.0 ms |
| Closed and unmounted afterwards | 2.73% | 212 MiB | 0 ms |

Earlier pointer-toggle runs, after screenshot capture and all panes visited:

| Workload | Run 1 CPU / footprint / GPU | Run 2 CPU / footprint / GPU |
| --- | --- | --- |
| Idle Agents | 2.87% / 311 MiB / 1.5 ms | 2.60% / 314 MiB / 0.5 ms |
| Toggle dock repeatedly | 3.80% / 304 MiB / 7.2 ms | 4.60% / 312 MiB / 13.7 ms |

The automation completed 7 and 11 toggles, respectively, in the 15 s windows.
These are burst interaction costs, not sustained smooth-animation benchmarks.
The larger footprint includes the capture sequence; the fresh no-capture runs
above are the useful attribution. No claim that the dock alone added 150 MiB.

## Retention before and after bounding native code layout

The initial Explorer used one native code node for the full 256 KiB read. That
node eagerly created and laid out thousands of line elements, even offscreen.
The final implementation uses 64-line native code nodes in a virtual list, with
fixed 20px line height and continuous absolute line numbers. All text in the
bounded read remains reachable by scrolling. There is no page navigation.
Large diffs use the native diff element's virtual `scroll` mode at a bounded
height, rather than increasing a nonvirtual `maxLines` limit.

Physical footprint in MiB, with each open/close followed by its own 15 s sample:

| Step | Before: one code node | After run 1 | After run 2 |
| --- | ---: | ---: | ---: |
| Fresh, never opened | 179 | 142 | 178 |
| Open first file | 469 | 182 | 207 |
| Close | 546 | 214 | 204 |
| Reopen same file | 560 | 211 | 207 |
| Close | 547 | 211 | 207 |
| Open second file | 574 | 225 | 209 |
| Close | 556 | 226 | 217 |

CPU by the same seven steps:
- Before: 2.87, 2.87, 2.33, 3.27, 2.33, 2.33, 2.80%.
- After run 1: 2.67, 2.60, 8.27, 2.40, 2.60, 5.53, 4.13%.
- After run 2: 2.53, 3.13, 2.93, 2.53, 2.47, 2.80, 3.00%.

After run 1 GPU values were 0, 0, 103.8, 0, 4.5, 45.3, 26.4 ms; the second
run was 0 except 0.2 ms on first open. The first run had noisy closed/second-file
samples, so both runs are retained instead of averaging away the variation.

Stock-native control (`KYBERN_GPUIX_NATIVE=npm`, no native override), using the
old one-node renderer: fresh 190 MiB / 2.87% CPU, open 420 MiB / 3.00%, close
413 MiB / 2.53%; GPU 0.4, 0, 0 ms. The large native-layout cost exists without
the cached-island patch. The patch may exacerbate retained high-water memory;
this test does not isolate a particular allocator or text cache.

No file strings are kept in the dock store. Explorer's listings, source and
chunks are component-local; tests assert the file subtree disappears on every
close. Native custom elements are removed by the registry's `prune_missing`;
the native syntax cache is capped at 96 documents / 24 MiB. `vmmap -summary`
on the old renderer showed about 354 MiB allocated in DefaultMallocZone plus
66 MiB fragmentation, with only about 1.4 MiB resident+swapped JS VM reservations
(the separately tagged Bun regions mean that last number is not a JS heap
measurement). Evidence points to native layout/cache/allocator retention, not
a deliberately kept-mounted pane. An allocation backtrace was not captured.
The final repeated-file sequence plateaus near 207–217 MiB, rather than
retaining the old 546–556 MiB high-water footprint.

## Checks and artifacts

- `pnpm typecheck`: passes.
- `bun test src/dock/store.test.ts`: 3 tests, 12 assertions pass.
- Native automation: pointer open/close, 538→478 resize, instant Cmd-J,
  tab addition/close and content unmount, keyboard tab arrows with focus transfer,
  wide inline / narrow overlay layouts, light/dark and reduced motion.
- Read-only real-daemon check: populated lineage, completed-child result,
  disclosure, and populated Activity. Waits for loaded header/list up to 60 s;
  real daemon list requests can take 12+ s. No startup refresh workaround.
- Scratch Coordinator: revisioned brief save and brief-in-all-threads switch,
  changed then restored, in addition to light/dark render checks.
- Native files: long diff scroll, code scroll through the 64/65 chunk boundary,
  continuous line numbers and highlighting, file action menu.
- Commit/push, remote PR creation, Stop and destructive worktree removal were
  wired but not executed against real work. The desktop's current `git.commit`
  does not push; that daemon gap is tracked separately by the orchestrator.

Screenshots are outside git, in the original conversation folder:
`/Users/mymac/projects/ade/previews/gpuix/dock/`.
Useful pairs: `09-lineage-{dark,light}.png`, `10-lineage-detail-{dark,light}.png`,
`11-activity-{dark,light}.png`, `06-project-{dark,light}.png`,
`07-project-settings-{dark,light}.png`, `13-large-explorer-scroll-{dark,light}.png`,
`13-large-changes-scroll-{dark,light}.png`, and `05-overlay-light.png`.

Reproduction scripts are `scripts/dock-check.ts`, `dock-files-check.ts`,
`dock-agents-check.ts`, `dock-project-check.ts`, `dock-memory.ts`, and
`dock-retention.ts`. Set `NAPI_RS_NATIVE_LIBRARY_PATH` to the built patched
module and `KYBERN_DATA_DIR` / `KYBERN_GPUIX_THREAD` to the desired scratch
endpoint/thread. `dock-project-check.ts --write` and `dock-fixtures.ts` reject
any data directory except the designated scratch daemon. Large fixtures are
created by `dock-fixtures.ts`, removed by `dock-fixtures.ts --remove`.

## Remaining limits

- Tab/width/expansion choices survive within the process, not across restart.
- Native geometry has only a sampled getter: one 250 ms size read while the
  dock is mounted, none when closed. This is the sole idle dock polling timer.
- A one-shot 260 ms exit guard releases the pane if native motionComplete is
  omitted at width zero; keyboard/reduced-motion closes unmount immediately.
- Native code has no start-line offset or shared highlighter state. The gutter
  is rendered separately; syntax spanning a 64-line boundary can lose context,
  and each native chunk owns horizontal scrolling. Vertical scrolling is
  continuous. A future native virtual code node would remove both limitations.
- Explorer has source/Markdown preview, search, lazy folders, copy/path actions
  and local Reveal in Finder. Open in Preview awaits the Preview port; full
  desktop file-tree arrow-key behavior is not yet reproduced.
- Review, Terminal, Artifacts, Notes, Tasks, and Preview dock tabs were outside
  this implementation. Environment remains the pre-existing header placeholder.
- Existing global native limitations (font registration, materials/accessibility
  preferences, rich Markdown interactions) remain; no webview was introduced.

Disk: 75 GiB free before, 74 GiB after (other agents also used this volume). No native build or dependency installation;
existing 184 MiB node_modules retained, no task-created target or cache. Scratch
large fixtures are removed after validation; screenshots retained for review.
The six-line greet fixture, two idle scratch threads and their brief remain
as small reproducible verification records in the shared scratch daemon.
