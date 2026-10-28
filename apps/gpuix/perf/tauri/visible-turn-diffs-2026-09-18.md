# Visible-thread turn diffs — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent-dominated, but the
matched coalition also grew **after** the burst: 285.7 MiB at +60 s, then
**309.6 MiB** after a second burst. Retention already caps inactive transcripts
and diffs at 16 MiB. Visible threads were pinned entirely.

Every completed mounted turn calls `loadDiff` for the "Edited N files" card,
and a visible `turn_completed` event does the same. Those summaries never
entered the eviction set, so a long follow on one thread kept every historical
`threadId:turnId` diff for the rest of the session. The changes-panel
`threadId:all` card is a single reconstructible snapshot; per-turn cards are
not.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized `VirtualRows` promotion ([#41](https://github.com/Tresnanda/kybern/pull/41)),
or work-list container hosts ([#42](https://github.com/Tresnanda/kybern/pull/42)).
Leases, compact replay, and hosted earlier-history status stay. The #37 scratch
seed is not a git repo, so this slice may be a no-op on that exact peak; it is
the settled-growth hole for any workspace that answers `threads.diff`.

## Change

Keep the whole-thread `:all` summary and the **16** newest per-turn diffs per
visible thread (virtualized overscan plus slack). Older summaries drop from the
store and reload through the existing `loadDiff` path when that turn remounts.
Inactive-thread diffs still use the 16 MiB LRU.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old unbounded visible set in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_UNBOUND_TURN_DIFFS=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_UNBOUND_TURN_DIFFS` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. A git workspace with
many completed turns is the matching settled-growth sample; the sanitized
#37 seed (`is_git=0`) may not fill `state.diffs`.
