# Notes, prompt controls, and Activity — 2026-09-09

## Behavior

Desktop replaces the Environment panel’s Recap with editable per-thread Notes.
Mobile exposes Notes in the environment menu. Explicit saves persist through the
daemon and sync through thread events and hydration. Revision checks reject stale
writes without discarding the local draft. Notes do not enter agent prompts or
transcripts. Desktop unsaved drafts use local storage; mobile unsaved drafts live
for the app session. Mobile waits for hydration before enabling editing.

Both composers expose queued follow-ups during running turns. Queue editing now
updates the existing item, preserving FIFO order and attached context. The daemon
re-reads the item under the dispatch gate so a worker cannot send its pre-edit
copy. Queue removal and turn consumption do not resurrect items on late updates.

Codex additionally exposes **Steer now**, using its existing native `turn/steer`
driver control. Steering adds chronological user input to the active turn without
starting another one. Durable receipts acknowledge repeated requests after a lost
RPC response; successful-delivery retries are serialized by the turn gate.
Other providers keep queuing because their drivers do not implement native
steering. Stop remains separately available. Queue rows release their temporary
entrance blur and compositing hint when the animation finishes. Rejected sends retain composer text.
The CLI adds `steer`, `notes`, and `queue update`. These additive RPCs need the
updated daemon; a mobile bundle update alone is insufficient.

## Investigation and changes

Activity task-tree construction copied the complete sibling array for each task,
producing quadratic work for large groups. It now appends to private arrays during
tree construction. Activity virtualizes all retained history, memoizes completed
rows, reuses number formatters, and disables its clock while hidden. Previously
the pane rendered only 20 recent completed tasks; older retained tasks are now
reachable. Turn subscriptions retain their selected task array when an unrelated
task changes, avoiding rebuilding settled work in other turns.

The virtual row list measured its origin on every scroll, even though scrolling
does not change that origin in content coordinates. It now observes viewport and
preceding-content size changes and inherited row movement. End anchoring remains
for prepends, but automatic size-change following stops when the reader scrolls
up. The unchanged code reproducibly pulled a small upward gesture back to the
bottom during new output; the updated interaction fixture preserves that position.

## Native comparison

Apple M1, macOS 27.0, system WKWebView, 1100 × 720 CSS-pixel window, production
CSP at `tauri://localhost`. Baseline is `620abe8` in an isolated archive with the
same synthetic fixture and runner. Each measurement uses a fresh fixture process;
Activity takes 25 merge and update samples per task count. One baseline and one
updated sequence were run; Activity was repeated after strengthening the oldest
row assertion. Ordinary development applications remained open. No live user
transcripts were used, and these are not physical-device mobile measurements.

| Measurement | Baseline | Updated |
| --- | ---: | ---: |
| 4,000-task merge p95 | 30 ms | 3 ms |
| 4,000-task React update commit p95 | 28 ms | 4–5 ms |
| Mounted Activity rows, 4,000 tasks | 21 (history capped at 20) | 15 (all history reachable) |
| Hidden Activity timers started | 1 | 0 |
| Long-thread scroll list-origin rectangle reads | 89 | 0 |
| Long-thread scroll frame interval p95 | 23 ms | 23 ms |
| Short-thread scroll frame interval p95 | 18 ms | 18 ms |
| Streaming frame interval p95, both sizes | 18 ms | 18 ms |
| Synthetic input-to-frame p95, long / short | 14 / 17 ms | 15 / 15 ms |
| Small upward gesture preserved during output | Failed | Passed |

Long history contains 400 historical turns; short history contains eight. Both
include one additional turn with 800 tools and then a separate 180-table streaming
stage. The scroll stage samples 90 positions. The updated long fixture mounted
eight history messages, and expanded work mounted 25 tool rows. Exact final text
and all 180 formatted tables passed. The baseline scaling fixture fails only its
new redundant-list-read assertion, not the formatting or responsiveness checks.

The Activity improvement is substantial. Pure scrolling frame p95 did not improve
in this workload; removal of redundant reads and fixing snap-back are established,
but universal smoothness is not. React commit timings exclude subsequent layout
and presentation. Input probes are dispatched events, not OS key-to-screen latency.
CPU, GPU utilization, power, and energy were not measured.

## Validation

- Desktop: 110 tests, typecheck, lint, production build, and native `activity`,
  `prompts`, `interaction`, `scaling` (400 and eight historical turns), and
  `rendering` fixtures passed. Prompt controls cover light/dark, failed saves,
  remote Notes conflicts, attachment-preserving queue edits, steering, and Stop.
- Native interaction checks preserve first/middle/last navigation, selection,
  focus, wrap/expansion state, history prepends, reading position, resize, thread
  switching, following, and the final entry in expanded agent activity.
- Rust: 188 library/binary tests passed (two pre-existing ignored tests), seven
  schema tests and three protocol input tests passed; formatting and workspace
  clippy passed. The daemon and CLI build passed. Notes persistence and conflicting
  saves are exercised over real RPC clients and by reopening the SQLite store.
- Five of six live driver tests passed. Live Codex failed because its CLI refresh
  token was revoked. Native steering therefore remains unverified against a live
  Codex session in this run; the daemon’s recording-driver tests pass.
- Mobile: 39 tests, typecheck, Expo Doctor (21/21), and iOS/Android exports passed.
  No simulator or physical-device UI check was performed in this resumed run.
  No application release, mobile OTA, or installed-daemon replacement was made.

Reproduce from `apps/desktop`:

```sh
node scripts/check-rendering.mjs activity
node scripts/check-rendering.mjs prompts
node scripts/check-rendering.mjs interaction
node scripts/check-rendering.mjs scaling
KYBERN_PERF_HISTORY=8 node scripts/check-rendering.mjs scaling
node scripts/check-rendering.mjs
```

The baseline Activity fixture suppresses its new assertions to collect timings
through the old missing-history and hidden-timer behavior. The updated fixture
asserts the exact oldest task title and that the active task remains reachable.
