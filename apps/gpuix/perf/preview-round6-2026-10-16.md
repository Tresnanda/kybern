# Preview chrome and HTTPS relay — round 6

Worktree: `/Users/mymac/projects/ade-gpuix-preview6`, seeded integration HEAD. This is a focused preview follow-up, not a 1:1 GPUIX/Tauri parity certification. No commits, dependency installations or Rust builds. The integration native addon is loaded read-only; only the small WKWebView companion is rebuilt locally.

## Source mapping

| Actual desktop source | GPUIX change |
| --- | --- |
| `views/dock/preview/PreviewChromeRow.tsx`, `previewAddress.ts`, shared `previewTarget.ts` | `src/preview/Chrome.tsx`, `address.ts`: segmented read-only address/breadcrumbs; click/Command-L enters editing with full selection; blur/Escape cancel; submit; bridge-aware copy/browser/reload; disabled history; Forward hides below 360px; device/float actions move to More; local proxy checkbox; reload without cache; remote file browser action disabled. |
| `state/previewSession.ts`, `views/dock/preview/PreviewStates.tsx` | `store.ts`, `States.tsx`, `Surface.tsx`: daemon probes, blocked/DNS/TLS/HTTP/not-HTTP states, waiting retry at 2s for up to 60s only while visible/mounted, relay failure, file-not-found on reload, permission text, loading/stop with 15s ceiling, stale-generation cancellation. Local servers start direct; remote servers require relay. |
| `state/previewRecents.ts`, `PreviewEmptyState.tsx`, shared `previewRecents.ts` | `recents.ts`, `Preview.tsx`: environment/project-scoped persisted recents, shared dedupe/cap/parse functions, reopen/remove, relative timestamps; visible empty server list refreshes every 3s; no mounted/hidden background scans. |
| `PreviewChromeRow.tsx` Show file in Explorer | Parent-authorized `dock/explorerSelection.ts` and minimal `dock/Explorer.tsx` effects: consume once, validate environment/revision/thread/project/workspace, expand/load ancestors, reveal/focus row. User tree interaction cancels pending reveal. Unrelated thread/project Explorers leave the intended request pending; stale matching requests are discarded. Show and enablement use the current bridge file path without query/hash (the actual Tauri source still uses its original target path; this correction follows the parent review). The files API is project-root-based: another worktree is not silently mapped to a same-named project file; that action is disabled for an unrepresentable path. |
| `src-tauri/src/preview_relay.rs` | `relay.ts`: HTTP plus certificate- and hostname-validated HTTPS upstream; HTTP/1.1 ALPN; wait for secureConnect before forwarding; configured origin/ticket/authority bounds; reject traversal out of the ticket; preserve original nested path/query/fragment, page cookies/Authorization and raw WebSocket bytes. Optional test CA never disables TLS validation. No daemon bearer credential enters the relay or page. WebSocket failure notice is wired. |
| Desktop iframe `location.replace` navigation | `native/webview.m` + `src/native/webview.ts`: validated native navigate operation in the isolated `KybernPreview` content world. Reloads exact bridge path/query/fragment; equal current URL explicitly reloads (otherwise same-hash `replace` can be a no-op); changed URL replaces history. Main-frame-only host messages and sandbox policies remain unchanged. Fresh files remint a ticket at the actual bridge path. |

`docs/design.md` and `docs/architecture.md` are absent in both this branch and the original conversation checkout. Actual desktop source, kit CSS, `PORTING.md`, native/performance guides and round-5 report were read instead. Current Node TLS documentation was fetched with Context7 before implementing the TLS path.

## Validation

Runtime: Bun 1.4.0, GPUIX 0.10.0 with the accepted integration addon, AppKit/WKWebView companion, Apple M1/macOS 27.0.1. Scratch installed daemon v0.9.1 on port 4256. No agent generation, user daemon/data, remote SSH machine, certificate store modification or native runtime installation.

