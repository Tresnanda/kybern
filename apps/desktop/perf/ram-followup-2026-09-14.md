# RAM follow-up on latest main

Audited origin/main `437e09c` (v0.4.0), following issue #14 and merged PR #15.
This records the initial investigation and unchanged baseline. Implemented fixes
and their validation are in [the follow-up report](memory-reductions-2026-09-14.md).
The checkout is isolated; the installed app and normal daemon data were untouched.

## Native baseline

Ran `node scripts/check-rendering-memory.mjs` from apps/desktop. Apple M1,
16 GiB, macOS 27.0 (26A5416b), system WKWebView, production CSP, default
1100 × 720 fixture viewport. One fresh-process run, no forced GC, with normal
development activity continuing. Synthetic 160-turn history and 800-tool work
scenarios; this is not the two-hour ordinary-use workload in issue #14.

| Stage | Current physical footprint MiB | Lifetime peak MiB |
| --- | ---: | ---: |
| Cold history | 331.1 | 333.5 |
| Revisited history | 247.4 | 351.2 |
| Fast history | 390.1 | 421.8 |
| Mixed work | 530.7 | 766.1 |
| Mixed work streaming | 588.2 | 766.1 |
| Expanded thinking | 587.9 | 888.9 |
| Expanded tools | 538.3 | 888.9 |
| Long code | 355.2 | 888.9 |

Memory and rendering assertions passed. All 1,600 sampled frames were nonempty;
frame-interval p95 was 18–19 ms, worst frame 24 ms. Largest reported visible
anchor movement was 2.25px. Mounted nodes peaked at 1,669 in history and 810
in mixed work. These results preserve PR #15's graphics regression fix; they
do not establish a whole-app memory cap. CPU, React commit time, OS input latency,
energy, and the live application's process totals were not measured.

## Concrete follow-up opportunities

1. **Keep refreshes sequence-bounded after reading large histories.**
   `src/state/rpc.ts:219` derives the requested snapshot size from loaded blocks.
   Above 500 blocks it omits `transcript_limit`, requesting the entire transcript.
   A forced refresh/reconnect can therefore pull in history the reader never
   loaded. Replace this fallback with bounded pages at one snapshot sequence,
   retaining the reading anchor and replaying events arriving during hydration.
   Simply clamping to 500 would lose previously loaded reading context.

2. **Bound retained data in visible chats, including individual tool payloads.**
   `src/state/retention.ts` exempts visible/split threads from its 16 MiB inactive
   budget. `prependThreadHistory` in `packages/kybern-client/src/transcript.ts`
   merges pages without retiring distant pages; active streaming also adds data.
   Row virtualization bounds DOM, not all loaded transcript objects. Introduce
   reloadable data windows with sequence cursors, pinning the viewport, live turn,
   selection and actionable state. Row counts alone cannot bound multi-megabyte
   tool results. Fetch large settled results on demand with exact copy/export.
   This needs coordinated transport and state work, not only a CSS adjustment.

3. **Avoid preparing full collapsed outputs; bound expanded text rendering.**
   `ToolRow` in `src/views/Transcript.tsx:1191` computes output before checking
   disclosure state. `outputText` may recursively copy image-safe objects and
   pretty-print JSON. Expanded output is one full preformatted text node in a
   height-limited scroll box; its layout is not line-windowed. Move detailed
   formatting into mounted disclosure content, use a cheap exact availability
   check, and test very large wrapped outputs. A bounded viewer must preserve
   complete text access, selection, copying, search and scroll behavior.

4. **Remove redundant completed-tool streams when semantically safe.**
   `tool_call_completed` in the shared transcript projection stores the final
   output without releasing `stream`. Where the final result supersedes streamed
   text this retains both. Some results use the stream as a fallback, so clearing
   every stream is incorrect. Cover provider-specific output/fallback cases and
   compare live and hydrated projections before changing this shared path.

5. **Measure inactive terminal graphics resources separately.**
   Visited terminal tabs remain mounted with 5,000 lines of scrollback and a
   WebGL addon (`src/views/Terminal.tsx`). Hiding a tab does not dispose its
   renderer. Experiment with releasing inactive graphics resources while keeping
   the PTY, buffer and reading position. This is a candidate, not a measured cause
   of issue #14; the current scrolling fixture does not mount terminals.

6. **Avoid building full daemon history for a small page.**
   `ThreadsGet` in `crates/kybern-daemon/src/rpc.rs` loads all events through the
   snapshot sequence and builds a complete projection before selecting the page.
   `thread_projection.rs` bounds cached projections to an estimated 32 MiB and
   limits concurrent builds to two, but not the size of a single build. Persisted
   projection checkpoints or indexed transcript rows could reduce transient
   daemon memory and rebuild work. This cannot directly explain WebContent's
   footprint and should be benchmarked independently.

## Recommended order and acceptance

First reproduce the >500-block refresh and large collapsed/expanded tool outputs
with controlled fixtures. Fix those bounded cases, then implement reloadable
visible-history windows. Independently profile dense-work graphics: this baseline
still reaches 889 MiB with only hundreds of mounted nodes, so JS retention fixes
alone cannot be assumed to remove that peak. PR #15 already tried smaller tool
overscan and broad containment/promotion changes with inconsistent or worse results.

Add a repeatable long-session workload covering thread switches, history paging,
reconnects, large results and visited terminals. Sample physical footprint after
each stage and after idle, distinguishing WebContent, graphics, host, daemon and
agent processes. Require stable text/formatting, focus, selection, reading position,
follow behavior and rendering checks alongside before/after memory. No percentage
saving or resting-memory target is established by this audit.

Tauri uses OS-provided WebViews, including WKWebView on macOS. This reduces
bundled runtime size; it does not cap the application's HTML/CSS/JS or graphics
allocations. Reference: https://v2.tauri.app/concept/process-model/
