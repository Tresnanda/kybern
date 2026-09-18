# Hosted markdown paragraph layer — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

Hosted markdown `> *` promotes every top-level block, including ordinary
`p`/`h*`/`hr`. A huge paste as one paragraph is then one layer past 1024 CSS px
and recreates tiled 4 MiB scroll tiles — the same class as wrapping lists,
quotes, codeblocks, and mermaid. Those wrappers are already drafts
[#53](https://github.com/Tresnanda/kybern/pull/53) / [#56](https://github.com/Tresnanda/kybern/pull/56) /
[#58](https://github.com/Tresnanda/kybern/pull/58) / [#59](https://github.com/Tresnanda/kybern/pull/59).
Do not repeat them. Nested `ToolResult` `pre.max-h-72.overflow-auto` stays with
open-oversized work ([#43](https://github.com/Tresnanda/kybern/pull/43)).

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33) or
image RAM. Branched from `origin/main`, not stacked.

The #37 live burst is 64 Read results in `<pre>`, not a huge paragraph, so this
slice may be a no-op on that exact peak. A transcript with a tall hosted
paragraph is the matching sample.

## Change

Hosted markdown skips top-level `p`/`h1`–`h6`/`hr`. Paragraph and heading
text is wrapped in `.chat-prose-chunk` layers; strings past 1600 characters
split on whitespace so each chunk stays under the tiling height at typical
chat widths. `hr` remains a small leaf host. Chunks concatenate to the source.
User markdown (`variant="user"`) is not chunked: it is not hosted, and native
`chat-fixes` selects `p.firstChild` as a text node for preserved newlines.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old wrapper host in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_PARAGRAPH_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_PARAGRAPH_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. A tall hosted
paragraph is the matching sample.
