# Memory implementation and before/after

Implemented on `codex/desktop-rendering-windows-memory`, following the
[initial RAM/Synara audit](memory-synara-2026-09-07.md). The comparison baseline is
`bee4fdc` (the first round of table, image-layout, window and discovery-cache fixes).
The after version contains the larger retention and allocation changes below.

## Results

Three alternating fresh processes per version on the same Apple M1, 16 GiB,
macOS 27.0 machine. Values are median **physical footprint in MiB**, sampled with
`vmmap -summary`, not JS heap or whole-app RSS. Raw stage records and all three
samples are in [samples.json](memory-results/samples.json) and
[summary.json](memory-results/summary.json).

| Isolated workload stage | Before | After | Change |
| --- | ---: | ---: | ---: |
| Renderer startup | 36.7 | 37.1 | +1.1% |
| Renderer: 24 background streams | 77.1 | 62.8 | −18.5% |
| Renderer: after visiting 16 large histories | 119.2 | 84.8 | −28.9% |
| Renderer: after changing environment | 86.5 | 44.4 | −48.7% |
| Renderer: after warming workers, then 35 seconds idle | 133.9 | 47.6 | −64.5% |
| Daemon: slow subscriber, 2,048 × 32 KiB events | 74.5 | 10.3 | −86.2% |
| Daemon: after drain and durable replay | 74.7 | 11.6 | −84.5% |

These are workload-specific comparisons, not a promise that the installed app
will use 65–86% less RAM. Visible histories, drafts, pending questions, terminals,
WebKit rendering surfaces and active agents still use memory. The native fixture
uses real production stores and workers, but no full transcript DOM, Tauri shell,
GPU accounting or agent process tree. Worker-idle measurements also include the
earlier environment/cache changes; they do not isolate worker savings alone.
No explicit GC was forced. Allocator reuse, compression and background compilation
can affect readings. Three runs establish repeatability, not a confidence interval.
Startup footprint did not improve for the renderer.

Deterministic retention checks explain the direction of the measurements:

- Background transcript text: 24 MiB characters before, zero after.
- After history visits: 56 MiB characters before, 8 MiB after (visible data plus
  inactive entries that fit the conservative 16 MiB estimate).
- After changing environment: 56 MiB characters before, zero after.
- Slow event bus: 2,048 retained events before, 126 after. **All 2,048 events
  recovered from SQLite in every run.**

Character counts are not allocator bytes: WebKit can store ASCII strings in one
byte, while the retention policy conservatively budgets two bytes per character.

## Implemented behavior

- Background events update controls, metadata and sequence cursors without
  concatenating assistant text or copying tool output. Opening a thread fetches
  its authoritative history. An 8 MiB/2,048-event snapshot bridge reapplies live
  events newer than the snapshot and retries fresh snapshots on overflow.
- Inactive transcript/diff data has a combined 16 MiB estimated budget. Visible
  split panes remain pinned. Environment changes and runtime disposal release
  reconstructible caches; drafts, queued messages, pending questions/approvals
  and terminal identity remain. Late snapshot/diff/provider replies cannot refill
  a disconnected environment. Handoff hydrates evicted history before using it.
- Historical diff summaries load with mounted turns instead of prefetching every
  checkpoint; inactive completion no longer loads both diff summaries.
- Event broadcasts retain at most 8 MiB estimated payload and 8,192 events;
  terminal broadcasts retain at most 2 MiB and 4,096 chunks. Lag is explicit and
  uses existing durable-event replay / terminal-scrollback recovery. Scrollback
  remains 512 KiB. Oversized event payloads bypass retention but remain durable.
- WebSocket output holds byte permits through the socket write, with an 8 MiB
  serialized budget, 64 queued frames and 16 concurrent request producers.
  A single oversized history response may use the entire budget without truncation.
  Saturated request producers receive a retry error. A stalled enqueue closes
  the connection after 30 seconds so clients can reconnect and replay. In-flight
  responses and visible histories are deliberately not a hard global RAM cap.
- Markdown estimates include AST data. Markdown and highlighting workers and
  their caches release after 30 seconds without queued work, and recreate on
  demand. All native runs successfully parsed and highlighted again after idle.
- Authenticated local-image previews decode into at most 560 × 352 PNG pixels,
  preserve aspect ratio/alpha/orientation, and never upscale. Full originals are
  fetched only when the viewer opens, and their blob URLs are revoked on close.
  PNG/JPEG/GIF/WebP previews are supported (animated formats use a static preview).
  AVIF or images outside preview limits retain an explicit Open original action.
  Preview decode limits are 16 megapixels, 8,192 pixels per axis, 96 MiB decoder
  allocation estimate and two concurrent decodes. Originals retain their existing
  50 MiB file limit. Remote/base64 image sources are unchanged.

## Reproduction

The detached baseline worktree is `/Users/mymac/projects/kybern-memory-before`.
Only the measurement harness was copied into it; production source is `bee4fdc`.
The after checkout is `/Users/mymac/projects/kybern-desktop-audit`.

```sh
cd apps/desktop
python3 scripts/compare-memory.py /absolute/before /absolute/after
```

Copy `perf/memory.html`, `perf/memory.ts`, `scripts/check-rendering.mjs` and
`scripts/check-rendering.swift` into the baseline and install frontend dependencies.
Append only `memory_broadcast_fixture` from `remote_tests.rs` to its baseline copy.
The fixture uses the old event-folding path when `receiveEvent` is absent.

The renderer streams 64 × 16 KiB unique materialized strings to each of 24 inactive
threads, visits 16 histories of 2 MiB each, changes environment, warms six grammar
languages plus Markdown, waits 35 seconds, then verifies worker reuse. Each stage
waits for native measurement acknowledgment. The native runner obtains only its
own WKWebView process ID through a private diagnostic selector; this code never
ships in the app. The daemon fixture initializes AppState and SQLite in a fresh
temporary directory, holds a slow subscriber, appends/broadcasts 64 MiB of payload,
then verifies replay. No live coding provider is started by either fixture.

## Verification

- 100 frontend tests pass, including actual runtime snapshot/live-event races,
  navigation/disconnect during hydration, retention, pending controls and split panes.
- Frontend typecheck, lint and production build pass. Existing Vite chunk-size
  and mixed static/dynamic import advisories remain.
- Workspace Rust tests excluding live driver integrations pass; driver library
  tests pass separately (49). The daemon suite passes 84 tests, with the manual
  memory fixture ignored by default. Schema snapshots are unchanged.
- Clippy passes across the workspace and all targets with warnings denied;
  workspace formatting passes.
- Recovery tests cover oversized durable events, bounded replay batches, output
  permits held through writer consumption, canceled waiters and terminal byte-lag
  recovery. HTTP tests verify preview authentication/path boundaries, all four
  preview formats and unchanged original bytes.
- Native memory fixtures pass six times, including parsing/highlighting after
  idle. Final native rendering, scaling, interaction and artifact checks all pass.
  Rendering retains 30/30 code blocks with exact final output and 17 ms sampled
  streaming frame p95. The 401-turn scaling fixture retains 8 mounted messages,
  finishes its stream exactly, and passes input responsiveness (16 ms p95).
  These timing checks are regression observations, not before/after timings.

The installed shell PID 10211 and daemon PID 10667 still have their original
09:51 launch times. Production Kybern and its data were neither restarted nor
modified. There was no packaging, deployment or merge.
