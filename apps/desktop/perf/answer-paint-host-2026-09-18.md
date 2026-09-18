# Assistant answer paint hosts — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

[Scroll tile accumulation](memory-tiles-2026-09-15.md) ranked containers that
grow past 1024 CSS px as tiled layers even when their children are hosted. The
live-work parent and grouped-tool lists follow that rule. Settled assistant
bodies still wrapped the whole answer in `.chat-paint-host` twice: once on the
`group min-w-0` column and again on `data-slot="message-content"`.
`.chat-markdown--hosted > *` already promotes each Markdown block. Images and
meta rows have their own hosts. The wrappers are as tall as the answer.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized `VirtualRows` promotion ([#41](https://github.com/Tresnanda/kybern/pull/41)),
work-list containers ([#42](https://github.com/Tresnanda/kybern/pull/42)),
visible-thread turn diffs ([#45](https://github.com/Tresnanda/kybern/pull/45)),
or the opaque composer glass layer ([#48](https://github.com/Tresnanda/kybern/pull/48)).

## Change

`[data-answer-host]` keeps hover grouping and drops `.chat-paint-host`. Assistant
`data-slot="message-content"` is no longer a paint host. Nested markdown blocks,
image rows, hairlines, copy/meta, and error rows stay hosted.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old answer layer in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_ANSWER_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_ANSWER_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. Seeded 400-turn
history matters for this slice as well as the live burst.
