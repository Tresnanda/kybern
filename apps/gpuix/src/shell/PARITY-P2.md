# Package 2: workspace, navigation and platform lifecycle

Worktree: `/Users/mymac/projects/ade-gpuix-shell`, based on `007f4481`.
Changes are uncommitted for parent integration, as required by the delegation wrapper.
No dependencies added; offline frozen install applied the existing native patches.

## Implemented

- `TitleBar.tsx`: make the nested thread-action chrome decorative so the Menu trigger receives pointer presses. The previously failing worktree-cleanup action now mounts.
- `environment/Panel.tsx`: settle Git status and checkpoint diff independently. A new thread without checkpoints retains its branch, repository and commit controls. The expected missing-checkpoint response no longer shows an ineffective Retry action. Other failures still report an error.
- `shell/CloseGuard.tsx`, `App.tsx`: native close veto with working/waiting thread summaries, cancel, keep working, stop-and-close, remembered per-environment preference, and partial-stop error handling. Environment remount cancels an unanswered close. No post-close React mutation is queued. Native npm fallback without the patched close API does not crash.
- `nav/overlay.tsx`: restore the prior focus after a dialog unmounts; otherwise a second Command-W after cancel had no focused native target. Closed-window restoration is harmless.
- `nav/live.ts`: persist unread completion state and attention dismissals; write atomically and flush on process exit. Existing environment reset flushes the old target before restoring the new one.
- `shell/environment.ts`: empty `KYBERN_URL` falls back to the data-directory identity. Previously all scratch launches with an empty URL shared the hash of an empty string, mixing their preferences.
- `nav/Palette.tsx`: Toggle theme and Use system theme commands. System hooks were already connected in `ui.tsx` before this package.
- `shell/appearance.ts`: native appearance follows the resolved app variant even with an opaque window; bounded startup retry, no new idle timer. The native renderer cannot retain old/new scenes for a true cross-fade.
- `state.ts` (explicitly authorized by parent): selection generation guards stop an older request for the same thread from overwriting the new snapshot or installing another subscription. Reset invalidates pending selections too.

## Platform seams

`platform.ts` ports the desktop's target validation, SSH host parsing, SSH options,
probe/start scripts and loopback tunnel plan. `bootstrapPlan` is **dry-run only**:
there is no production executor, upgrade/shutdown sequence, tunnel restart owner,
credential pairing, or environment UI integration. No SSH commands ran.

`checkRelease` reads the desktop's `latest.json` through an injectable fetcher,
validates versions and reports notes/newer status. It explicitly returns
`installable: false`: this manifest supplies Tauri artifacts, and there is no
signed GPUIX distribution/update installer yet. Tests use mocked responses;
no update was downloaded or installed.

The explicit-path CLI seam can install/uninstall the macOS/Linux symlink,
idempotently. It refuses other files and foreign/dangling links. Tests use only
fixture executables under a temporary directory. Bundle discovery, admin
escalation, Windows PATH and About-screen wiring remain missing; the user's PATH
and installed application were untouched.

## Validation

- `pnpm typecheck`: pass.
- `bun test ./src`: 19 passed, 0 failed (83 assertions; six test files).
- Native dark **and** light: worktree cleanup, real clean worktree inspection,
  no-checkpoint environment branch visibility, hide/show sections: pass.
- Native dark **and** light: Command-W veto, cancel, repeat close, allow close:
  pass. Stop-and-close was exercised against an idle scratch thread with a
  synthetic running UI state; it does not certify a real provider interruption.
- Two live theme toggles through the palette: pass; screenshots retained.
- Unread/dismissal persistence across two separate Bun processes: pass, including
  an immediate exit before the ordinary debounce fires.
- Same-thread hydration race, stale callback rejection, reset during hydration:
  pass in an isolated transport-stub subprocess.
- Actual installed scratch daemon: rename while `threads.get` is held, then
  resume; disconnect the socket, rename, then reconnect. Both changes replay
  exactly once. No real agent turn is started.
- Checkpoints: fixture has zero. There is `threads.checkpoints` read RPC but no
  create RPC. Checkpoint-dependent diffs remain unverified under the task's
  no-real-turn restriction; no database checkpoint fabrication was used.
- `docs/design.md` is absent on this branch. Used desktop component sources,
  `PORTING.md`, native README and combined audit as references.

Native fixtures: `verify.fixture.ts`, `verify.native.ts`, `verify.running.ts`.
Replay/persistence: `verify.replay.ts`, `verify.persistence.ts`.
Example: `bun src/shell/verify.fixture.ts bun src/shell/verify.native.ts dark`.
The fixture uses `/Applications/kybern.app/Contents/MacOS/kybernd`, port 0,
a temporary Git project/worktree, no provider turn, and cleans its daemon/data.

## Checklist status

