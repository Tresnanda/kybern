# Thumbnail decode budget — 2026-09-18

## Finding and change

Composer drafts and user-attachment chips render `ResponseImage` at `size-16`
(64 CSS pixels) with the original `blob:` or `data:` source. WebKit still
decodes the full raster for that `<img>`, so a 4000×3000 photo in a chip costs
tens of MiB of decoded pixels while the dialog is closed.

Thumbnails now fit to 128px (2× for the 64px chip). The dialog, copy, and
download paths keep the original source. Tiny `data:` URLs (≤16 KiB of
characters, including the 1×1 `chat-fixes` PNG) keep `img.src` identity and
are not fetched. Larger `data:` URLs are parsed with `atob`, not `fetch`, so
WebKit does not rewrite dialog `img.src`. Fitted previews are owned object
URLs and are revoked on unmount.

This slice does not change `toolOutputCache`, gallery leases, paint hosts,
`App.tsx`, `kit.css`, or hidden-window compact. It is independent of #43's
URL cache; merging later can park fitted blobs under a `thumbnail` key.

## Reproduction

`imageFit.test.mjs` covers fit size (no upscale), passthrough of tiny data
URLs, `atob` blob construction, and a no-op fit when `createImageBitmap` is
missing. `chat-fixes` still requires dialog `img.src` to be the original
attached data URL or composer blob; restored drafts read
`data-image-original` so a fitted chip src is not mistaken for the original.

```sh
pnpm test
node scripts/check-rendering.mjs chat-fixes
```

Native WebKit not run on this Linux VM.

## Measurement gap

Issue #37 acceptance is whole-app MiB physical footprint on Apple M1. The
385.1 MiB long-chat peak is text-result dominated. Do not attribute a delta
to that peak until an image-attachment native pair exists. Linux RSS is not
a substitute.
