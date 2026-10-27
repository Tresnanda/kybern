# Kybern GPUIX

The Kybern desktop app, rendered natively by [GPUIX](https://gpuix.dev) (React
on Zed's GPUI): Metal on macOS, Direct3D 11 on Windows and Vulkan on Linux. It
replaces the Tauri app in `apps/desktop`, which ships until its deprecation
release.

It connects to the running `kybernd` and reuses the shared
`packages/kybern-client` transport and transcript projection. Colors come from
the desktop's own `buildThemeCssVariables`, and tool rows from its `toolLine`,
both imported directly so they stay in step with `apps/desktop`.

## Try it

```sh
cd apps/gpuix
native/update.sh                           # build the patched addon pinned in native/FORK
pnpm dev                                   # your real daemon (~/.kybern): real threads, real sends
KYBERN_DATA_DIR=/path/to/scratch pnpm dev  # a scratch daemon instead (kybernd --data-dir … --port …)
```

It opens a native window (the Dock shows "bun") and reloads on save. Quit with
⌘Q. Everything you do is real against the daemon it connects to: sending,
approving, archiving and pinning all write.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm dev                      # bun --hot; window remounts on save
pnpm screenshot out.png       # background launch + PNG (add --light)
bun scripts/interact.ts dir   # collapse/rail motion frames + typing check
```

Environment: `KYBERN_DATA_DIR` (default `~/.kybern`) or `KYBERN_URL` +
`KYBERN_TOKEN`; `KYBERN_APPEARANCE=dark|light`; `KYBERN_REDUCED_MOTION=1`;
`KYBERN_OPAQUE=1` for an opaque window (scope none, native `opaque` from launch); `KYBERN_GPUIX_THREAD=<id or title>`
opens a thread at launch.

Window material pins (tests, bench, screenshots; they override both theme variants and are never saved):
`KYBERN_WINDOW_MATERIAL=solid|window|sidebar` (`window` = translucent, whole window; `sidebar` = translucent, Sidebar only),
`KYBERN_WINDOW_OPACITY=15…100` (the sidebar and frame coat; also the content coat of `window` unless pinned below),
`KYBERN_WINDOW_CONTENT_OPACITY=15…100` (the conversation's coat; 100 is Sidebar only), `KYBERN_WINDOW_SURFACE_OPACITY=30…100`
(composer, menu and card tints), `KYBERN_GLASS_FROST=none|all|composer,pills,menus` (which classes blur behind their tint; unset = `FROST_DEFAULT`),
`KYBERN_BACKDROP_HALFRES=0` (full-resolution blur for A/B), `KYBERN_WINDOW_BLUR=1…64|auto`, and `KYBERN_WINDOW_BLUR_FAIL=1` (the adjustable blur
reports failure, for the "Unavailable, use Auto" capture). Settings › Appearance › Window sets the same per theme.
A window whose lightest region covers the desktop (opacity 99+ in the whole window; light Sidebar only at any opacity) is opaque,
with no desktop blur; the Opacity slider is held at a readability floor (65% dark, 55% light).
`KYBERN_TRANSLUCENCY_SINGLE_FILL=1` is a temporary perf A/B switch: no frame fill under the content card in Sidebar only and Solid,
and one fill on the thread panel (same pixels, less overdraw). Default off.

## Spaces

Projects belong to spaces (daemon `spaces.*`); the rail shows one tile per space once there are two,
and the thread panel, Home, Tasks, Notes, Pull requests and the palette follow the active space.
⌃1–⌃8 pick spaces 1–8 and ⌃9 the last one (not while a terminal has focus). If you enabled macOS
Mission Control's "Switch to Desktop N" shortcuts, the system takes ⌃digits before the app does: turn
them off or use the tiles. Verify with `KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/spaces/verify.ts`.

## Status

Feature parity across macOS, Windows and Linux shipped in 0.16.0. What is still
open per platform (known gaps, things not yet checked on real hardware) is in
`PORTING-PLATFORMS.md`; the native addon and its checks are in `native/README.md`.
