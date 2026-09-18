# Remote https preview — 2026-09-18

## Finding and change

Visible 280px `ResponseImage` chips used the original `https?` URL as
`<img src>`. WebKit decoded the full remote raster for a 280px box. The
renderer cannot `fetch` those bytes into a canvas (CORS). Local thread files
already receive a 560×352 PNG from the daemon.

Remote chips now request that same preview from
`GET /threads/{id}/image?url=…&preview=true`. The daemon fetches the public
URL, thumbnails to 560×352, and never proxies the original raster. Dialog,
copy, and download keep the original remote URL. Preview failure falls back
to the original URL so display is not truncated. Private, loopback, and
credentialed URLs are rejected.

This slice does not change `App.tsx`, `kit.css`, paint hosts, or hidden-window
compact. Tiny `data:` / `blob:` chips and dialog fit remain other slices.

## Reproduction and correctness

Daemon tests cover URL rejection (loopback, RFC1918, link-local, credentials)
and a loopback fixture that decodes to 560×187 from an 1800×600 PNG.
`artifacts` checks the remote chip `src` is a `blob:` within 560×352 while the
dialog `img.src` stays the original `https:` URL.

Native WebKit (macOS, production CSP), not run on this Linux VM:

```sh
node scripts/check-rendering.mjs artifacts
```

## Measurement gap

Issue #37 acceptance is whole-app **MiB physical footprint** on Apple M1. This
checkout is Linux and cannot run WKWebView or the macOS coalition. Do not
attribute a whole-app MiB delta until an image-heavy native pair exists.
Linux RSS is not a substitute.

## Related bounds (do not merge)

- Daemon / local preview raster: 560×352.
- Composer/user-attachment 64px chips: separate thumbnail slice.
- Compact/default `data:` / `blob:` chips: separate inline-preview slice.
- Open-dialog display: separate dialog-decode slice.
- Oversized open `ToolResult` `<pre>`: remaining image/open-oversized lever.
