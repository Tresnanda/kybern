# Chat file links and earlier history

Chat Markdown previously sent relative file links to the OS URL opener, which
rejected names such as `2026-09-10-hermes-prompt.md`. Desktop and mobile now
resolve file links through `threads.files.read` on the connected daemon, using
the conversation workspace (including worktrees). Absolute paths must remain
inside that workspace after canonicalization. Existing exclusions and byte
limits apply; symlink escapes are rejected. HTTP and mail links retain their
external behavior.

Previews support Markdown, source text, nested relative links, encoded spaces,
and line references. Missing files show a retryable error. Connected computers
need daemon v0.3.5 or newer; older daemons receive an actionable update message.

Initial hydration remains 60 transcript entries. Scrolling within two viewport
heights of the beginning requests 120 earlier entries. Each cursor gets one
automatic attempt; a failed page waits for Retry. No new scrolling animation or
polling loop was added. Existing sequence bounds, live-event replay, stable
identities, virtualization, and prepend anchoring remain in place.

## Verification

2026-09-10, Apple M1, macOS 27, native WebKit under the production CSP:

- Artifact fixture passed bare and absolute file paths, spaces, `file://`,
  Markdown formatting, source previews, nested links, failures and retry in
  light and dark themes. The fixture asserts the connected thread and ensures
  file links never call the external URL opener.
- History fixture: 200 turns / 600 blocks, 60 initially loaded, 120-entry pages,
  simulated 250 ms requests, one failure and retry. Six page requests including
  the retry; maximum measured anchor displacement 0.672 px; eight mounted
  message rows at the final bounded-history assertion. Prefetch commonly began
  1,080 px from the start in a 720 px viewport.
- Existing transcript interaction fixture passed navigation, focus, selection,
  history prepends, following, and bounded expanded tools.
- Real WebSocket daemon integration tests cover thread-local reads, normalized
  paths, spaces, truncation, binary files, missing/excluded files, wrong-host
  thread IDs, outside paths, and symlink escapes.

On the iPhone 17 Pro iOS 27 simulator with Expo Go 57, a 100-turn synthetic
conversation opened a Markdown preview and nested `docs/My File.ts:12` through
the thread RPC. Scrolling fetched two 120-entry pages after initial hydration
without button taps. Missing-file errors and explicit retry were also checked;
the server recorded a second read only after Retry. Light-mode history and
dark-mode file previews remained readable. This is simulator functional evidence, not physical-device
frame, energy, or Android native performance evidence.

## Transport measurement

One local WebSocket run with 2,000 entries of roughly 6 KB each:

| Request | Elapsed | Serialized response |
| --- | ---: | ---: |
| 60 entries, cold | 321.95 ms | 393,623 B |
| 60 entries, warm | 17.36 ms | 393,623 B |
| 120 entries, warm | 33.73 ms | 786,623 B |
| Full history, warm | 556.82 ms | 13,098,380 B |
| 60 entries, warm repeat | 17.22 ms | 393,623 B |

Larger pages reduce round trips while prefetch starts before the reader reaches
the boundary; individual page RPCs are not faster. These single samples are
local transport measurements, not WAN, CPU, commit, frame, input, or energy
measurements. The initial payload remains unchanged.
