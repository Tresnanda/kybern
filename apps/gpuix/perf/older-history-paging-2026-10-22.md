# Older history paging (2026-10-22)

User report: in some conversations, scrolling to the top shows "Scroll up for
earlier messages" and loading tiny chunks takes a very long time; in others it
is instant.

Measured on a consistent `.backup` copy of the user's real 5.3 GB store, with a
release `kybernd` built from this branch on loopback (M-series Mac, another
benchmark running concurrently, so treat single-digit milliseconds as noise).
The copy was deleted afterwards. Only ids, counts and sizes appear here.

## Threads

| Thread | Events | Payload | Turns | Transcript rows | Rows per turn p50 / p90 / max | Subagent tool rows |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| `01a13354` (slow) | 47,579 | 214 MB | 25 | 7,647 | 26 / 2,060 / 2,093 | 4,459 (5.3 MB) |
| `01a1269a` (slow) | 10,951 | 157 MB | 9 | 2,428 | 166 / 1,118 / 1,118 | 1,107 |
| `01a15724` (mixed) | 22,825 | 190 MB | 44 | 3,806 | 19 / 212 / 951 | 160 |
| `01a13e23` (fast) | 40,399 | 62 MB | 416 | 3,103 | 3 / 13 / 178 | 0 |

The slow threads are not the largest by events: `01a13e23` has 40k events and
paged instantly. They are the ones whose turns delegate to subagents, so a
single turn holds hundreds to thousands of transcript rows (mostly subagent
tool calls, which GPUIX shows collapsed inside the turn's work group).

## Root cause

1. **Pages counted rows; the transcript shows turns.** An older page was the
   120 rows before the cursor. In `01a13354`, 48 of 63 pages contained no
   prompt, and reaching the prompt above one delegating turn took **17 pages
   (21.6 MB)**. Each such page only added rows to the already visible, collapsed
   top turn: nothing changed on screen ("tiny chunks").
2. **The GPUIX loader is edge-triggered.** `Transcript` loads a page when the
   top row *enters* view. A page that adds no row leaves the top in view, so no
   further page loads until the reader scrolls away and back. Seventeen gestures
   for one turn is the "really long time"; the network and fold were not.
3. **Every older page re-sent thread-wide state.** `threads.get` returned the
   full runtime-task list (1,132 tasks, ~1.1 MB) with every older page. Pages
   were ~1.2 MB, over GPUIX's 1 MiB prefetch cap, so the background prefetch was
   downloaded, discarded and requested again on demand.
4. **A moving snapshot re-projected the whole thread.** The projection cache is
   keyed by `(thread, through_seq)`. A running thread advances `through_seq`
   between pages, so each page replayed all 47k events: ~450 ms per page
   (fold 371 ms, side state 97 ms). Settled threads hit the cache.
5. **Per-page stream marking scanned the thread.** `defer_tool_stream` scanned
   every tool start and output delta of the thread for each page: 28–35 ms of a
   34 ms warm page on `01a13354`.

Client folding was not a cause: `prependThreadHistory` over all 17 pages took
12 ms in total.

## Fix

- `threads.get` gains two additive parameters (older daemons ignore them):
  - `whole_turns`: the page widens back to the first row of its oldest turn
    (at most `WHOLE_TURN_EXTRA_ENTRIES` = 4,000 extra rows; equal-sequence
    groups are never split). Each page now brings whole turns.
  - `transcript_only` (with `before_seq`): only the transcript page and cursor;
    runtime tasks, usage, commands, questions, approvals and notes stay empty
    and are never computed.
- The projection cache keeps the resumable `TranscriptFold`. A newer
  `through_seq` clones the newest cached fold of the same thread and applies
  only the events after it (`Store::extend_transcript_fold`). Side state is
  computed once per projection, on demand.
- Stream marking comes from the projection fold, not from queries: the fold
  now also reads `tool_call_output_delta` events and remembers, per tool
  invocation, whether it has a delta and a persisted completion
  (`TranscriptFold::mark_tool_streams_omitted`). A page marks its rows from that
  in-memory set, so a page costs nothing for it and no index over `events` is
  needed (see "Stream marking without an index" below). There is no migration.
- GPUIX, desktop: older pages request `EARLIER_HISTORY_PAGE`
  (`whole_turns` + `transcript_only`). GPUIX `loadEarlier` resolves whether the
  page left the oldest turn unchanged; while the reader stays at the top, such a
  page does not use up their scroll intent and the next one loads. A page that
  shows a turn or its prompt ends the chain, so browsing still never downloads
  all history without reading gestures. Mobile is unchanged (it ignores the
  extra fields until it adopts them).

Unchanged: pages stay sequence-bounded (`through_seq`), events received during
a load are replayed, row identities are preserved by `prependThreadHistory`,
and the reading anchor shifts by the number of prepended turns.

## Results

Same scratch copy, same release-build setup; "before" is `main` at v0.10.3
(`662adcde7`), "after" is this branch. Times are wall-clock RPC on loopback
plus `prependThreadHistory`, as GPUIX issues them.

**Reaching the next prompt.** A reader at the top asks for history until a new
prompt row appears. Six such reaches per thread from the newest page, fixed
snapshot, warm cache. Before, every page after the first needed its own scroll
gesture (cause 2); after, a page inside one turn also continues on its own.

| Thread | Pages, before → after | Most pages for one reach | Bytes, before → after | Slowest reach, before → after |
| --- | --- | --- | --- | --- |
| `01a13354` | 23 → 6 | 17 → 1 | 29.2 MB → 6.2 MB (more history: 5,424 vs 2,880 blocks) | 603 ms over 17 pages → 34 ms, one page |
| `01a1269a` | 20 → 4 (whole thread) | 7 → 1 | 13.7 MB → 5.3 MB | 100 ms over 7 pages → 18 ms |
| `01a15724` | 15 → 6 | 6 → 1 | 10.6 MB → 2.2 MB | 86 ms over 6 pages → 9 ms |
| `01a13e23` (fast) | 6 → 6 | 1 → 1 | 2.3 MB → 0.8 MB | 17 ms → 3 ms |

**One older page.**

| Case (`01a13354` unless noted) | Before | After |
| --- | ---: | ---: |
| Settled thread, warm cache, per page | 33–37 ms, 1.2 MB (1.1 MB runtime tasks) | 2–4 ms for a small turn; 22–28 ms for a 2,000-row whole turn (2.3–2.6 MB) |
| Running thread (`through_seq` advances 5 events per page) | ~450 ms (full re-projection) | 12–38 ms (`whole_turns` + `transcript_only`); 121–151 ms with legacy params (side state) |
| Running thread, `01a15724` / `01a13e23` | ~160 / ~120 ms | 6–14 / 8–11 ms |
| Small thread `01a14b21`, cold | 26–31 ms | (already fast) |

**Whole thread, `01a13354`**, fixed snapshot, top to bottom: 63 pages (54
without a prompt), 78.3 MB → 7 pages (none without a prompt), 8.2 MB. With
legacy params the after-daemon serves a warm page in 8–9 ms (was 33 ms), from
the in-fold stream marks alone.

**Live walk, cold daemon per run** (5 pages, `through_seq` 10 events behind
head, +1 per page; p50 per page). Legacy params on the after-daemon still
reread side state and serialize the 1.1 MB task list per new head:

| Thread | Before | After, legacy params | After, new params |
| --- | ---: | ---: | ---: |
| `01a13354` | ~437 ms | 186 ms (2/5 pages without a prompt) | 19 ms (0/5) |
| `01a15724` | ~156 ms | 44 ms | 6 ms |
| `01a13e23` | ~129 ms | 59 ms | 9 ms |

An earlier version of this fix marked streams through a partial expression
index over `events` (`tool_delta_identity`, migration 28). Building it scanned
the whole 5.3 GB table: ~12 s once at daemon startup on the copy. That
migration never shipped and is gone; the section below replaces it. The numbers
above were taken with the index and still describe the page shapes; the table
below compares both versions in one session.

## Stream marking without an index

Migration 28 (`tool_delta_identity`) is gone. Marking now comes from the
projection fold, which also reads `tool_call_output_delta` events (as an
identity only: the delta text is not decoded) and keeps, per call ID, its newest
start and whether that start has seen a delta and a persisted completion. This
matches the old query exactly, including reused call IDs, the snapshot barrier
and a stream flushed after its completion, because a delta or completion
belongs to the newest start of its ID. It also needs no page window, so a tool
that streams across a page edge or across turns (19 tool starts in the copy) is
marked correctly; a per-page range query over `events` would have missed them.

Why not a range query: real data has 128,855 deltas in the whole store (71 MB,
at most 3.8 MB per thread) and every one precedes its completion, but 19 tool
starts stream across a turn boundary, so a page's own sequence range cannot decide
them without a lookahead per row. The fold sees every event anyway.

Same copy, release daemons built from the previous commit (index) and from this
change, a fresh clone per start, loopback, the Mac busy with another benchmark
(read single-digit milliseconds as noise). Page times are
`threads.get` with the GPUIX older-page parameters, whole thread top to bottom,
warm cache; "live" is the 5-page walk with `through_seq` ten events behind head.

| | With migration 28 | Without |
| --- | ---: | ---: |
| First start on the copy (schema 26), 3 starts | 6.9–8.2 s | 5.4–6.1 s |
| Second start (nothing to migrate) | n/a | 1.6 s |
| Cold first page, `01a13354` / `01a13e23` / delta-heavy `01a14f75-9977` (page cache pre-read, 2 starts) | 616–1008 / 126–144 / 28–31 ms | 561–624 / 130–131 / 36–53 ms |
| `01a13354` page p50 / max | 7.1 / 22.1 ms | 4.9–5.5 / 18–27 ms |
| `01a1269a` page p50 / max | 8.5 / 13.4 ms | 7.3–7.7 / 10 ms |
| `01a15724` page p50 / max | 2.8 / 8.3 ms | 1.8–2.1 / 6.5 ms |
| `01a13e23` page p50 / max | 1.2 / 8.4 ms | 1.0–1.1 / 9.7–10.4 ms |
| Legacy params, `01a13354` warm page p50 | 9.3 ms | 9.2 ms |
| Live walk p50, `01a13354` / `01a1269a` / `01a15724` / `01a13e23` | 20 / 14 / 20 / 24 ms | 20 / 12 / 13 / 9 ms |

The first start's remaining ~5 s is not from this change (a second start takes
1.6 s). The 12 s measured earlier was the index build on a cold file cache.
The first, uncontrolled cold-page comparison looked 2× slower for the new
daemon only because the index build had read the whole file into the page cache
at startup; with the cache equally warm, and deltas decoded as identities, the
cold first page matches. The fold adds the delta events (tens of milliseconds
at most on the heaviest thread) to a one-time projection build.

