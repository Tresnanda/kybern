# Chat seam overlay — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap after v0.4.6 is still WebContent graphics,
not the daemon (~27 MiB at the last peaks). The matched stacking-context pair
(`3fb73dfb`) showed that a viewport-sized stacking context on the chat card
moved WebContent peak 390.3 → 258.9 MiB in the full-shell native fixture and
whole-app peak 454.2 → 385.1 MiB.

That change removed `z-index: 15` from the card. The card still painted a
`::before` with `position: absolute; inset: 0; z-index: 1` to hold a 0.6px left
hairline. That pseudo is a second full-card stacking context over the same
1184×854 transcript surface, with an opacity transition that can keep the
layer. Header hairlines in this stylesheet already avoid a positioned
full-size overlay for the same reason.

Discarded sidebar experiments from the follow-up (fixed vs absolute,
persistent animation hints, entry motion, extra sidebar paint hosts, scroll
masks) are unrelated and stay discarded.

## Change

`.chat-content-card::before` is a 1px left strip (`top/bottom/left/width`)
that still draws `box-shadow: inset 0.6px 0 0 var(--seam-line)`. Collapse
still fades it; hover still intensifies `--seam-line`; settings still forces
the seam visible when the inert thread sidebar is collapsed.

The unused `CHAT_CONTENT_CARD_CLASS_NAME` token no longer includes `z-[15]`,
matching production `App.tsx`. Settings keeps its overlay `z-[15]`.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old overlay in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_FULL_SEAM_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_FULL_SEAM_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving.
