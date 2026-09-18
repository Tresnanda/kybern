# Work-list container paint hosts — 2026-09-18

## Attribution

Issue #37's remaining whole-app gap is still WebContent graphics. The matched
live-tools coalition peaked at **385.1 MiB** (second burst **388.7 MiB**).

[Scroll tile accumulation](memory-tiles-2026-09-15.md) found that an opened
tool group stayed a tiled layer even after each tool row was its own layer:
the **work container** around the panel painted and accumulated tiles. The
live-work parent was later unhosted for that reason. Settled disclosures,
grouped-tool panels, nested activity, and primary agent lists still wrapped
the same `VirtualRows` lists in `.chat-paint-host`.

A virtualized list's container is as tall as the spacers (64 closed Reads is
already past 1024 CSS px). Promoting that wrapper recreates the discarded
work-container tiled layer. Nested rows already have paint hosts.

Does not touch [issue #33](https://github.com/Tresnanda/kybern/issues/33),
image RAM, the chat-card seam ([#40](https://github.com/Tresnanda/kybern/pull/40)),
or turn-sized `VirtualRows` promotion ([#41](https://github.com/Tresnanda/kybern/pull/41)).
Leases, compact replay, and hosted earlier-history status stay.

## Change

`[data-work-list]` wrappers keep spacing and indent and drop `.chat-paint-host`.
Triggers, hairlines, user messages, answers, and nested virtual rows stay hosted.

## Measurement

This Linux checkout cannot run the Apple M1 / macOS release coalition. Do not
treat unit tests or GTK as the #37 acceptance number.

Reproduce the old list layer in the native full-shell fixture:

```sh
KYBERN_PERF_LIVE_HISTORY=1 KYBERN_PERF_LIVE_THREAD=1 KYBERN_PERF_LIVE_SHELL=1 \
  KYBERN_PERF_LIVE_WORK_LIST_LAYER=1 \
  node scripts/check-rendering.mjs live-tool-memory
```

Omit `KYBERN_PERF_LIVE_WORK_LIST_LAYER` for the candidate. Window 1440×900,
opaque preference, production CSP. Publish matched WebContent and whole-app
physical-footprint numbers before claiming a MiB saving. Expanded-work samples
matter for this slice as well as the closed-result burst.
