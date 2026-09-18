# Tall markdown quote layer — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

Transcript Markdown hosts each top-level block so a long answer is many small
layers. That `> *` rule also promoted wrapping `blockquote` as one layer. The
quote's left border paints on that wrapper, so unhosting it without moving the
bar would paint a tall strip into the scroller — the same class as the discarded
opened-group work container and drafts [#42](https://github.com/Tresnanda/kybern/pull/42) /
[#49](https://github.com/Tresnanda/kybern/pull/49) / [#56](https://github.com/Tresnanda/kybern/pull/56).

The codeblock `::before` leftover is already draft
[#53](https://github.com/Tresnanda/kybern/pull/53). This slice does not repeat it.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized paint hosts ([#41](https://github.com/Tresnanda/kybern/pull/41)),
work-list containers ([#42](https://github.com/Tresnanda/kybern/pull/42)),
visible-thread turn diffs ([#45](https://github.com/Tresnanda/kybern/pull/45)),
the opaque composer glass layer ([#48](https://github.com/Tresnanda/kybern/pull/48)),
assistant answer wrappers ([#49](https://github.com/Tresnanda/kybern/pull/49)),
the tall codeblock `::before` ([#53](https://github.com/Tresnanda/kybern/pull/53)),
or list/table wrappers ([#56](https://github.com/Tresnanda/kybern/pull/56)).

The #37 live burst is 64 Read results in `<pre>`, not markdown quotes, so this
slice may be a no-op on that exact peak. A transcript with tall blockquotes is
the matching sample.

Nested `ToolResult` `pre.max-h-72.overflow-auto` stays with open-oversized work.

## Change

Hosted markdown skips top-level `blockquote`. Direct children become the paint
hosts. The 2px left bar and 0.8rem indent move onto those children. Vertical
child margins become abutting padding so the bar stays one line.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old wrapper host in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_QUOTE_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_QUOTE_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. A transcript with
tall blockquotes is the matching sample.
