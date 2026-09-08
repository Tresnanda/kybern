# Mobile streaming cadence — 2026-09-09

The mobile client previously displayed provider bursts after the existing 32 ms
store notification batch. It now paces the changing assistant text through a
short adaptive buffer. Completed paragraphs have memo boundaries that retain
native text and horizontally scrolled tables. The first mounted content and
completed response appear immediately. Replacement text, reduced motion,
backgrounding and offscreen rows bypass the reveal; no idle frame loop remains.

## Reproducible cadence check

Run `node --experimental-strip-types perf/stream-replay.mjs` in `apps/mobile`.
The fixture delivers 120 characters every 250 ms for 15 seconds, drives the real
reveal function with a synthetic 60 Hz clock, and publishes at 32 ms intervals.
It includes the first-chunk immediate display. The pre-change comparison displays
each arrival in full. All input is synthetic prose with Markdown delimiters.

Measured on Apple M1 / arm64, Node 24.15.0:

| Display cadence | Before | Paced |
| --- | ---: | ---: |
| Updates during streaming | 61 | 444 |
| Characters per update, p95 | 120 | 27 |
| Largest update (including first chunk) | 120 | 120 |

The final simulated arrival leaves 160 characters buffered; completion flushes
them immediately, yielding all 7,320 received characters. This explicitly trades
more small display updates for less bursty delivery. It is not a measurement of
React commit duration, frame intervals, input latency, CPU, GPU or energy, and
does not establish a frame-rate guarantee. Provider waiting time is unchanged.

## Native verification

A Release build ran in the iPhone 17 Pro simulator on the M1 host. A real Claude
response through a scratch daemon produced 4,810 characters, six headings, one
TypeScript fence and a table, and completed in 30.386 seconds. The native UI
displayed the final `Streaming check complete.` marker, code/table formatting,
and copy controls. Scrolling back exposed Latest; Latest returned to the final
response. A 30 fps screen recording was inspected for progressive delivery and
follow behavior, not used as a frame-time benchmark. No tools or file changes
were requested from the agent.

The 20 mobile tests and TypeScript check passed, including monotonic replay,
bounded backlog, exact Unicode completion, and native terminal input edits.
Terminal typing was checked against a real PTY with Return and a fast sequence;
input RPCs are serialized so daemon dispatch cannot reorder characters. The
terminal canvas uses the application theme and fits its measured viewport.

No desktop source changed in this pass; desktop WebKit fixtures do not exercise
the native React Native renderer. Large-message parse cost remains proportional
to message length, and sustained device/energy measurements remain separate work.
