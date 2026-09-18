# Tall markdown codeblock layer — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

[Scroll tile accumulation](memory-tiles-2026-09-15.md) split code taller than
40 lines into `.chat-code-chunk` layers so a 5,000-line block is many small
backing stores. The same change left a full-size `::before` with `inset: 0`
and `will-change: transform`, and `.chat-markdown--hosted > *` still promoted
the wrapping `.chat-markdown-codeblock`. Those two surfaces are as tall as
the block, so they recreate the tiled layer the chunks were meant to bound.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized paint hosts ([#41](https://github.com/Tresnanda/kybern/pull/41)),
work-list containers ([#42](https://github.com/Tresnanda/kybern/pull/42)),
visible-thread turn diffs ([#45](https://github.com/Tresnanda/kybern/pull/45)),
the opaque composer glass layer ([#48](https://github.com/Tresnanda/kybern/pull/48)),
or assistant answer wrappers ([#49](https://github.com/Tresnanda/kybern/pull/49)).

The #37 live burst is 64 Read results in `<pre>`, not markdown fences, so this
slice may be a no-op on that exact peak. It is the leftover tall-code layer
for any transcript that renders fenced code, including the 400-turn history
when those turns contain code.

## Change

`::before { content: none }`. Fill and `will-change: transform` live on the
header, each `.chat-code-chunk`, and short unchunked bodies. Chunked `pre`
padding moves onto the first/last chunks so the fill stays continuous without
a tall body layer. Hosted markdown skips `.chat-markdown-codeblock`. The
wrapper still clips the radius. User-bubble code uses the same leaf fills.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old overlay in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_CODEBLOCK_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_CODEBLOCK_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. A transcript with
tall fenced code is the matching sample.