GPUIX's prefetch cap rose from 1 MiB to 4 MiB: the whole-turn pages of
delegating turns (2.3–2.6 MB) were exactly the ones the old cap discarded.

Not measured: a GPUIX window. A separate benchmark held the Mac for the
whole session, and the task forbids launching GPUIX windows while it runs.
The row-level effect (pages per visible turn) and the loader rule are covered
by the wire walk above and by `verify.history-paging.ts`; on-screen anchor
stability on prepend relies on the unchanged `pendingAnchor` path.

## Tests

- `kybern-store`: whole-turn paging (one page per turn, bounded oversized
  turns cover every row once, equal sequences, live rows, unordered input);
  incremental fold equals a full fold at every split; stream marks
  (reused call IDs, snapshot barrier, a stream flushed after its completion,
  a tool that streams across turns, a tool still running at the head; marks do
  not depend on where a page starts or ends, and an extended fold marks like a
  fresh one).
- `kybern-daemon`: `whole_turn_history_pages_add_whole_turns_and_leave_thread_state_out`
  (a 900-row turn between prompts; pages match full history; legacy shape
  without the new fields); projection cache base selection and extension.
- `packages/kybern-client`: `historyTop` / `historyPageShowedNothing`.
- GPUIX `verify.history-paging.ts`: requests carry both fields; a same-turn
  page resolves `true`, a prompt or the last page resolves `false`; existing
  replay, identity and prefetch checks unchanged.

## Reproduce

- `crates/kybern-store/examples/profile_older_pages.rs <gpuix-scratch copy> <thread ids>`:
  fold, side state and per-page stream marking times (use full thread ids).
- Wire walks used a `KybernClient` script against a scratch daemon: per reader
  "reach the top", pages and bytes until a new prompt row appears, with RPC and
  `prependThreadHistory` time.
