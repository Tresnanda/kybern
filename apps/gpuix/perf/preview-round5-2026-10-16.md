# Embedded previews and visual replies — round 5

Status: the embedded document path is implemented and exercised in the real GPUIX app. **This is not a 1:1 Tauri parity certification.** Remaining UI/motion differences and validation limits are listed below.

Worktree: `/Users/mymac/projects/ade-gpuix-preview5`, integration base `463d03ca`. No commits or dependency/version changes. The existing integration `.node` was loaded read-only; the task builds a separate, small WebKit companion in its own worktree. No experimental frame scheduler changes were imported.

## Source references and implementation

| Tauri reference | GPUIX implementation |
| --- | --- |
| `apps/desktop/src/state/previewSurface.ts`, `views/dock/preview/PreviewSurfaceLayer.tsx`, `PreviewSlot.tsx` | `src/preview/Surface.tsx`: stable document ownership independent of dock/mini slots; selected dock plus one floating page; device sizing from shared viewport helpers; five-minute hidden dock release/remint. The native host also caps preview documents at two. |
| `apps/desktop/src-tauri/src/preview_relay.rs` | `src/preview/relay.ts`: separate loopback origin per server ticket; root-relative assets and raw WebSocket upgrades; no injected daemon credential; validates configured ticket endpoint, request authority, complete/fragmented header bounds; closes both sockets on release. |
| `apps/desktop/src/state/previewSession.ts` | `src/preview/store.ts`: original-client ticket revocation, stale-response cancellation, relay ownership, bounded history/session metadata, close/environment cleanup. Internal pages now open embedded. Explicit external targets still use the browser. |
| `apps/desktop/src/views/dock/preview/PreviewMiniPlayer.tsx`, `styles/kit.css` | `Preview.tsx`, `MiniChrome.tsx`, `MiniResize.tsx`, `resize.tsx`, shared `live/Floating.tsx`: chat/composer-aware placement, persisted size/corner, opposite-corner resize, native pointer capture lease. Dock/mini moves keep the native document. |
| `apps/desktop/src/views/dock/preview/PreviewDeviceToolbar.tsx`, `deviceViewport.ts`, `kit.css` rails | `Preview.tsx`, `DeviceRails.tsx`: shared presets, validated dimensions, rotation, scale-aware/Shift resize and fit-axis double click. |
| `apps/desktop/src/views/VisualReply.tsx`, `visualFrameSupport.ts`, shared `visuals.ts` | `src/transcript/Visual.tsx`, `preview/theme.ts`: opaque sandboxed visual frame, daemon ticket lifecycle, shared height bounds, bounded measured-height cache, theme/visibility messages, delayed skeleton/watchdog/retry, same document expanded/collapsed. |
| Desktop transcript group `visuals` | `src/transcript/Turn.tsx`: mount `group.visuals`; the previous `group.work.filter(visual)` never mounted published visuals because the shared grouper extracts them. Coordinate this one-line merge with the rich transcript track. |
| Tauri iframe layering beneath native app chrome | `native/webview.m`, `src/native/webview.ts`, `web-occlusion.ts`, composer `Menu.tsx`/`height.ts`: AppKit WKWebView children, clipped observed geometry, rounded popup masks, modal dimming, composer occlusion, input-only resize cutouts and focused-webview app shortcut routing. |
| Tauri packaging | `native/build-webview.ts`, `native/update.sh`, `scripts/package-app.ts`: build/sign and include the separate `kybern-webview.dylib`. The patched GPUIX `.node` is not overwritten by the companion build. Packaged export itself was not run. |

The main-thread native companion uses a fresh nonpersistent website data store per document. The trusted wrapper is served by an exact-path `WKURLSchemeHandler` at `tauri://localhost/embedded/...`, matching the daemon's actual `frame-ancestors` CSP; an `about:blank` wrapper was blocked by that CSP in the real app. File children omit `allow-same-origin`; visual children use only `allow-scripts`. Native message handling rejects untrusted child-frame messages, and navigation/redirect policy restricts frames to the authorized ticket/relay origin. Literal history/reload commands use a separate isolated `WKContentWorld`; no daemon bearer token enters a page.

