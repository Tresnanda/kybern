# Glass surfaces and transcript rendering

Measured on 2026-09-06 in system WKWebView, using a production Vite build of
the real Transcript, store, reducer, Markdown renderer, Composer, and popup
primitives. The installed 0.1.8 app and its daemon remained running throughout.

## Workload and results

A local, read-only replay of the active thread contained 8,439 events, 792
blocks, and 13 turns. A temporary fixture rendered it in an 1100 × 720 native
window with a stub RPC module, scrolled top-to-bottom-to-top over 120 animation
frames, then applied 40 assistant text deltas to the last turn. Delta commit
timing used React flushSync; it does not include subsequent GPU presentation.
Private replay data and temporary fixtures were removed after verification.

| Measurement | 0.1.8 baseline (two runs) | Final changes |
| --- | ---: | ---: |
| Initial synchronous mount | 259–276 ms | 154 ms |
| Mounted DOM elements | 10,636 | 1,159 |
| Scroll frame interval, p95 | 35 ms | 18 ms |
| Scroll frames exceeding 25 ms | 37–40 / 120 | 0 / 120 |
| Streaming commit, p95 | 48–49 ms | 7 ms |
| Unchanged earlier turn groups retaining identity | 0 / 12 | 12 / 12 |

Preserving unchanged turn groups alone reduced stream commits to 5 ms p95,
but scroll intervals remained 35 ms. Unmounting closed work disclosures then
removed most hidden elements and brought scrolling close to the fixture's
18 ms idle p95 frame interval. Final numbers include the glass CSS changes.

Opening, closing, reopening, and closing an older work disclosure produced
437, 6, 437, and 6 descendant elements; the panel unmounted after its closing
transition and its contents returned correctly. Switching to a one-turn
transcript took 4–8 ms synchronously; returning to the long transcript took
92–99 ms. These switches still perform work and are not a 60 fps guarantee.

The enabled Composer fixture measured 2 ms p95 for 40 imperative text updates.
Native UI checks also exercised actual text entry, menu and popover opening,
light/dark switching, and disabling translucency. This does not measure
end-to-end keyboard latency while the daemon streams.

## Material checks

The shared role backgrounds now opt into glass along with the main view.
In the real component fixture, both themes measured card/composer alpha 0.58,
message alpha 0.40, and menu/popover alpha 0.64. Popup blur uses one 16 px layer
instead of overlapping element and pseudo-element filters. Text opacity is
unchanged.

Run the retained checks with:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
# macOS, after the production build:
node --experimental-strip-types scripts/check-window-material.mjs
```

The native regression consumes compiled CSS and the actual runtime theme
variables. It checks 17 surfaces, toggle restoration, opaque window material,
and positive reduced-transparency/increased-contrast overrides. The latter
preferences are emulated through CSSOM without changing macOS settings.

The live app's renderer sample showed substantial WebSocket/microtask work;
the daemon was mostly idle. The comparison above isolates two renderer causes,
not total CPU, energy use, memory savings, or every possible source of lag.
Full packaged-app verification on the user's M1 remains necessary after an
update; no replacement app or daemon was installed during this work.
