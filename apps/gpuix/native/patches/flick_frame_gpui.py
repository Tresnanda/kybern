# test-support's eager flush loop must not starve native display callbacks.
# Reconstruct from the checked-in predecessor each time, like scroll_gpui.py.
dest = root / "crates/gpui/src/scroll_input.rs"
source = (here / "scroll_input.rs").read_text()
old = '*ENABLED.get_or_init(||std::env::var("KYBERN_INPUT_FRAME_DRAW").as_deref()==Ok("1"))'
new = '*ENABLED.get_or_init(||std::env::var("KYBERN_INPUT_FRAME_DRAW").as_deref()!=Ok("0"))'
if source.count(old) != 1:
    raise SystemExit("flick_frame: expected one frame-draw switch")
source = source.replace(old, new).replace(
    "pub(crate) fn scroll_input_frame_draw_enabled() -> bool {",
    "// The normal platform-frame dirty-window path remains enabled. Only the\n"
    "// automation feature's eager per-effect draw loop is bypassed. Zero is the\n"
    "// same-addon diagnostic control; no new timer or idle frame is requested.\n"
    "pub(crate) fn scroll_input_frame_draw_enabled() -> bool {",
)
source = source.replace("    paint: Option<(std::time::Instant, std::time::Instant, usize)>,", "    paint: Option<(std::time::Instant, std::time::Instant, usize)>,\n    test_clock_paused: bool,")
source += """
impl Window {
    /// Preserve eager deterministic painting while automation owns the clock.
    pub fn kybern_set_test_clock_paused(&mut self, paused: bool) {
        self.scroll_input.test_clock_paused = paused;
    }
    pub(crate) fn kybern_test_clock_paused(&self) -> bool {
        self.scroll_input.test_clock_paused
    }
}
"""
edit("crates/gpui/src/app.rs", "(!crate::window::scroll_input_frame_draw_enabled() && window.invalidator.is_dirty()).then_some(window.handle)", "((!crate::window::scroll_input_frame_draw_enabled() || window.kybern_test_clock_paused()) && window.invalidator.is_dirty()).then_some(window.handle)")
if not dest.exists() or dest.read_text() != source:
    dest.write_text(source)

# Explicit synchronous layout inspection remains a paint barrier. Do not borrow
# GpuixView while using it: native callers use update_window_without_view.
edit("crates/gpui/src/window.rs", "    /// Reuse root-relative layout geometry for a retained, unchanged scroll row.\n    pub fn cache_scroll_layout(&mut self, id: LayoutId, key: [u64; 3]) {", """    /// Finish a dirty layout before an explicit synchronous geometry snapshot.
    /// Ordinary input, observers and clean reads remain display paced.
    pub fn kybern_prepare_snapshot(&mut self, cx: &mut App) {
        if self.invalidator.is_dirty() {
            self.draw(cx).clear(cx);
        }
    }

    /// Reuse root-relative layout geometry for a retained, unchanged scroll row.
    pub fn cache_scroll_layout(&mut self, id: LayoutId, key: [u64; 3]) {""")
