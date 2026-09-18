//! Keep the native macOS traffic lights centered on the 46px toolbar.
//!
//! Tauri applies `trafficLightPosition` (from `tauri.conf.json`) only inside the
//! window view's `draw_rect`. After the window first paints, macOS moves the
//! standard window buttons back to their default (high) origin and nothing
//! repaints to correct them, so the dots snap up until a manual resize forces a
//! redraw. We re-inset them ourselves on show and on every event that triggers
//! the reset, so they stay level with the sidebar toggle + back/forward glyphs.
//!
//! The inset math mirrors tao's own `inset_traffic_lights`. `INSET_Y` must match
//! `trafficLightPosition.y` in `tauri.conf.json` and `MAC_TRAFFIC_LIGHT_POSITION_Y_PX`
//! in `src/lib/kit/desktopChrome.ts`.

use objc2_app_kit::{NSWindow, NSWindowButton};
use tauri::{Runtime, WebviewWindow, WindowEvent};

/// Leading inset from the window edge to the first button. Matches `x` in
/// `trafficLightPosition`.
const INSET_X: f64 = 16.0;
/// Vertical inset added to the button height to lower the dots onto the toolbar
/// centerline. Matches `y` in `trafficLightPosition`.
const INSET_Y: f64 = 25.0;

/// Re-position the close/miniaturize/zoom buttons. Must run on the main thread.
///
/// # Safety
/// `window` must be a live `NSWindow` and this must be called on the main thread.
unsafe fn apply(window: &NSWindow) {
    let (Some(close), Some(miniaturize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };

    // Frame captured before we grow the container, matching tao's ordering.
    let close_rect = close.frame();

    // Grow the title-bar container so the buttons may sit lower than the default.
    // SAFETY: called on the main thread with live views (see `apply` contract).
    let container = unsafe { close.superview().and_then(|s| s.superview()) };
    if let Some(container) = container {
        let height = close_rect.size.height + INSET_Y;
        let mut rect = container.frame();
        rect.size.height = height;
        rect.origin.y = window.frame().size.height - height;
        container.setFrame(rect);
    }

    let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
    for (i, button) in [&close, &miniaturize, &zoom].into_iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = INSET_X + (i as f64) * space_between;
        button.setFrameOrigin(origin);
    }
}

/// Schedule a re-inset on the window's main thread. Safe to call from any thread.
fn reinset<R: Runtime>(window: &WebviewWindow<R>) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ptr) = win.ns_window() {
            if !ptr.is_null() {
                // SAFETY: on the main thread `ptr` is the live NSWindow for `win`.
                unsafe { apply(&*(ptr as *const NSWindow)) };
            }
        }
    });
}

/// Install the traffic-light centering for a window: apply it now, again shortly
/// after (to beat the post-show reset if no event fires), and on every event that
/// re-lays out the title bar.
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    reinset(window);

    // The reset lands asynchronously after the first paint; a few short delays
    // cover the window whether or not a resize/focus event accompanies it.
    for delay_ms in [50_u64, 200, 500] {
        let win = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            reinset(&win);
        });
    }

    let win = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ThemeChanged(_) | WindowEvent::Focused(true)) {
            reinset(&win);
        }
    });
}
