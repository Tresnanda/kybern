# Daily-use memory investigation — 2026-09-18

## Target and measurement contract

The requested target is 200–300 MB for daily use. Track physical footprint for
one application window plus its daemon, WebContent, GPU and networking services.
Keep external coding-agent processes, additional environment windows, build
processes and WindowServer separate. Report MB versus MiB explicitly (300 MB is
about 286 MiB). A fixture measuring only WebContent cannot establish that target
for the whole application. No claim of an unconditional RAM ceiling is made.

Measure settled use and transient peaks separately. A bounded JavaScript cache
does not bound the browser heap, incoming message queue, decoded images or GPU
backing stores. A renderer can return to a small retained state after first
allocating hundreds of megabytes.

## Evidence and primary-source research

- [WebKit memory inspection](https://docs.webkit.org/Infrastructure/MemoryInspection.html)
  describes physical footprint and its dirty/reclaimable categories. Use native
  process evidence rather than JavaScript object estimates alone.
- [WebKit memory debugging](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/)
  separates JavaScript, decoded images, layers and other page allocations. This
  explains why cache budgets alone did not solve the earlier reported peak.
- [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
  documents the classic API's lack of receiving backpressure. Avoid sending
  recoverable hidden data in the first place; moving the same data to another
  JavaScript queue does not solve the peak.
- [Apple reducing memory use](https://developer.apple.com/documentation/xcode/making-changes-to-reduce-memory-use)
  recommends scaling images to their displayed size and avoiding full-size
  decode intermediates. Preserve originals for explicit viewing/copy/download.
- [WebKit power guidance](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)
  connects allocation churn with collection and JIT work. Memory changes need
  responsiveness checks; frequent forced cleanup is not a free optimization.

A read-only observation of the installed application during this investigation
found WebContent at 588 MiB, shell 44.5 MiB, GPU 36.5 MiB and networking 8.7 MiB.
The existing daemon is in a different launch coalition, so this is explicitly
not a complete application total. A subsequent WebContent vmmap showed 587 MiB
current / 993.5 MiB lifetime peak, 376.5 MiB allocated in the WebKit malloc zone
and 125.7 MiB dirty owned graphics. Those categories overlap process accounting;
do not add them to the footprint. This is an uncontrolled observation of the
installed build, not a before/after comparison with this branch.

## Implementation and measurements

### Changes in this branch

`events.subscribe` accepts optional `include_tool_output:false`. The desktop
opts in; omitted/true preserves the old full-event stream for CLI, mobile and
older clients. Results above the existing 2 KiB serialized JSON threshold are
represented by `output_omitted:true` in live delivery and replay. The original
SQLite event remains complete. Size checks count JSON structure/escaping and
stop as soon as the threshold is crossed, including large arrays of empty
containers. No full output clone or serialization is needed to construct the
compact notification.

The shared projection marks those results hydratable. Existing sequence-bound
`threads.tool_output` requests and mounted-result leases preserve exact content,
reused call IDs, concurrent consumers and reconnect behavior. Visible generated
image deliverables acquire their own lease and hydrate without requiring users
to expand tool details; a native light/dark regression verifies decoded content
and lease cleanup on unmount.

Assistant settlement also avoids a joined stream copy and two code-point
arrays. See [the reproducible allocation experiment](assistant-settlement-memory-2026-09-18.md).
That unusually large 8-million-character synthetic correction reduced Node heap
growth from 152.60 MiB to 22.91 MiB; it is not an ordinary whole-app percentage.

### Native paired results

The real-RPC `live-tool-memory` fixture sends 64 completion-only results
(75,498,496 UTF-16 content units), opens the first result in two panes, checks
exact Unicode text and one shared hydration request, then closes it. Both modes
use the same current debug daemon and production frontend under the production
CSP; only `include_tool_output` differs. This isolates transport/projection work,
not a comparison against a prior release or the full Tauri application.

Runs are serialized in full → compact → compact → full order on Apple M1,
macOS 27.0 (26A428), system WebKit. The accessory test window reported
`document.visibilityState === "hidden"`. Default background scheduling suspended
its timers and caused incomplete runs; those are discarded. Completed runs use
`KYBERN_PERF_KEEP_ACTIVE=1`, an opt-in test-only
[WKPreferences.inactiveSchedulingPolicy](https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.property)
setting. The shipped app retains its normal scheduling policy. These are
unattended renderer allocation measurements, not visible-window graphics,
interaction timing, CPU/energy, or whole-application results.

Physical footprint in MiB, WebContent only:

| Run order | Mode | Startup | Closed results | Shared result open | Post-workload idle | Lifetime peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Full | 75.3 | 246.3 | 312.3 | 274.2 | 379.1 |
| 2 | Compact | 75.8 | 105.5 | 236.0 | 130.3 | 246.5 |
| 3 | Compact | 75.9 | 105.2 | 238.0 | 131.8 | 247.5 |
| 4 | Full | 75.7 | 247.4 | 318.0 | 137.3 | 369.6 |

Both compact runs delivered zero closed canonical payload characters, versus
75,498,496 in each full control. Both still hydrated the requested result once
for two consumers, rendered exact Unicode content, and retained the surviving
pane's content when its sibling closed. All four runs passed. Closed-result
footprint dropped about 141 MiB, and lifetime peak dropped 122–133 MiB in these
runs. Idle physical footprint is allocator-sensitive: the repeated full control
scavenged to 137.3 MiB, so the first control's 274.2 MiB is not a dependable
settled-use baseline. No whole-app percentage or RAM ceiling follows from this.
The compact transcript retained only 512 estimated bytes of null placeholders
at the closed-results checkpoint, versus 7,078,754 estimated bytes in full mode;
these estimates are separate from native physical footprint.

Reproduce from `apps/desktop` with a separately built scratch daemon:

```sh
KYBERN_PERF_KEEP_ACTIVE=1 \
KYBERN_PERF_DAEMON_BINARY=/absolute/path/to/target/debug/kybernd \
KYBERN_PERF_MEMORY_DIR=/absolute/path/to/artifacts/compact \
node scripts/check-rendering.mjs live-tool-memory
```

Add `VITE_LIVE_TOOLS_FULL_EVENTS=1` for the full-event control. The fixture owns
and removes its scratch data directory; it never connects to the installed app.
Raw vmmap snapshots are local artifacts, not repository fixtures.

### Remaining retention and priorities

1. Large prior tool output deltas remain exact and can remain resident after
   completion. Compact canonical output cannot prove equivalence with a distinct
   fallback stream or an agent receipt. A safe follow-up needs sequence-bound
   persisted stream retrieval or an explicit equivalence signal; blindly
   discarding those streams loses content. The completion-only burst below does
   not measure that path.
2. Large active tool inputs remain available in full for summaries/details.
   Add lazy input retrieval before claiming a bound for arbitrary giant edits.
3. Graphics layers remain a major part of the installed observation. Earlier
   paint-host promotion fixed multi-gigabyte tile accumulation. Demoting layers
   while hidden/idle is an experiment requiring a native graphics A/B, not a
   safe assumption or an implemented saving here.
4. Inactive transcript/diff retention (16 MiB), canonical inactive outputs
   (8 MiB/12 entries), Markdown/highlight caches and worker idle teardown already
   exist. Preserve these. Environment-store LRU is lower priority for one
   environment because switching already compacts heavy data; it needs pending
   question/draft/terminal restoration coverage before adoption.
5. Driver readers and output channels are commonly bounded by 1,024 events,
   not bytes. Large messages can still create a large transient working set.
   A follow-up should budget bytes and define cancellation/lag recovery end to
   end. Simply shrinking or blocking the client notification channel can
   deadlock RPC replies behind notifications; preserve control-message progress.
6. Native image viewers and multiple simultaneously open windows have separate
   working sets. Thumbnail URLs and image bitmaps are released; decoded image
   usage still needs a dedicated image-heavy run.

### Notification polish

The bell uses a plain filled dot and a two-command right-click menu: Show
notifications / Show all threads and Dismiss completed. Managed child success
is excluded from completion alerts and stale unread indicators. Child failures
and requests for user input still receive attention. Dismissing completion
notifications does not answer or hide live approvals/failures.


## Validation

- Desktop: 249 tests, TypeScript check, ESLint and production frontend build.
- Rust: 322 library tests passed across daemon, drivers, protocol and store;
  two daemon tests intentionally ignored. Nine protocol schema tests passed.
  Clippy passed for CLI, daemon, drivers, protocol and store; workspace fmt passed.
- Sidecar-aware `pnpm tauri build --debug --no-bundle` passed. No installation,
  release, restart or replacement of the user's running app/daemon occurred.
- Mobile shared-client coverage: 110 tests and TypeScript check passed;
  Android and iOS production exports passed.
- Native production-CSP `chat-fixes`: light/dark generated-image hydration,
  decoded gallery content with closed tool details, and lease cleanup passed.
- Native `live-tool-memory`: four serialized full/compact runs passed exact
  output and shared hydration checks, with the scheduling limitation above.
- Notification fixture checks the plain dot, two menu commands, dismissal,
  stale child completions and project activity states.

## Remaining acceptance work

A repeatable 200–300 MB daily-use acceptance run should include a saved long
thread, real live tool results, switching between threads and split panes,
scrolling both directions, opening/closing tool results, image attachments and
viewer, a terminal, then 30/120-second idle observations. Repeat in fresh
processes in alternating baseline/candidate order with identical window size,
material and content; keep compilers and other fixtures out of the measurement.
Also run a multi-hour soak. Track exact content, focus, reading position and
formatting alongside memory. No destructive reloads, forced GC, hidden content
or disabled materials count as savings.

Outstanding workloads cannot be reduced to a universal 300 MB guarantee:
multiple native windows each own browser services; explicitly opened very large
results and original images have real working sets; terminal scrollback and
provider processes are independent; WebKit allocator/graphics release timing is
not controlled by Kybern. The defensible product target is a stated ordinary
workload with measured bounds and regression tests, plus graceful handling of
larger work.
