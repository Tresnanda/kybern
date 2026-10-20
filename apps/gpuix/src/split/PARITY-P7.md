# Split panes and retained subagent pages — P7

Worktree: `/Users/mymac/projects/ade-gpuix-shell`, branch `gpuix/shell`.
Changes remain uncommitted. The inherited seven-file pane-state patch and
untracked split store were preserved in `/tmp/p7-wip.patch` and
`/tmp/p7-untracked`, then reapplied cleanly after the authorized fast-forward
from `895f0519` to `7928d797` (`feat/gpuix-mvp`). No stash, branch switch, native
source edit, Cargo build, push, or real provider turn was used.

## Implementation

- `state.ts`: a pane context and pane-specific selection/generation/draft with
  backward-compatible focused `getState`, `set`, `selectThread`, and `send`.
  One transport session, hydration promise and event subscription per open
  thread; duplicate panes share immutable transcript state, while reading and
  editor state remain pane-specific. Close/reset releases unused subscriptions.
  Session identity rejects stale hydration and paging across close/reopen.
- `split/store.ts`: reuses the desktop's binary tree, alternating split axes,
  depth-two limit, ratio clamps and collapse behavior. Persists topology, focus,
  and selections through the per-environment store. Environment transitions
  suppress intermediate persistence and restore before hydration.
- `split/Workspace.tsx`: split right/down, nested panes, focused-pane ring,
  native divider resizing and keyboard ratio controls, compact pane gutters,
  narrow-window vertical fallback, recent-thread/empty-pane choices, close and
  expand actions. Pane headers reuse `ThreadHeader` and its existing menus;
  the window title bar holds global toggles in split mode.
- Composer targets/catalog requests are keyed by thread, editor drafts by pane,
  and draft choices by pane. Async sends capture their initiating pane and
  generation. Composer measurement and request height are scoped by pane.
- Transcript anchors and disclosure state are pane-specific; shared paging is
  de-duplicated. Code wrapping measures the actual transcript surface width.
  Large history remains on the existing virtual rows and paced stream hooks.
- `SubagentPageMotion` retains a frozen outgoing `AppState` context, and the
  entire conversation (including composer selection) is evaluated inside it.
  Parent/child pointer navigation uses native spring translation and opacity;
  keyboard navigation and Reduce Motion are instant. Superseded completion
  callbacks cannot remove a newer transition. Frozen composers do not autofocus
  or refetch their targets/catalogs, and frozen transcript paging is disabled.

## Verification

Artifacts: `/Users/mymac/projects/ade/previews/gpuix/p7/`.

- `pnpm typecheck`: pass.
- `bun test ./src`: 35 pass, 0 fail; 384 Bun assertions. The new subprocess test
  also uses Node assertions for distinct threads, duplicate-thread subscriptions
  and shared events, close during hydration, selection races, environment reset,
  topology limits, and persisted layouts across environments.
- Native dark/light split checks: retained outgoing/incoming content, exit
  unmount, instant keyboard navigation, split/focus/nested split/close, resize.
- Native narrow light fixture: horizontal split stacks vertically at 900px
  window width; Command-backslash and Reduce Motion navigation pass.
- Existing conversation, requests and message-navigation checks pass dark/light.
- Existing shell checks pass dark/light. Combined full-shell pointer check passes
  with an installed-binary scratch daemon and scratch data directory.
- `git diff --check`: pass. Screenshots reviewed in light and dark.

The native fixture's top diagnostic toolbar is not product UI. It uses synthetic
transcripts; tests of real provider streaming, energy, input latency, and frame
intervals were not performed. `docs/architecture.md` and `docs/design.md` are
absent on this branch; desktop component/CSS sources, PORTING, native README,
performance guidance and P2/P3 reports supplied the references.

## Outstanding acceptance / limitations

**11.2 follow-up (integration checkout, October 15).** A sidebar row's hover
leave cancelled a pending drag even while the mouse button remained held.
Pending and active gestures now route through the stable App root, and hover
leave only updates row hover. Root handlers mount only during a gesture:
unconditional handlers interfered with normal full-shell pointer routing.
Release re-evaluates the target at its final coordinates. Escape and source
release clear capture; click suppression is scoped to the source row until a
fresh press. The AppKit watchdog cancels missed outside releases and deactivation,
and runs only for physical gestures. Its four unit tests cover release grace,
deactivation, disposal, and synthetic input. Physical outside-window verification
remains opt-in (`--drag --physical`): Accessibility preflight returns false here,
so no physical events were posted and that acceptance item remains unverified.

Follow-up validation in `/Users/mymac/projects/ade-gpuix`:

