# Inline edited-files card layer — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

Containers that grow past 1024 CSS px become tiled layers even when their
children are hosted — the same class as the discarded opened-group work
container and drafts [#42](https://github.com/Tresnanda/kybern/pull/42) /
[#49](https://github.com/Tresnanda/kybern/pull/49). The transcript “Edited N
files” card wrapped the header, file list, and expanded `FileDiffBody` in one
`.chat-paint-host`. An opened file shows 600 diff lines first (~10,000 CSS px)
inside that wrapper, so the card recreates a tiled layer.

[#45](https://github.com/Tresnanda/kybern/pull/45) bounds how many turn-diff
*summaries* a visible thread keeps. It does not change this paint host.

Hosted markdown blockquotes are already draft
[#58](https://github.com/Tresnanda/kybern/pull/58) (continuous bar on children).
Lists/tables are [#56](https://github.com/Tresnanda/kybern/pull/56). Do not
repeat them. Nested `ToolResult` `pre.max-h-72.overflow-auto` stays with
open-oversized work ([#43](https://github.com/Tresnanda/kybern/pull/43)).

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized paint hosts ([#41](https://github.com/Tresnanda/kybern/pull/41)),
work-list containers ([#42](https://github.com/Tresnanda/kybern/pull/42)),
visible-thread turn-diff *data* ([#45](https://github.com/Tresnanda/kybern/pull/45)),
the opaque composer glass layer ([#48](https://github.com/Tresnanda/kybern/pull/48)),
assistant answer wrappers ([#49](https://github.com/Tresnanda/kybern/pull/49)),
or the tall codeblock `::before` ([#53](https://github.com/Tresnanda/kybern/pull/53)).

The #37 live burst is 64 Read results in `<pre>` on `is_git=0`, so this slice
may be a no-op on that exact peak. A git workspace with an expanded inline
diff is the matching sample.

## Change

`[data-edited-files]` keeps the radius clip and drops `.chat-paint-host`. The
header, file-name rows, and each diff `tr` become the paint hosts. Dock
`FileDiffBody` rows use the same hosts so the changes pane does not retile.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old wrapper host in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_EDITED_FILES_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_EDITED_FILES_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. An expanded inline
diff is the matching sample.
