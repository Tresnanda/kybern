# A synchronous image snapshot redraws the scene before the normal presentation
# callback updates stroke tiles. Apply the same stroke clock before rasterizing,
# including a paused automation clock. This adds no frame or timer.
w = "crates/gpui/src/window.rs"
anchor = "    pub fn kybern_prepare_snapshot(&mut self, cx: &mut App) {"
edit(w, anchor, '''    /// Complete layout and sample retained strokes for an explicit image snapshot.
    pub fn kybern_prepare_image_snapshot(&mut self, cx: &mut App) {
        self.kybern_prepare_snapshot(cx);
        self.animate_strokes();
    }

''' + '    /// Finish a dirty layout before an explicit synchronous geometry snapshot.\n' + anchor)
(root / w).write_text(pending[w])