Artifacts live in the original conversation folder: `/Users/mymac/projects/ade/previews/gpuix/round6/preview/`. Window captures use `screencapture -l`, which includes the real WKWebView children.

- Unit suite: **72 tests / 541 expectations pass**; direct TypeScript and `git diff --check` pass. Raw outputs `checks-unit.txt`, `checks-types.txt`. Focused tests cover actual TLS with a temporary signed test CA, untrusted/hostname mismatch rejection before any request reaches upstream, HTTP/root assets/page credentials/WebSocket bytes, traversal/authority/header bounds, exact bridge reload URLs, stale probe/open/launch and session cleanup, probe state/proxy/wait timestamp, and one-shot/stale Explorer handoff. Temporary CA keys are removed by the test.
- Separate WKWebView companion builds and signs successfully. The integration `.node` is not rebuilt or overwritten.
- Native chrome matrix: **PASS all four modes: dark/light × normal/reduced motion**, final source, via `scripts/preview-chrome-check.ts`. `checks-native.txt` contains the four passing results; `chrome-events-*.jsonl` and `chrome-*.png` contain real native state/message evidence and window captures. Each mode covers segmented address/edit/Escape/Command-L, ordinary reload at actual bridge path/query/hash, fresh file ticket, current-file Explorer selection and visible ancestors **before** fresh remint updates the original entry, blocked-state proxy activation/deactivation, nested server/root assets, no-cache server query, loading/stop, connection-refused waiting, recents and removal. The test waits for actual formatted Explorer output. The gate exposed and fixed same-URL fragment reload and Command-L on a remounted pane. A test-only timing correction waits for an already-resolving slow request to settle before typing the next address; stop follows the desktop loading-state contract. The full 60-second wait ceiling and narrow adaptive toolbar are source/unit-reviewed, not wall-clock/native narrow-layout exercised.

## Remaining limits

- Native mini-header hover/focus 150ms reveal and its geometry remain round-5 partial; the existing always-visible header is retained. Same-compositor-frame WK placement/opacity, exact mini entry/exit/snapping and 60fps are not established here.
- Loading progress uses native width interpolation with the desktop's 5.3s curve and reduced-motion settled width; exact Tauri glow, final completion/fade and IconSwap choreography remain partial.
- Recents/state spacing, skeletons, native focus/hover transitions and adaptive narrow-toolbar appearance are implemented from source but not a pixel-equivalence certification. No matched full native Tauri screenshot/resource comparison was run.
- HTTPS transport is integration-tested on a local TLS server with explicit test trust. This is not remote SSH validation, nor exhaustive remote authentication/cookie/redirect/download/IME coverage. Remote file/browser restrictions are implemented; real remote daemon UI remains unverified.
- Native web surfaces remain macOS-only. No global feature/motion parity checkbox should be completed solely from this work.

## Integration and cleanup

Integrate all focused tracked and new files listed by `git status`; no composer/menu/motion/editor files were changed. Cross-owner edits are limited to the parent-authorized `dock/Explorer.tsx` selection effects. The PopupLayer observer wrapper and `Floating` optional corner props are preserved.

Before launching, rebuild `bun native/build-webview.ts` in the receiving checkout; do not copy this task's dylib. Direct `bun node_modules/typescript/bin/tsc --noEmit` avoids pnpm lifecycle mutation through the temporary dependency symlink.

Free volume space before work: 117 GiB. Own generated companion: about 100 KiB; scratch before UI: 1.4 MiB. Final free space: **117 GiB**. After checking open files, own daemon PID 52729 on 4256 was stopped; own scratch data (2.8 MiB), local companion build (100 KiB), and dependency symlink were removed. The integration addon/dependency tree and user daemon on 4219 were untouched. About 14 MiB of window captures, event logs and check evidence remain in the original conversation artifact folder. The UI lock was released after every fixture stopped; no own native UI remains. Source/worktree registration is retained. No new performance/resource improvement is claimed from this work.
