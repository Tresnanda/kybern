# Single-window memory follow-up — 2026-09-24

## Why this pass

Issue #33 targets extra environment windows. It cannot explain high memory with
one window. This pass measures the installed one-window session and tests a
separate single-window tool-result change against native WebKit controls.

## Read-only installed-app observation

Apple M1, macOS 27.0, installed Kybern v0.4.17 after about one hour of use.
`vmmap -summary` physical footprints, MiB:

| Process | Current | Lifetime peak |
| --- | ---: | ---: |
| WebContent | 383.0 | 528.2 |
| Desktop shell | 34.5 | 35.5 |
| Daemon | 25.7 | 60.8 |
| WebKit GPU | 33.5 | 58.4 |
| WebKit Networking | 8.7 | 10.4 |

The **current process-sum is about 485 MiB**. The per-process lifetime peaks
did not necessarily occur together and must not be summed as a simultaneous
peak. External provider processes and WindowServer are excluded. This is a
read-only observation, not a before/after result for this branch. A second
WebContent sample was 379.1 MiB current with the same 528.2 MiB lifetime peak.

At the first sample WebContent had about 259 MiB dirty WebKit Malloc and 88 MiB
dirty owned graphics. Image IO had no resident pages. These regions are parts
of the footprint, not additional memory to add to it. About 12 minutes later,
while this long chat continued, the same WebContent process measured 443.1 MiB
current with the same 528.2 MiB lifetime peak. This is an uncontrolled active
session, so the 60 MiB difference is not evidence of an idle leak. The current session's
excess over the deterministic live-tools fixture is more associated with
renderer allocation than with decoded images; `vmmap` cannot identify which
JavaScript objects or DOM nodes are retaining those pages.

## Native fixture attribution

The production-CSP scrolling fixture on the current branch before the
single-window change peaked at 385.9 MiB WebContent. It ended at 231.0 MiB;
the eight stages include fast history, mixed work, streaming, expanded work and
long code. The full-shell `live-tool-memory` fixture uses a 1440×900 opaque
window, 400 saved turns, 800 tools, and 64 live canonical Read results from a
scratch daemon. It measured 256.8 MiB WebContent lifetime peak and 159.1 MiB
after the workload. It verifies all 64 outputs remain recoverable and exact.
These fixtures omit the Tauri shell process and do not reproduce the installed
app's one-hour renderer allocation. Later repeats of the same full-shell
closed-result fixture ranged from 273.4 MiB on the control source to 276.1
and 298.5 MiB on the open-result candidate. The open-result change is outside
that closed-result path; these noisy peaks provide no evidence of a general
single-window peak reduction.

The existing store/worker fixture rose from 37.0 MiB startup to 95.8 MiB after
loading histories, returned to 42.9 MiB when switching environment, and to
37.1 MiB after workers idled. That path releases reconstructible data in the
fixture. It does not prove the mounted one-window React tree has the same floor.

Three proposed paint changes were tested in a full-shell WebKit A/B and
discarded:

- PR #40's chat-seam strip reached the same 265.1 MiB peak as its same-build
  full-seam control.
- PR #41's unhosted turn wrapper measured 260.2 vs 266.0 MiB in one pair, then
  255.2 vs 255.5 MiB in the next. The scrolling fixture's fast-history peak
  moved in the opposite direction (333.3 to 344.7 MiB). No repeatable saving.
- PR #49's unhosted answer measured 261.7 MiB peak vs 249.6 MiB with its old
  answer host in the same build. It was worse in this workload.

These experiments are not retained in the branch.

## Open tool-result measurement

PR #65 addresses a different single-window peak: opening one 6,000-row JSON
`ToolResult` used to mount its entire formatted output in a `max-h-72` `<pre>`.
The native `tool-memory` fixture has 20 distinct 6,000-row results; it opens
one, checks exact source and selection, scrolls to the last row, closes it, and
samples `vmmap` at each stage. Each run uses a fresh WKWebView at 1100×720 with
the production CSP. The old and new versions ran serially on the same M1; no
forced GC or reload is used within a run.