- `bun run typecheck`: exit 0.
- `bun test ./src`: 41 pass, 0 fail, 395 assertions across 14 files.
- `bun src/split/native.verify.ts --drag`: exit 0. Both dark and light each
  pass three consecutive Escape/source-release/bottom-drop trials and three
  rounds of left/right/top/bottom/center/empty drops (54 drag scenarios total).
  No stuck capture/highlight; pane contents and directional placement asserted.
  The same run verifies retained navigation, keyboard instant navigation,
  resizing, focus, nested splits and close. AppKit emitted non-fatal "Window move
  completed without beginning" warnings; no assertion or renderer exception.
- `bun src/split/narrow.verify.ts`: exit 0; reduced-motion navigation, split
  shortcut, and narrow vertical fallback pass.
- Combined full-shell pointer verifier: settings pointer/Space, sidebar,
  titlebar and dock entrance/tab/collapse pass with the installed daemon in a
  fresh `gpuix-scratch` directory on an OS-assigned port.
- Screenshot/log evidence: `/Users/mymac/projects/ade/previews/gpuix/split-drag/`.
  Dark/light target screenshots visually reviewed. Top fixture toolbar is test UI.

The drop preview follows `components/kybern/ChatPaneDropOverlay.tsx` and
`styles/kybern.css` (the rules are not in `kit.css`): 8px outer inset, half-pane
minus 12px dimensions, 10px target radius, 22% surface scrim, 38% surface target,
18%→8% accent gradient, 64% focus border, and 150ms cubic-bezier(.22,1,.36,1)
opacity fade. The gradient uses a separate child because GPUIX gives
`backgroundColor` precedence over `background`. Empty panes show "Open here";
occupied center drops retain the existing thread and choose a split direction.
The overlay's window-coordinate origin accounts for the fixture toolbar.

Visual parity remains partial: GPUIX styles do not expose desktop backdrop
blur/saturation. Divider and label borders use alpha rather than the desktop's
mix with a second base color; divider glow, label inset/drop shadows, target
scale-in, and source-row dimming are not reproduced. This work does not claim
pixel-identical materials. The existing
`Draft.tsx` is outside this package's ownership and retains its single-page gutter
when New thread opens a split draft. Full visual parity therefore remains open.
Pane-scoped metadata and the outgoing transcript are frozen, but external activity
stores are not part of `AppState`; an activity badge can still update during the
short outgoing transition. No claim of a fully immutable native scene is made.

## Performance and cleanup

Measurements are deterministic synthetic streaming, Apple M1, macOS 27.0
(26A428), Bun 1.4.0, patched GPUIX 0.10.0. One background native window,
1280×820, append every 300ms, 10s warmup and 15s samples, two runs per condition.
Physical footprint, process CPU-time delta and accumulated Metal GPU time are
reported separately; GPU time is not a frame-interval or energy measurement.
The inherited baseline is 185/189 MiB, 22.67/21.53% CPU, 16.1/119ms GPU per 15s.

| Condition | Footprint (MiB) | CPU | GPU time / 15s |
| --- | --- | --- | --- |
| Single pane before (inherited) | 185 / 189 | 22.67 / 21.53% | 16.1 / 119ms |
| Single pane after | 189 / 188 | 32.07 / 22.33% | 178.6 / 178.8ms |
| Two streaming panes | 202 / 200 | 32.80 / 35.80% | 173.4 / 160.3ms |

Single-pane footprint is comparable, but CPU varies and GPU time is higher.
The required no-regression result is **not established**. These two short samples
are insufficient to isolate the cause or claim energy/frame/input improvements.
Raw samples are in `perf-before.log`, `perf-single.log`, and `perf-two.log`.

Free space was 71 GiB before dependency installation, 70 GiB during final checks.
No Rust target or dependency download was created. The pre-existing node_modules
is approximately 225 MiB. Scratch daemon data and fixture credentials are isolated;
the user's installed daemon, port 4219 and normal ~/.kybern data were untouched.
After checking processes and open files, removed this task's copied 23 MiB native
binary. No task-owned fixture remains running. Retained the pre-existing 225 MiB
node_modules for the ongoing worktree. Scratch directories created by fixture
wrappers were cleaned; unrelated scratch daemons were left running. Final free
space remains approximately 70 GiB (no claim that APFS immediately reclaimed all
removed blocks). Source, tests, report, screenshots and logs remain available.

Follow-up cleanup: stopped only the cancelled/resumed task's fixtures and queued
verifier, removed their abandoned scratch directories after checking open files,
and let successful fixture wrappers remove their own data. No native build or
dependency install was needed; no native source was edited. The orchestrator's
`native/decorated-input.tsx` patch was left untouched. Free space was 69 GiB
before and after; the pre-existing 264 MiB node_modules remains for ongoing work.
