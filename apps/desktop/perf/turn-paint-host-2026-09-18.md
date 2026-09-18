# Turn-sized paint hosts — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap after the chat-card stacking-context work is
still WebContent graphics. The matched live-tools coalition peaked at
**385.1 MiB** (second burst **388.7 MiB**), with WebContent **287.7 MiB** of
that peak. The discarded tile experiment in
[scroll tile accumulation](memory-tiles-2026-09-15.md) already ranked
"promote the turn only" with the losing cohort: **140 tiles / 580 MiB**. The
winning structure was nested leaves, the user message, and the working header.

Transcript `VirtualRows` still promoted every mounted **turn** with
`will-change: transform`, and applied `contain: paint` once history exceeded
30 groups. A live 64-tool turn is taller than WebKit's 1024 CSS px tiling
threshold at 2×, so that wrapper is the same class of tiled layer as
"promote the turn only". Nested work lists were already hosted; the outer
turn layer undid that bound.

The live-work parent is still unhosted (shipped). This slice does not change
leases, compact replay, the earlier-history label, or chat-card stacking.

## Change

Turn-sized transcript groups pass `paintHost={false}`: no `will-change`, no
`contain: paint`. Nested `WorkList` / `WorkRows` VirtualRows keep the default
host, including short lists that wrap each item in `.chat-paint-host`. Activity
lists that own their own scroller stay hosted; those rows stay small.

Scroller-owned lists still use the 8px bleed wrapper for focus rings, negative
icon margins, and entry motion.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old turn layer in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_TURN_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_TURN_LAYER` for the candidate. Window 1440×900, opaque
preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving.
