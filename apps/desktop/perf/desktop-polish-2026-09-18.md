# Desktop polish verification — 2026-09-18

Based on main `2cd0578`. Design work used the requested better-ui, better-layout,
better-typography, better-writing, apple-design and transitions-dev skills,
existing kit controls and Kybern icons.

| Request | Result | Evidence |
| --- | --- | --- |
| This Mac menu | Compact environment rows, clearer connection/selection hierarchy, consistent actions and density | Native chat-fixes, light/dark screenshots |
| Collapsed sidebar | New thread replaces history arrows with the existing blur/fade IconSwap; hidden controls are inert | Actual header fixture checks toggling, focus, action, stable width; shared icon-swap fixture covers reduced motion |
| Active tab shape | Sidebar and Terminal dock selection use the same corner geometry as hover, with squircle support and rounded fallback | Native terminal-shape fixture reports matching 10px corners |
| Image actions | Copy image and Download image for user/agent previews; native macOS PNG clipboard, original bytes through native save dialog | Native PNG/GIF-conversion clipboard round trips; Rust private-pasteboard and file-byte tests; binary IPC/Unicode filename/cancel bridge regression |
| Translucent command menus | Dedicated readable 94% material and one direct backdrop blur for /, @, $ pickers | Native materials checks in light/dark, opaque, reduced transparency and increased contrast; busy-backdrop screenshot |
| Questions and approvals | Previous/Next, editable final review, explicit submit, compact approval footer | [Question and approval report](question-review-2026-09-18.md) |
| Issue 34 | Deterministic descendant cleanup and history anchor synchronization | Same report; original assertion thresholds retained |
| Harness caching | Stable coordinator prefixes, persistent Pi/OMP system addition and OpenCode resume role | [Harness audit](harness-cache-review-2026-09-18.md) |
| RAM | Live canonical-result byte budget, bounded daemon caches, direct CLI serialization, opaque native material lifetime | [Retention report](live-tool-retention-2026-09-18.md) and [whole-app measurements](whole-app-ram-2026-09-18/REPORT.md) |

Image copying converts unsupported clipboard formats to PNG and releases decode
resources afterward. Downloads retain the original file format. Raw binary IPC
avoids per-byte JSON arrays; the save path stays inside Rust and comes only from
the native dialog. ASCII JSON header encoding preserves Unicode names. Cancel
returns false and does not fall through to a browser download. The production
and development CSP allow fetching already-displayable data/blob images; no
additional external origin or script permission was introduced.

Native tests exercised the actual AppKit clipboard and exact persisted bytes.
The OS Save dialog's interactive accept/cancel path was reviewed and the bridge
cancellation contract tested, but was not driven end-to-end in the packaged UI.
Windows/Linux use the browser clipboard path; those platforms were not run here.

Final frontend checks: typecheck, lint, 238 unit tests, production build. Focused
Rust image tests and index-expiry regression pass; daemon/desktop Clippy passes.
The final sidecar-aware `pnpm tauri build --debug --no-bundle` also passes. A
narrow dev-profile override disables stripping for the build-time tauri-macros
library: Rust 1.96 produced a Mach-O string table rejected by macOS 27, verified
by `dlopen` before/after and matching
[Rust issue 157750](https://github.com/rust-lang/rust/issues/157750).
Earlier workspace suites passed except two installed OpenCode live checks whose
external CLI had no configured provider (`ProviderNoProvidersError`). Native
fixtures also cover artifacts, tool leases, materials, questions, composer stack,
header/image chat fixes, Terminal dock shape and history retention. Test fixtures
run in system WebKit at `tauri://localhost` under production CSP.

Screenshots are in the original workspace's
`perf-artifacts/desktop-polish-20260918/`, including `environment-menu.png`,
`command-menu.png`, `terminal-shape.png`, `questions-review.png` and `approval.png`.
They are local review artifacts, not shipped app assets. The installed application
was restored after isolated profiling; its production daemon was not replaced.
