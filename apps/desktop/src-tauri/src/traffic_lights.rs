//! Keep the native macOS traffic lights centered on the 46px toolbar.
//!
//! Tauri applies `trafficLightPosition` (from `tauri.conf.json`) only inside the
//! window view's `draw_rect`. After the window first paints, macOS moves the
//! standard window buttons back to their default (high) origin and nothing
//! repaints to correct them, so the dots snap up until a manual resize forces a
//! redraw. We re-inset them ourselves on show and on every event that triggers
//! the reset, so they stay level with the sidebar toggle + back/forward glyphs.
//!
//! Tauri's own `inset_traffic_lights` still runs on redraw and sizes the
//! container to the button height plus `trafficLightPosition.y`; that must equal
//! `TITLEBAR_HEIGHT` here (14 + 32 = 46), or the two fight. `y` is mirrored in
//! `MAC_TRAFFIC_LIGHT_POSITION_Y_PX` in `src/lib/kit/desktopChrome.ts`.

use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_foundation::NSPoint;
use tauri::{Runtime, WebviewWindow, WindowEvent};

/// Leading inset from the window edge to the first button. Matches `x` in
/// `trafficLightPosition`.
const INSET_X: f64 = 16.0;
/// Height of the web title bar the dots center on (`CHAT_SURFACE_HEADER_HEIGHT_PX`).
const TITLEBAR_HEIGHT: f64 = 46.0;

/// Re-position the close/miniaturize/zoom buttons. Must run on the main thread.
///
/// The container grows to the full title-bar height, and each button is centered
/// on the title bar's midline, measured from the window's top edge. Earlier
/// versions only grew the container and relied on macOS's default button offset,
/// which differed between dev and bundled builds, so the dots sat off the
/// toolbar centerline in one of them.
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

    let window_height = window.frame().size.height;
    // SAFETY: called on the main thread with live views (see `apply` contract).
    let container = unsafe { close.superview().and_then(|s| s.superview()) };
    if let Some(container) = &container {
        let mut rect = container.frame();
        rect.size.height = TITLEBAR_HEIGHT;
        rect.origin.y = window_height - TITLEBAR_HEIGHT;
        container.setFrame(rect);
    }

    let space_between = miniaturize.frame().origin.x - close.frame().origin.x;
    // The midline in window base coordinates (origin at the bottom left).
    let midline = NSPoint::new(0.0, window_height - TITLEBAR_HEIGHT / 2.0);
    for (i, button) in [&close, &miniaturize, &zoom].into_iter().enumerate() {
        let frame = button.frame();
        let mut origin = frame.origin;
        origin.x = INSET_X + (i as f64) * space_between;
        // SAFETY: as above.
        if let Some(parent) = unsafe { button.superview() } {
            let local = parent.convertPoint_fromView(midline, None);
            origin.y = local.y - frame.size.height / 2.0;
        }
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

/// How long after a window opens we keep re-applying the inset, and how often.
/// macOS resets the buttons once its post-paint layout runs, and that lands any
/// time up to ~a couple seconds later depending on how long the webview takes to
/// load. Fixed one-shot delays raced that reset — if it landed after the last
/// delay, the dots stayed high until a manual window resize. Re-applying on a
/// steady cadence across the whole settle window catches the reset whenever it
/// happens, with no resize needed. The calls are idempotent, so they are invisible
/// once the buttons are in place.
const SETTLE_TICKS: u32 = 24;
const SETTLE_INTERVAL_MS: u64 = 120;

/// Install the traffic-light centering for a window: apply it now, keep re-applying
/// across the settle window so the post-paint reset is always caught, and re-apply
/// on every later event that re-lays out the title bar.
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    reinset(window);

    let win = window.clone();
    std::thread::spawn(move || {
        for _ in 0..SETTLE_TICKS {
            std::thread::sleep(std::time::Duration::from_millis(SETTLE_INTERVAL_MS));
            reinset(&win);
        }
    });

    let win = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ThemeChanged(_) | WindowEvent::Focused(true)) {
            reinset(&win);
        }
    });
}
