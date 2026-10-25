//! WP10 spike (Windows): how `native/webview.m` maps onto WebView2 visual hosting. See `apps/gpuix/WEBVIEW-PLATFORMS.md`.
//!
//! - `mask`: the clip/occlusion model shared by painting and the pointer filter (unit-tested on any host).
//! - `host` (Windows only): a Windows.UI.Composition `DesktopWindowTarget` (topmost) on GPUI's HWND, one
//!   `ICoreWebView2CompositionController` per document under a clipped `ContainerVisual`, the eased fade/scale, the
//!   wrapper served from `http://tauri.localhost/embedded/<id>`, navigation policy, the message bridge, ⌃ shortcuts,
//!   mouse forwarding, and the CDP calls for the isolated world and snapshots.
//!
//! Compile-checked with `cargo check --target x86_64-pc-windows-msvc`; it has never run.

pub mod mask;

#[cfg(windows)]
pub mod host;