Commands and callbacks are queued across Bun/AppKit; native events are bounded (512 events, 64 KiB each), wake only on an empty-to-nonempty transition, and carry generations. Visibility updates pause media and send the existing daemon page/visual pause protocol. Window occlusion/minimization is observed without a polling timer. Geometry remains a post-paint observation followed by an asynchronous native placement, so matching compositor-frame timing is not established.

## Verification

Actual runtime: GPUIX 0.10.0 + this AppKit/WKWebView companion, Apple M1, macOS 27.0.1. Scratch installed daemon `/Applications/kybern.app/Contents/MacOS/kybernd` v0.9.1 on port 4237. The original user daemon, its data, PID 28083 and port 4219 were not touched. Synthetic completed transcript events were seeded in the task's scratch database; visual HTML was published and served through actual RPC/tickets/CSP. No agent generation was required.

Artifacts: `/Users/mymac/projects/ade/previews/gpuix/round5/preview/`. Screenshots use **window-only `screencapture -l`**, because GPUI's stock screenshot excludes WKWebView subviews. Source references above are the Tauri comparison; no matching full native Tauri screenshot/resource comparison was run. Existing WebKit fixture evidence is not relabeled as native Tauri.

| Check | Result and evidence |
| --- | --- |
| Four full-app modes: dark/light × normal/reduced motion | PASS via `scripts/preview-app-check.ts`. `app-file-*`, `app-mini-*`, `app-visual-expanded-*`, `app-server-*`, `app-device-*` show the actual embedded views. Native event evidence: `events-*.jsonl`. |
| Real local HTML and localhost server | PASS: file scripts and daemon file-navigation bridge; server `/asset.js` root-relative asset through isolated relay; rotate device without document reload. |
| Identity | PASS: local page canary unchanged through dock → mini → dock; visual canary unchanged through expansion/collapse. Native lab also checks six slot moves and hide/show without new native document. |
| Visual isolation | PASS in all four app modes: `parent.document` denied, origin `null`, localhost fetch blocked by daemon CSP, isolated handler absent from page world, direct forged main-frame native message rejected. |
| Close and environment switch | PASS: app UI close destroys the current preview generation; same scratch-environment reset destroys the old visual generation. Original-client ticket ownership is retained for revocation. |
| Native input and shortcuts | PASS dark/light via `native/webview-check.ts`: in-process AppKit pointer button click increments page counter, text insertion keeps `kept text`, Command-L escapes focused web input, external `https://example.com/` navigation blocked. `host-dock-*`, `host-menu-*` are actual window captures. These are direct AppKit fixture events, not a physical keyboard/IME certification. |
| Pause | PASS: native visibility callback and page pause message on hide; same document after show. Minimization/occlusion observers and media suspension are implemented; media playback/minimized playback itself was not separately measured. |
| Relay | Four focused tests/20 assertions: credentials remain the page's; invalid authority/ticket/header limits rejected; actual raw WebSocket byte splice and close cleanup. |
| Unit/static checks | Final `bun test`: 57 tests/453 assertions. `pnpm typecheck` and direct `bun node_modules/typescript/bin/tsc --noEmit` pass. `git diff --check` passes. Raw outputs `checks-unit.txt`, `checks-types.txt`. No Rust workspace build was needed for the separate companion. |

The latest app run covers slot moves and toolbar rotation; the new resize handles' live physical dragging and double-click behavior are **not separately certified**. Their geometry/validation uses the existing shared pure helpers. The five-minute idle-remint timer was reviewed, not wall-clock exercised.

## Resource sample

