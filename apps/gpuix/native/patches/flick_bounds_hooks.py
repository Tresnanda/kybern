# getAutomationTree explicitly requests invalidation; finish that paint before
# returning its bounds snapshot, without eager draws after ordinary effects.
# Drawing through the AnyWindowHandle avoids a reentrant root-view lease.
edit("renderer.rs", '        #[cfg(target_os = "macos")]\n        return Ok(crate::automation::all_bounds());', '        #[cfg(target_os = "macos")]\n        return update_window_without_view(|window, cx| {\n            window.kybern_prepare_snapshot(cx);\n            crate::automation::all_bounds()\n        });')

# Image capture is also an explicit synchronous snapshot. Render the requested
# scene before rasterizing it; a display-paced input may still be pending.
edit("renderer.rs", """            let image = update_window(move |_view, window, cx| {
                cx.notify();
                window.refresh();
                window.render_to_image()
""", """            let image = update_window_without_view(move |window, cx| {
                window.refresh();
                window.kybern_prepare_snapshot(cx);
                window.render_to_image()
""")

# A manually controlled automation clock retains deterministic eager frames.
# This is scoped to its window and ends at clock_resume; runtime input stays paced.
for method in ("pause()", "set_ms(now_ms)", "fast_forward_ms(delta_ms)", "resume()"):
    paused = "false" if method == "resume()" else "true"
    old = "return update_window(move |view, _window, cx| {\n            let now_ms = view.clock." + method + ";"
    new = "return update_window(move |view, window, cx| {\n            window.kybern_set_test_clock_paused(" + paused + ");\n            let now_ms = view.clock." + method + ";"
    edit("renderer.rs", old, new)
