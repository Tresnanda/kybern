# Whole-app memory follow-up — 2026-09-18

## Acceptance workload

The target is 200–300 MB for one ordinary Kybern window and its daemon plus
WebContent, GPU and Networking services. Measurements below use physical
footprint in MiB (300 MB ≈ 286 MiB), not RSS or JavaScript object estimates.
Totals sum per-process physical footprints; they are not a measurement of unique
physical RAM. Provider processes, WindowServer and unrelated applications are excluded.

Use a release Tauri build at 1440×900 logical pixels on Apple M1, macOS 27.0,
with the normal window configuration, default opaque surface preference and
production CSP. The scratch Appearance UI confirmed translucency was off. Seed 400
saved turns and 800 tool calls, open the saved thread, then run the offline
Claude-shaped driver producing 64 canonical results (~75.5 million UTF-16 code
units). Sample the exact application resource coalition every 500 ms; retain
process start identities and validate all output contents. No forced GC,
reload, removed content or reduced material is used to obtain a saving.

Scratch data must live outside a Git worktree. An initial run stored the data
inside this repository, so checkpoint discovery included the benchmark SQLite
files. That run (850 MiB peak) is discarded. The seed script now rejects this
layout. The clean baseline still reproduced 842 MiB, without checkpointing the
database. The installed window was closed normally for the run and reopened
afterward; its original daemon remained running with the same start identity.

## Changes

- Completed recoverable tool streams join canonical output in the existing
  8 MiB/12-entry inactive-result budget. Open consumers retain their own leases.
  Only real persisted completions advertise recovery; failed turns without a
  final tool event retain their streamed text. Exact streams can be reloaded
  for the original invocation and snapshot, even
  when provider call IDs are reused. New capability markers and explicit
  snapshot opt-in preserve old-daemon/client behavior; a missing advertised
  stream is an error, not silently replaced with empty text.
- Automatic title eligibility no longer loads every event and tool result
  after each completed turn; it queries only the first-turn metadata needed
  to decide whether title generation applies. Threads with multiple turns do
  not deserialize even the first prompt. Completion recovery checks use the
  existing completion index and only probe streamed rows in the requested page,
  avoiding a scan of historical canonical result payloads.
- Compact replay reads large output as borrowed raw JSON from SQLite rather
  than allocating the full output Value before discarding it. Complete stored
  events and default full subscriptions remain available.
- Resting dock panes no longer request permanent opacity/transform layers.
  Their transitions, mounted hidden terminal sizing and focus behavior remain.
- Live work lists rely on their existing per-item paint hosts; the growing
  parent no longer requests a tiled compositing layer around those hosts.
  Native motion, geometry and virtualization checks pass with frame p95 18 ms.
- The notification bell uses a 6 px dot: blue completed, yellow pending/blocked,
  red failed, with no outline.

## Whole-app result

The first candidate (`45b351eb`, isolated release source `e6fcb18b`) measured
275.9 MiB before the burst, 712.0 MiB peak and 321.8 MiB at +60 seconds.
The output hash matched the baseline exactly. This is an intermediate result,
not acceptance of the 200–300 MB target. At peak, WebContent held 612.5 MiB
and the daemon 27.2 MiB. A second diagnostic burst exposed 708.5 MiB resident /
321.0 MiB dirty graphics allocations, with 60 full 4 MiB tiles retained after
the burst. The remaining spike is predominantly graphics backing allocation.

Removing the live-list parent layer alone (`44e6b5d4`, isolated source
`0ed62563`) was insufficient: 280.6 MiB before, 750.6 MiB peak and 360.2 MiB at
+60 seconds. Its WebContent peak was about 579 MiB; the combined peak included
a brief 121 MiB daemon spike at turn completion. Contents still matched. Do not
present this isolated change as a demonstrated whole-app memory saving.

The paged-history status row was the missing painted leaf. It rendered
“Scroll up for earlier messages” directly into the scrolling surface. Hosting
that small row (`798b02d5`) lets the large scroller remain unpainted. A quiet
native A/B at 1440×900 with 400 saved turns/800 tools and the same 64-result
burst isolated only that status-row host:

| WebContent measurement | Unhosted status | Hosted status |
| --- | ---: | ---: |
| Initial loaded history | 149.1 MiB | 113.2 MiB |
| Closed results | 338.1 MiB | 147.0 MiB |
| Lifetime peak through closed results | 456.8 MiB | 185.6 MiB |
| Graphics resident | 436.5 MiB | 115.5 MiB |
| Graphics dirty | 195.2 MiB | 61.2 MiB |
| Graphics regions | 318 | 177 |
| WebKit Malloc resident | 120.1 MiB | 119.2 MiB |

The hosted run rested at 124.8 MiB afterward. Both runs delivered 64 distinct
completion sequences; compact event payloads retained 512 bytes. In the hosted run, exact Unicode
output was verified through RPC after the closed-results measurement. The
control completed the comparable memory marks and event checks, then failed
to reach the newest row in an unrelated two-pane hydration step. That raw
failure is retained; the final history-mode fixture uses direct RPC recovery
after measuring. Full
shared-pane UI hydration is covered separately by the tool-leases fixture.
The native history fixture uses scratch data outside Git and opaque surfaces.
Raw logs and vmmap summaries are preserved locally under
`perf-artifacts/daily-ram-followup-20260918/earlier-status-*`. Reproduce with
`KYBERN_PERF_LIVE_HISTORY=1` at 1440×900; add
`KYBERN_PERF_EARLIER_STATUS_UNHOSTED=1` for the exact-row control.