| #108 line | Status | Result |
| --- | --- | --- |
| 3.27, 6.4 | Partial | Cleanup menu fixed; split/pane actions deferred. |
| 3.28, 11.1–11.4, 24.7 | Missing | Explicitly deferred by parent to a dedicated per-pane package. |
| 4.2, 27.8 | Partial | Existing separate-process window action remains; one-window-per-environment enforcement not added or certified. |
| 4.3, 27.9 | Partial | Tested SSH planning seam; no bootstrap executor, tunnel lifecycle or UI. |
| 4.7 | Partial | Address/pairing behavior unchanged; SSH still unsupported in UI. |
| 5.9, 5.12, 5.13 | Partial | Coordinator/send, draft commands and disabled-reason integration belong to other packages; no change here. |
| 20.3 | Done | Theme commands added alongside existing Notes/Tasks commands. |
| 21.4 | Done | Native window close hook and desktop-equivalent guard implemented/tested. Command-Q is not covered by the native API. |
| 21.5 | Done | Native worktree-cleanup entry and inspection pass dark/light. |
| 22.11, 27.13, 27.15 | Partial | Testable read-only release/explicit-path CLI seams; no production About wiring or GPUIX self-update. |
| 23.3, 27.12 | Missing | No permission-aware native notification delivery hook. |
| 23.4 | Done | Existing inbox now persists unread/dismissal state across restart. |
| 25.16 | Missing | True scene cross-fade unavailable; instant live theme switch retained. |
| 26.2, 26.3 | Done | Existing System hook retained; palette commands and opaque native appearance fixed. |
| 26.4, 27.5 | Partial | Translucency remains a launch-time setting. |
| 27.1 | Partial | Existing endpoint resolution; no new daemon spawn/restart lifecycle. |
| 29.2, 29.3 | Done | Generation fix; hydration and reconnect replay verified with real daemon updates and no duplicates. |
| 29.6 | Partial | Empty-URL isolation and inbox persistence fixed; complete preferences matrix still not certified. |

## Deferred split-view design

Do this as one integration with P3, not shell-only duplicate global views:

1. In `state.ts`, replace the singleton selected/open pair with `panes: Record<PaneId, PaneState>` and `focusedPaneId`. A PaneState owns selection (thread or draft), hydration generation, bounded ThreadState, unsubscribe handle, older-history state and reading/follow state. The workspace keeps one KybernClient. Each visible pane owns its replay cursor; closing a pane invalidates generation and unsubscribes. Environment reset disposes every pane before replacing the client. Reusing a thread in two panes must have explicit independent reading/selection state; shared immutable settled blocks are optional, not required for the initial correct port.
2. Provide `PaneProvider`, `usePane(selector)`, `getPane(id)`, `selectPaneThread(id, threadId)`, `sendFromPane(id, message)` and an explicit `focusPane(id)`. Global sidebar/history commands address the focused pane. Do not make provider output mutate a different focused pane by consulting a singleton at callback time.
3. `Transcript` and `Composer` consume pane-scoped hooks/context, including requests, native subagent composer, paging, composer draft keys and send/interrupt actions. Dock/environment/title consumers derive their target from the focused pane, while each pane renders its own header. Audit helpers that call `getState().selectedId` rather than hooks: those must accept a pane id for async actions.
4. Add persisted 2×2 topology separately from loaded content: pane ids, row/column ratios, focused id and selection. Clamp at four leaves. Empty pane is a true draft. Drag/drop validates a thread id, then atomically updates topology and selection; cancelled/outside drops do nothing. Keyboard splits are instant; pointer resize updates ratios without replaying entrances. Closed panes unmount and release subscriptions/Markdown/terminal work.
5. Verify distinct streams in two panes, same-thread duplicate views, focus changes during hydration/send, pane close during RPC, environment switch, resize minima, drag cancellation, 2×2 limits and bounded mounted history. Measure one vs four panes for idle/streaming footprint and frame/input timing. No shell topology was added in this package.

## Performance and limitations

Apple M1, macOS 27.0 (26A428), Bun 1.4.0, patched GPUIX 0.10.0. Each fresh
background native window opens the environment panel on an idle clean-worktree
thread with no checkpoints. Each sample has 10 seconds warmup then 15 seconds
measurement. `perf/sample.ts` uses process CPU-time deltas, `footprint` physical
MiB and Metal accumulated GPU time (not frame time or energy).

| Sources | Run | Footprint MiB | CPU % | GPU ms / 15 s |
| --- | --- | --- | --- | --- |
| `007f4481` baseline | 1 | 157 | 3.27 | 1.9 |
| `007f4481` baseline | 2 | 158 | 2.13 | 0.0 |
| Final P2 | 1 | 173 | 3.40 | 3.0 |
| Final P2 | 2 | 159 | 2.47 | 0.0 |

**The strict no-memory/CPU-regression acceptance is not met by these measurements.**
The initial P2 pair was 174/157 MiB, 2.20/2.47% CPU, 5.1/0.0 ms GPU;
a confirmation was 171/157 MiB, 2.93/2.60%, 2.2/0.0 ms. Avoiding redundant
startup material application did not eliminate the first-run footprint increase.
The fixed panel renders repository/branch/commit/PR controls that the baseline
incorrectly omits; therefore the visible scenes differ. Sibling agents also ran
on this machine, so these short samples do not isolate system contention. No
claim of a memory or CPU improvement is made. Investigation of the extra
first-run native surfaces/allocations remains open for integration.

Raw logs and screenshots: `/Users/mymac/projects/ade/previews/gpuix/p2/`:
`perf-before.log`, `perf-after.log`, `perf-confirm.log`, `perf-final.log`,
`typecheck.log`, `tests.log`, `native-final.log`, worktree/environment/close-guard
dark and light PNGs, and both live-theme PNGs. No frame/input/energy measurement
was performed in this package.

## Cleanup and handoff

Free space: **73 GiB before and after**. No Cargo build/target or daemon build was
created. All fixture-owned windows and installed-binary scratch daemons exited;
the fixture removes its temporary Git project, daemon data and per-fixture
preference files. Port 4219 and the user's running app/daemon were untouched.
After checking `lsof`, removed the task-copied 23 MiB native binary. To rerun,
copy it again from `/Users/mymac/projects/ade-gpuix/apps/gpuix/native/build/`.
The pre-existing `node_modules` remains (204 MiB after applying the frozen
patches; 184 MiB initially). No source/worktree registrations were removed.

`previews/gpuix/p2/shell.patch` includes tracked changes, new sources, tests and
this report for parent application from the repository root. No commit, stash,
reset, rebase, push or branch switch was performed; only the authorized initial
fast-forward merge to `007f4481`.
