# Dialog decode budget — 2026-09-18

## Finding and change

`ResponseImage` chips are already bounded on other slices (64px thumbnails,
280px inline previews). The open dialog still mounted `<img src>` as the
original (`max-h-[75dvh] w-full object-contain`). At 1440×900 2× that box is
1200×675 CSS pixels, but WebKit decoded the full raster while the preview was
open — a 4000×3000 photo is tens of MiB of decoded pixels for a dialog that
cannot show more than 2400×1350 device pixels.

The dialog display source now fits to 2400×1350. Copy and download keep the
original bytes (`data:` / `blob:` / local object URL). Tiny `data:` URLs (the
1×1 / 2×1 `chat-fixes` PNGs) keep src identity. Animated GIFs skip fitting so
the dialog does not freeze them. Remote `https?` images are not fetched into a
canvas (CORS); they remain a later slice. Local thread files still fetch the
full original for copy/download; only the displayed `<img>` uses the fitted
object URL. The original identity is on `data-image-original`.

Exact copied/downloaded bytes are not truncated. The visible dialog still
shows the whole image via `object-contain`.

## Reproduction and correctness

Desktop unit tests include `dialogImageFit.test.mjs` (fit size 2400×1350 with
no upscale, tiny-source passthrough, GIF skip, `atob` data URLs, no-op without
`createImageBitmap`).

Native WebKit (macOS, production CSP), not run on this Linux VM:

```sh
node scripts/check-rendering.mjs chat-fixes
node scripts/check-rendering.mjs artifacts
```

`chat-fixes` reads dialog identity from `data-image-original` (falling back to
`img.src`) so a fitted display src is not mistaken for a lost original.
`artifacts` checks the dialog raster is within 1350px while the copy/download
identity still decodes at 1800px.

## Measurement gap

Issue #37 acceptance is whole-app **MiB physical footprint** on Apple M1. This
checkout is Linux and cannot run WKWebView or the macOS coalition. Peak only
applies while a large preview is open. Do not attribute a whole-app MiB delta
until an image-heavy native pair exists. Linux RSS is not a substitute.

## Related bounds (do not merge)

- Daemon / local preview raster: 560×352.
- Composer/user-attachment 64px chips: separate thumbnail slice (128px).
- Compact/default 280px chips: separate inline-preview slice (560×352).
- Offscreen generated-image output leases: separate gallery-lease slice.
- Refcounted object-URL cache and oversized open text results: separate URL /
  tool-output slice.
- Remote `https?` rasters: remaining image lever.
