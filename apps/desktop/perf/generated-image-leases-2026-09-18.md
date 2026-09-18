# Offscreen generated-image gallery leases — 2026-09-18

## Finding and change

#43 bounds decoded preview URLs and oversized *expanded* tool results. Generated
image-generation payloads were still leased for the whole mounted turn so the
answer gallery could render while work stayed closed. A mounted turn with
offscreen `data:` images therefore kept reconstructible base64 outside the
inactive 8 MiB / 12-entry tool-output LRU.

`GeneratedImageOutputLease` now follows gallery visibility (300px rootMargin,
same approach window as image previews). Offscreen galleries drop the lease so
the existing inactive LRU can omit the payload. Scrolling back retains and
hydrates; displayed `img.src` stays the exact original data URL. Tool details
stay closed. No truncated UI.

This slice does not change `ResponseImage` URL ownership, `toolOutputCache`
thresholds, paint hosts, or hidden-window compact. It stacks independently of
#43 on `origin/main`.

## Reproduction

`chat-fixes` hydrates an omitted generated image into the final gallery, then
moves `[data-generated-image-gallery]` out of the transcript flow (fixed and
above the viewport) and back. `marginTop` is not enough: `followOutput` would
scroll the grown content and keep the lease. The mock lease count must drop to
0 offscreen and return to 1 with the same `img.src`. The observer root is the
transcript scroll container.

```sh
node scripts/check-rendering.mjs chat-fixes
```

Not run on this Linux VM (needs Swift/WKWebView). `pnpm typecheck`, `pnpm lint`,
and `pnpm test` (256 pass) from `apps/desktop` cover the rest.

## Measurement gap

Issue #37 acceptance remains whole-app MiB physical footprint on Apple M1.
The 385.1 MiB long-chat peak is 64 text Read results, not generated images.
Do not attribute a delta to that peak until an image-gallery native pair exists.
Linux RSS is not a substitute.