The final combined release (`50049f6f` in the isolated build, equivalent production
changes through root `7df9bb5a`) measured:

| Full application physical footprint | Baseline | Final candidate |
| --- | ---: | ---: |
| Loaded history before burst | 277.4 MiB | 256.0 MiB |
| Burst peak | 842.0 MiB | 433.8 MiB |
| 60 seconds after burst start | 358.7 MiB | 282.9 MiB |

The peak fell 48.5%. The +60-second observation is approximately 296.7 decimal
MB, within the requested 200–300 MB settled target. The burst peak remains
above that target. At the candidate peak, WebContent accounted for 333.1 MiB,
the daemon 27.0 MiB, shell 35.0 MiB, GPU 32.0 MiB and Networking 6.7 MiB.
A second identical burst followed by switching to another thread and back
peaked at 436.4 MiB; its final immediate-after-switch sample was 298.1 MiB,
which is not an idle measurement. Both turns preserved all 64 outputs with
the same hash as the baseline. These two bursts do not establish multi-hour
stability or a hard ceiling.

Raw coalition samples, phase markers, output checks, build log and vmmap
summaries are retained in `perf-artifacts/daily-ram-followup-20260918/history-*`.
The candidate and scratch daemon were stopped afterward and the installed app
was restored; the production daemon was never restarted.

Clean pre-compact release baseline: 277.4 MiB before the live turn, 842.0 MiB
peak, 358.7 MiB at +60 seconds. At peak, WebContent accounted for 696.5 MiB,
the daemon 71.0 MiB, shell 30.9 MiB, GPU 34.2 MiB and networking 9.4 MiB.
All 64 complete outputs remain in SQLite. Their ordered canonical JSON SHA-256
is `a21f696d1bb18c27187ebca23612b92530be1597a2a2f8382b9c3783efc30c8e`.

The baseline is the preserved release bundle from the earlier whole-app report,
not an equal-commit feature toggle. Attribute any comparison to the full change
set, rather than assigning all savings to one optimization. A multi-hour mixed
session and arbitrary image/stream/input sizes are separate workloads.

## Remaining full-app overhead

A final native fixture uses production `ThreadView`, including its header,
composer, measured bottom inset, a 256 px sidebar offset and the actual
`ThemeProvider`/`applyAppearance` opaque tokens. With the same saved history and
64-result burst, WebContent peaked at 200.7 MiB, closed results measured
163.2 MiB, and the later idle mark measured 129.9 MiB. All 64 unique completions,
512 retained compact-event bytes and exact output hydration passed. Graphics
resident/dirty were 115.8/62.0 MiB; WebKit Malloc resident/dirty were 140.7/96.0 MiB.

This adds 15.1 MiB to the Transcript-only fixture peak of 185.6 MiB. It does
not reproduce the release app's 333.1 MiB WebContent peak, so there is no evidence
for another composer/header paint change. The broader application shell,
initialization, loaded modules and runtime state remain candidates for a future
controlled comparison; their individual contributions have not been isolated.
Reproduce with `KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_HISTORY=1` at
1440×900. Raw evidence is in `perf-artifacts/daily-ram-followup-20260918/full-thread-themed-*`.

## Hidden dock layers: isolated native evidence

Four alternating native WKWebView runs used the same 1100×720 opaque fixture,
one active Agents pane, then six mounted panes with five inactive. The five
inactive panes stay mounted, including the terminal. Each sample follows a
500 ms settle. These are WebContent-only observations, not whole-app totals.

| State | Permanent layer hint | Without resting layer hint |
| --- | --- | --- |
| One panel, two runs | 141.9 / 144.7 MiB | 141.5 / 147.4 MiB |
| Six panels, two runs | 146.2 / 146.2 MiB | 128.3 / 127.7 MiB |
| Graphics resident, six panels | 101.2 MiB | 82.8 MiB |
| Graphics dirty, six panels | 65.8 MiB | 47.4 MiB |
| Graphics regions, six panels | 89 | 86–87 |

The steady six-panel reduction is 17.9–18.5 MiB. WebKit Malloc remained about
80–81 MiB resident / 62 MiB dirty. Startup lifetime peak ranges overlap, so this
is evidence for accumulated hidden-pane layers, not a lower application peak.
Normal native panel-switching/reopen/focus/terminal-shape checks passed.
Reproduce with `KYBERN_COLLAB_VIEW=dock-memory` and the `chat-collaboration`
rendering fixture. The comparison restores the old `.t-pane` will-change hint
for the baseline only.

[WebKit Layers documentation](https://webkit.org/web-inspector/layers-tab/)
explains the memory cost of compositing layers. [WebKit memory inspection](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/)
distinguishes decoded images from layers and tile grids. Do not demote the
transcript paint hosts: their small layers are the tested defense against large
scroll-tile accumulation. Image-heavy workloads need separate decoded-image
measurements before changing image behavior.

## Validation

Desktop: 255 tests, typecheck and lint passed. Mobile: 110 tests, typecheck and
Android/iOS exports passed. Rust: 326 library tests passed (two intentionally
ignored), nine protocol schema tests, workspace formatting and focused Clippy
passed. Native production-CSP checks passed for notifications, dock switching,
materials and real-RPC tool leases. The lease fixture verifies 17 distinct
results across two panes, an exact 5.25-million-character Unicode stream, shared
requests, oversized-stream eviction, close/reopen and reconnect recovery.

The macOS materials fixture now accepts both
empty-string and `none` for the absent pseudo-element backdrop filter; actual
surface blur, opaque fallback, focus and menu actions remain asserted.
