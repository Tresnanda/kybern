//! Native titlebar gestures. macOS does not implement WindowControlArea hit tests.
use gpui::{Div, Stateful, prelude::*};

pub(crate) fn apply(el: Stateful<Div>) -> Stateful<Div> {
    el.window_control_area(gpui::WindowControlArea::Drag).on_mouse_down(gpui::MouseButton::Left, |event, window, cx| {
        if event.click_count == 2 {
            // Zoom, minimize or nothing, per System Settings › Desktop & Dock
            // ("Double-click a window's title bar to"), like a native title bar.
            window.titlebar_double_click();
        } else {
            // Uses AppKit's current NSEvent; synthetic GPUI events cannot move a window.
            window.start_window_move();
        }
        cx.stop_propagation();
    })
}
