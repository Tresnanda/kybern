# Opaque composer glass layer — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**) in
the **opaque** acceptance configuration. Full-shell WebContent still ran about
**73 MiB** above transcript-only after the chat-card stacking fix.

The composer already uses a dedicated `::before` for blur so the input itself
is not a containing block. Opaque mode sets `--composer-glass-filter: none`
and the comment says not to allocate a backdrop layer, but the pseudo still
had `content: ""`, `inset: 0`, `z-index: -1`, and a specified
`-webkit-backdrop-filter`. That is the same class of leftover overlay as the
chat-card seam: a generated stacking context that paints nothing useful.

The 823.4 vs 822.2 MiB composer-stack pair removed **actual blur** on a
translucent fixture. It is not a matched opaque-mode pair for omitting the
empty pseudo. Translucent mode keeps the one blur layer.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
turn-sized paint hosts ([#41](https://github.com/Tresnanda/kybern/pull/41)),
work-list containers ([#42](https://github.com/Tresnanda/kybern/pull/42)), or
visible-thread turn diffs ([#45](https://github.com/Tresnanda/kybern/pull/45)).

## Change

`html[data-window-material="opaque"]` (and reduced-transparency / increased
contrast) sets composer and stacked-rail `::before { content: none }`.
Elevated fills and borders stay. Frosted translucent composers are unchanged.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old opaque layer in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_COMPOSER_GLASS_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_COMPOSER_GLASS_LAYER` for the candidate. Window
1440×900, opaque preference, production CSP. Publish matched WebContent and
whole-app physical-footprint numbers before claiming a MiB saving.

The native window-material checker also asserts opaque composers do not keep
the leftover `::before` stacking context. Translucent blur is still sampled
from window pixels.