`idle-sample.txt` contains the raw 15.02-second sample, taken after app interactions plus a two-second settle with an inline visual and localhost device preview, `GPUIX_BACKGROUND=1`, no activation. No other task UI ran under the atomic UI lock.

| Processes | Physical footprint | CPU (one-core percent) | Accumulated GPU time |
| --- | ---: | ---: | ---: |
| GPUIX Bun process | 196.0 MiB | 1.73% | 2.7 ms |
| Two WebContent + GPU + Networking processes | 45.2 MiB | 0.00% | 0.0 ms |
| Total | 241.2 MiB | 1.73% | 2.7 ms / 15.02 s |

CPU comes from cumulative process CPU time, footprint from `footprint`, GPU from Metal `ioreg` counters. WebKit ownership is attributed by new PIDs between the single locked app launch and sampling; an unrelated user application creating a WebKit process could confound that attribution. This is a settled workload observation, not an active-window energy, frame-cadence, input-latency, streaming, or Tauri-relative claim. Native frame cadence remains a separate track's partial.

## Remaining parity work

- Preview address chrome remains the simpler always-editable field. Tauri's segmented read-only address/breadcrumbs, adaptive toolbar buttons, loading/stop bar, no-cache reload, Show in Explorer, recents, richer probe/error states and proxy toggle are not fully ported. Reload currently remints from the original input, rather than preserving the file bridge path in every case.
- Mini header is currently always visible, rather than hover/focus-revealed with Tauri's 150 ms opacity/translate. Shared Floating's outer radius/material, hysteresis/clamping and entry/exit/reduced-motion snap differ from the exact Tauri player. The full page stays alive, but native WK geometry/opacity does not participate in GPUI's compositor transition on the same frame. This needs a native animation/geometry integration, not a text/browser fallback.
- The transcript visual is embedded and expands without reload, but Tauri's exact figure header/controls, live `visualsAt` placement, full-window expansion choreography, and rounded expanded-frame edges remain partial. Current loading fallback is readable but not an exact copy of the Tauri skeleton.
- Relay currently accepts an HTTP configured daemon endpoint, matching the Rust relay parser used as reference; HTTPS remote-daemon transport is not implemented. Server download handling, all app-specific redirects/auth/cookie workflows, physical IME, reduced transparency and increased contrast are not exhaustively checked.
- The per-document WKWebView companion is macOS-only. This track does not establish cross-platform native web-surface parity.

## Integration and cleanup

Preserve parent task drag immediate-release and Notes outline work. Merge the small `Floating.tsx` optional-prop changes into the motion track's newer implementation; do not replace that file wholesale. Likewise merge only the PopupLayer wrapper/context and composer-height web-occlusion additions into the menu/rich changes. The wrapper deliberately has no padding: observing the padded inner popup shifted the native mask by the padding, discovered in actual captures and corrected.

Disk free space was 117 GiB before this task and 115 GiB before final native checks; the companion/test helper were 156 KiB and scratch data 3.8 MiB. No Cargo targets or disposable dependency installation were created. A read-only-intended `node_modules` symlink reused integration dependencies; running `pnpm typecheck` triggered pnpm's cached policy preparation (+2/-1 packages) through that link, with no package/lock/source diff. Final static checks use direct TypeScript to avoid that path. The symlink and task-generated native binaries/scratch data are removed after preserving these artifacts. The parent must rebuild the companion with `bun native/build-webview.ts` before launching this code. Source changes/worktree registration and the original integration native binary are retained.

Cleanup completed after checking that no process held the generated directories open: own scratch daemon PID 4569 stopped, own scratch directory removed, both small generated dylibs removed, dependency symlink unlinked. Final free space is 117 GiB; other concurrent cleanup also changed this volume, so the change is not attributed to this task. Approximately 11 MiB of window captures and evidence remain in the original conversation's artifact folder. The native UI lock was released after the apps stopped and menus/rich were notified.
