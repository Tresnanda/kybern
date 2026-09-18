# Inline preview decode budget — 2026-09-18

## Finding and change

Compact and default `ResponseImage` chips are 280 CSS pixels (`w-[280px]`).
Generated-image galleries, markdown images, `image_received` deliverables, and
open tool screenshots used the original `data:` / `blob:` source as `<img src>`.
WebKit decoded the full raster for a 280px box. Local thread files already
receive a 560×352 PNG from the daemon (`crates/kybern-daemon/src/thumbnail.rs`).

Inline `data:` / `blob:` previews now fit to that same 560×352 budget once they
are near the viewport. The dialog, copy, and download paths keep the original
source. Tiny `data:` URLs (the 1×1 / 2×1 `chat-fixes` PNGs) keep `img.src`
identity and are not decoded into a preview blob. Larger `data:` URLs are parsed
with `atob`, not `fetch`. Remote `https?` images are not fetched. Thumbnails
(`size-16`) are unchanged.

Exact displayed dialog pixels and copied/downloaded bytes are not truncated.

## Reproduction and correctness

Desktop unit tests include `previewImageFit.test.mjs` (fit size 560×352 with no
upscale, tiny-source passthrough, `atob` data URLs, no-op without
`createImageBitmap`).

Native WebKit (macOS, production CSP), not run on this Linux VM:

```sh
node scripts/check-rendering.mjs chat-fixes
```

`chat-fixes` still requires attached-image, generated-image, and tool-screenshot
dialog `img.src ===` the original data URL. The generated-image gallery uses a
2×1 canvas whose data URL stays under the passthrough limit.

## Measurement gap

Issue #37 acceptance is whole-app **MiB physical footprint** on Apple M1. This
checkout is Linux and cannot run WKWebView or the macOS coalition. The 385.1 MiB
long-chat peak is 64 text Read results, not generated-image or screenshot
rasters. Do not attribute a whole-app MiB delta until an image-heavy native pair
exists.

## Related bounds (do not merge)

- Daemon / local preview raster: 560×352.
- Composer/user-attachment 64px chips: separate thumbnail slice (128px).
- Offscreen generated-image output leases: separate gallery-lease slice.
- Refcounted object-URL cache and oversized open text results: separate URL /
  tool-output slice.
