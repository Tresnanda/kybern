//! Window occlusion, miniaturization, and focus as separate signals.
//!
//! Issue #37: an unfocused window can still be visible. Compact reconstructible
//! transcript state only when the window is occluded or minimized — never on
//! blur alone. WebKit's Page Visibility API maps to occlusion on macOS; this
//! native event keeps minimized/focused/occluded distinct for the React app.

use serde::Serialize;
use tauri::{Emitter, Runtime, WebviewWindow, WindowEvent};

pub const EVENT: &str = "kybern-window-surface";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSurface {
    /// Fully covered by another window, or unmapped. Independent of key-window focus.
    pub occluded: bool,
    pub minimized: bool,
    pub focused: bool,
    /// Compact permission: `occluded || minimized`. Never derived from `focused`.
    pub hidden: bool,
}

impl WindowSurface {
    pub fn new(occluded: bool, minimized: bool, focused: bool) -> Self {
        let surface = Self { occluded, minimized, focused, hidden: false };
        Self { hidden: is_hidden(surface), ..surface }
    }
}

/// Compact permission: occlusion or miniaturize, not a mere focus loss.
pub fn is_hidden(surface: WindowSurface) -> bool {
    surface.occluded || surface.minimized
}

pub fn read<R: Runtime>(window: &WebviewWindow<R>) -> WindowSurface {
    WindowSurface::new(native_occluded(window), window.is_minimized().unwrap_or(false), window.is_focused().unwrap_or(false))
}

#[tauri::command]
pub fn window_surface<R: Runtime>(window: WebviewWindow<R>) -> WindowSurface {
    read(&window)
}

/// Emit surface changes for this webview only. Safe to call more than once.
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    emit(window);
    let win = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Focused(_) | WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            emit(&win);
        }
    });
}

fn emit<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.emit(EVENT, read(window));
}

fn native_occluded<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_occluded(window).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        false
    }
}

#[cfg(target_os = "macos")]
fn macos_occluded<R: Runtime>(window: &WebviewWindow<R>) -> Option<bool> {
    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    // `NSWindowOcclusionStateVisible` is `1 << 1`. Read via the ObjC runtime so
    // we do not depend on an extra objc2-app-kit feature flag.
    const VISIBLE: usize = 1 << 1;
    let occlusion: usize = unsafe {
        let ns_window = &*ptr.cast::<objc2::runtime::AnyObject>();
        objc2::msg_send![ns_window, occlusionState]
    };
    Some(occlusion & VISIBLE == 0)
}

#[cfg(test)]
mod tests {
    use super::{WindowSurface, is_hidden};

    #[test]
    fn blur_alone_is_not_permission_to_discard() {
        assert!(!is_hidden(WindowSurface::new(false, false, false)));
        assert!(!is_hidden(WindowSurface::new(false, false, true)));
        assert!(!WindowSurface::new(false, false, false).hidden);
    }

    #[test]
    fn occluded_or_minimized_windows_are_hidden() {
        assert!(is_hidden(WindowSurface::new(true, false, true)));
        assert!(is_hidden(WindowSurface::new(false, true, false)));
        assert!(WindowSurface::new(true, true, false).hidden);
    }
}
