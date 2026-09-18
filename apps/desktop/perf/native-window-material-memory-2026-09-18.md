# Native window material memory

## Finding

The desktop's **Use translucent surfaces** preference changed CSS only. Tauri's
configured `underWindowBackground` material remained as a full-window
`NSVisualEffectView` even when the preference was off and every visible surface
was opaque. That view had no visual contribution in opaque mode but stayed in
the native window hierarchy for the lifetime of each desktop window.

Tauri 2.11.5 exposes `set_effects(None)`, but its macOS implementation does not
clear an existing effect. The Tauri-owned `window-vibrancy` 0.6.0 crate does
provide `clear_vibrancy`; it removes the tagged effect view from its superview.
Apple documents that removing a view unlinks it from its window and releases it.
The same crate and exact version were already present in `Cargo.lock`; it is now
an explicit macOS dependency so the shell can use its supported clear operation.

The theme provider synchronizes the native material with the existing stored
preference. Each call clears first, then recreates exactly one
`underWindowBackground` view only when translucency is enabled. Clearing first
makes React StrictMode remounts and repeated preference changes idempotent.
Opaque CSS remains authoritative if a best-effort native call fails. The
shipping translucent appearance and active material are unchanged.

## Exploratory native diagnostic

These runs overlapped unrelated builds and native fixtures. They were not taken
in a coordinated quiet window and are **not an accepted before/after comparison**.
The numbers below only describe the diagnostic that motivated the lifecycle
review; they must not be used to claim an application-memory optimization.

Apple M1, 16 GiB, macOS 27.0, system WKWebView. The real scrolling fixture ran
at `tauri://localhost` under the production CSP, 1100 × 720 CSS pixels, dark
opaque content, with fresh processes and no forced GC. A diagnostic wrapper
placed an AppKit `underWindowBackground` effect behind the identical WKWebView;
the diagnostic source was reverted after the runs. Three alternating runs per
mode exercised 160 historical turns, 800-tool mixed work, streaming, expanded
thinking/tools, and long code. Every effect-off run passed all 1,600 rendering
samples and anchor/content checks.

| WebContent lifetime peak | Three runs | Median |
| --- | ---: | ---: |
| No native effect | 405.0, 405.0, 446.1 MiB | 405.0 MiB |
| Native effect active | 416.4, 411.1, 466.9 MiB | 416.4 MiB |

The exploratory median difference was 11.4 MiB in this synthetic sequence.
Ranges overlap, history-only peak medians moved in the opposite direction, and
other activity was running on the machine, so this is not savings evidence.
Two
effect-active runs passed rendering; the third failed an existing rendering
gate while still producing all eight memory samples. It is excluded from any
correctness claim but retained in the memory range above. Frame p95 was 17–19 ms
in the recorded passing runs. CPU, energy, WindowServer memory, and a two-hour
ordinary-use workload were not measured.

This experiment does not establish an isolated native-material cost and is not
a complete Tauri coalition measurement. It does not supersede the mixed
full-application results in the 0.4.3 report, and it does not address the user's
ordinary-session high-water mark or page-aware transcript reconstruction.
Translucent mode intentionally retains its native material and cost because it
is visible product behavior.

## Sources and dependency review

- [Tauri 2.11.5 source](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/webview_window.rs)
  documents that window effects require transparency and that `None` clears
  effects only "if possible"; its macOS backend currently has no clear branch.
- The official [tauri-apps/window-vibrancy](https://github.com/tauri-apps/window-vibrancy)
  documentation lists both `apply_vibrancy` and `clear_vibrancy` for macOS 10.10+.
- Apple AppKit documents [`underWindowBackground`](https://developer.apple.com/documentation/appkit/nsvisualeffectview/material-swift.enum/underwindowbackground)
  as a behind-window material and [`removeFromSuperview`](https://developer.apple.com/documentation/appkit/nsview/removefromsuperview())
  as unlinking and releasing the view.
- Socket's package page was checked before making the transitive crate explicit;
  its Cloudflare challenge did not expose a report to this non-browser client.
  No new package version or lockfile source was introduced.

## Verification

- Exploratory effect-off native scrolling runs passed the unchanged memory and
  rendering guards; the first full run reported 17–18 ms frame p95 and no empty
  viewport or visible jump above 0.5 px.
- The TypeScript bridge test verifies both preference states call the scoped
  native command with the exact boolean.
- `cargo check -p kybern-desktop`, `cargo build -p kybern-desktop`,
  `cargo test -p kybern-desktop`, and desktop Clippy pass.
- Desktop typecheck, lint, production web build, and all 234 tests pass.
- The sidecar-aware `pnpm tauri build --debug --no-bundle` staged an isolated
  debug daemon and completed the production web build, but its final shell
  compilation failed in upstream Tauri 2.11.5 with `E0463` (Rust could not find
  `tauri_macros`). Retrying after successful direct shell builds reproduced the
  artifact-resolution failure; it is recorded as an environment limitation,
  not presented as a passing packaged build.
