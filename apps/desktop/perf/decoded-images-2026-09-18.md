# Decoded images and open oversized results — 2026-09-18

## Finding and change

Issue #37 item 4 is separate from the inactive tool-output LRU (12 entries /
8 MiB). Sticky `requested=true` in `ResponseImage` kept object URLs and decoded
frames after a preview left the viewport. Oversized expanded tool payloads could
park in that LRU as soon as they were no longer leased, fighting the 12 small
slots and retaining reconstructible text that no one was displaying or copying.

This change adds a refcounted image URL cache (`src/lib/responseImageUrls.ts`)
with its own idle compressed-blob budget (8 MiB / 12 entries). Live consumers
share one object URL; the last release revokes it and parks the blob. Cancelling
the last waiter aborts the shared fetch; a remaining waiter keeps it. Reopening
uses the parked blob instead of fetching again. `data:` / `blob:` / remote
`https?` sources keep their original `src` (attached-image and generated-image
dialogs). They are not fetched into the preview cache; their `<img>` still
unmounts when offscreen so decoded frames drop. Local thread images use owned
object URLs. Remote images are not fetched (CORS).

`ToolResult` leases oversized reconstructible payloads only while the result is
visible (300px rootMargin) or the current selection is inside it. Once omitted
offscreen, a hold flag skips hydration so a 0-byte stub cannot look small and
refetch. Small mounted results still retain while mounted, including offscreen,
so `tool-leases` 16-result shared-pane hydration is unchanged. Generated-image
gallery leases stay for the mounted turn: the gallery is displayed content; the
image cache still releases decoded previews when those images leave the viewport.

Exact displayed and copied bytes are not truncated. Reconstructible omitted
payloads reload on reopen.

## Reproduction and correctness

Desktop unit tests (Node 22.22.2): 268 passing, including `responseImageUrls.test.mjs`
(fit size 560×352 with no upscale, key identity, shared revoke, last-waiter abort,
remaining waiter, abort-after-load parking, reopen-from-idle, idle budget,
pass-through vs resized ownership, module reset) and `toolOutputCache.test.mjs`
(oversized inactive omit, exact open copies, `drop()` of reconstructible
offscreen payloads). `pnpm typecheck` and `pnpm lint` from `apps/desktop` also
passed.

Native WebKit (macOS, production CSP), not run on this Linux VM:

```sh
node scripts/check-rendering.mjs artifacts
node scripts/check-rendering.mjs chat-fixes
node scripts/check-rendering.mjs tool-leases
```

`artifacts` now also asserts that leaving the viewport releases the preview
object URL and unmounts the decoded `<img>`, that reopening decodes again, and
that a long image list keeps ≤12 live `<img>` / object URLs. The object-URL
assertion waits for `createObjectURL` after `fetchThreadImage` records the path
(sized previews delay 120ms before the blob). `chat-fixes` still requires
attached-image and generated-image `img.src ===` the original data or blob URL.

## Measurement gap

Issue #37 acceptance is whole-app **MiB physical footprint** on Apple M1, macOS
27, release Tauri, 1440×900, opaque, production CSP (`profile-tauri-coalition`).
This checkout is Linux and cannot run WKWebView, `check-rendering.swift`, or the
macOS coalition. Do not substitute Linux RSS / GTK WebView numbers.

The #37 long-chat/tool-result peak (385.1 MiB) is text-result dominated, not an
image-heavy workload. Attribute any later native saving from this slice to an
image-heavy or oversized-open-result pair, not to that 385.1 MiB peak, unless
the same coalition script is rerun and the delta is isolated.

## Related bounds (do not merge)

- Inactive canonical tool outputs: 8 MiB / 12 entries (`toolOutputCache.ts`).
- Idle compressed image blobs: 8 MiB / 12 entries (`responseImageUrls.ts`).
- Daemon preview raster: 560×352 (`PREVIEW_MAX_WIDTH` / `PREVIEW_MAX_HEIGHT`).
- Oversized reconstructible open results: omit when not visible/selected above
  256 KiB estimated retained size (`OVERSIZED_OUTPUT_BYTES`).