| Run | Closed-results current | Open-result lifetime peak | After closing current |
| --- | ---: | ---: | ---: |
| Full `<pre>` 1 | 161.0 | 210.5 | 182.7 |
| Virtualized 1 | 160.1 | 174.1 | 177.2 |
| Full `<pre>` 2 | 163.0 | 224.5 | 199.0 |
| Virtualized 2 | 161.3 | 176.3 | 176.6 |
| Virtualized, copy correction | 164.4 | 187.2 | 186.6 |

All figures are WebContent physical footprint in MiB. The open-result lifetime
peak is 23–50 MiB lower across these runs. That is a workload-specific result,
not a 23–50 MiB saving for the ordinary settled app or the whole application.
Closed results stayed near 160–164 MiB. The copy correction changes selection
handling, not the virtualization path; its higher 187.2 MiB run shows allocator
variance and is retained rather than hidden.

The imported PR initially inferred "select all" by comparing selected text to
the mounted rows. That could replace a partial visible-row copy with the entire
result. The follow-up copies the full source only when the selection range
covers the scroller. The native fixture checks full-result clipboard content,
partial selection, last-row reachability, and bounded mounted text. The real
RPC `tool-leases` fixture checks exact 5.25-million-character deferred stream
source, virtualization in two panes, full-result copy, reconnect, and exact
ordinary-result native pasteboard copy.

## Repeated visible-shell turns

The full-shell fixture also ran three sequential 64-result turns in one visible
WKWebView without a reload or forced GC. The same scratch daemon produced 192
distinct compact completions; the first canonical output of each turn was
rehydrated and matched exactly. This is a repeated closed-result workload, not
a mixed multi-hour user session.

| Stage | Current WebContent | Lifetime peak |
| --- | ---: | ---: |
| Startup | 179.5 | 192.5 |
| Burst 1 closed / +5s | 240.2 / 162.8 | 262.2 |
| Burst 2 closed / +5s | 252.3 / 174.6 | 297.2 |
| Burst 3 closed / +5s | 257.7 / 165.7 | 297.2 |

Values are MiB physical footprint. The settled marks do not rise monotonically
over these three turns, while the second burst set a higher lifetime peak. This
fixture still does not reproduce the installed session's 379–443 MiB current
WebContent range. It leaves out long navigation, open results, terminals,
diagrams, images and the installed app's broader runtime history. Run with
`VITE_LIVE_TOOLS_BURSTS=3` plus the full-shell/history fixture flags.

## Visible-thread diff retention

The active thread could retain every completed turn's `threads.diff` summary.
The visible-thread cache now keeps 16 per-turn summaries plus the whole-thread
summary. A mounted older turn reloads its summary through the existing RPC
path. State tests cover the cap, eviction order, split panes, and unbounded
control. The native production-CSP full-shell fixture passed after this change
with 64 exact compact completions, but its scratch workspace is not a Git
repository and has no turn diffs. Its WebContent footprint (140.5 MiB at
startup, 206.9 MiB lifetime peak, 135.7 MiB after idle) is therefore a
regression check, **not** a measured saving from the diff cap. A Git-backed
long-thread A/B is still needed to quantify that saving.

## Remaining acceptance

The installed one-window session remains above the 200–300 MB whole-app goal.
The open-result change reduces a specific expansion spike, not the 383 MiB
settled WebContent observation. A next pass needs a long-session full-shell
profile that tracks mounted DOM, parsed/highlight worker state, dock panes and
active-thread snapshots alongside WebKit Malloc/graphics at fixed intervals.
Only a matched release Tauri run can establish a whole-app saving. The installed
app and its daemon were kept running because they host this session; all native
fixtures used separate WKWebView processes and scratch daemon data.
