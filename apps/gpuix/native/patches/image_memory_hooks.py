i = 'custom_elements/img.rs'
edit(i, '#[derive(Debug, Clone, Default)]\npub struct ImgElement', '#[derive(Debug, Default)]\npub struct ImgElement')
edit(i, '    dropped: Option<std::sync::Arc<gpui::RenderImage>>,', '    dropped: Option<std::sync::Arc<gpui::RenderImage>>,\n    image_lease: Option<String>,')
edit(i, '''        let src = src.trim();
        self.source = if src.is_empty() {''', '''        let src = src.trim();
        if self.image_lease.as_deref() == Some(src) { return; }
        if let Some(old) = self.image_lease.take() { release_image(&old); }
        self.image_lease = Some(src.to_owned());
        self.source = lease_image(src, || if src.is_empty() {''')
edit(i, '''            ImgSource::Path(src.into())
        };''', '''            ImgSource::Path(src.into())
        });''')
edit(i, '        self.source = ImgSource::Render(image);', '        if let Some(src) = self.image_lease.take() { release_image(&src); }\n        self.source = ImgSource::Render(image);')
# Drop also covers a retained adapter replaced by a different custom element.
pending[i] += '''
impl Drop for ImgElement {
    fn drop(&mut self) {
        if let Some(src) = self.image_lease.take() { release_image(&src); }
    }
}
''' + (Path(__file__).parent / 'image_memory.rs').read_text()
r = 'renderer.rs'
edit(r, 'return update_window_without_view(move |_, cx| crate::rich_editor::set_image(src, bytes, cx))?;', '''return update_window_without_view(move |window, cx| {
            let result = crate::rich_editor::set_image(src, bytes, cx);
            crate::rich_editor::trim_images(window, cx);
            result
        })?;''')
edit(r, '''        // Clean up scroll handles for destroyed elements (IDs removed from tree).''', '''        // Complete the draw before evicting: a newly mounted lightbox/overscan
        // row must acquire its lease before its old owner can be reclaimed.
        cx.defer_in(window, |_, window, cx| {
            crate::custom_elements::img::trim_image_memory(window, cx);
            crate::rich_editor::trim_images(window, cx);
        });

        // Clean up scroll handles for destroyed elements (IDs removed from tree).''')
edit(r, '    pub fn zoom_window(&self) -> Result<()> {', '''    pub fn has_rich_editor_image(&self, src: String) -> Result<bool> {
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |_, _| Ok(crate::rich_editor::has_image(&src)))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("The rich editor is currently macOS-only"))
    }

    #[napi]
    pub fn get_memory_stats(&self) -> Result<serde_json::Value> {
        #[cfg(target_os = "macos")]
        return update_window_without_view(move |window, cx| Ok(serde_json::json!({
            "images":crate::custom_elements::img::image_memory_stats(cx),
            "editorImages":crate::rich_editor::image_memory_stats(),
            "metalGauges":gpui::memory_debug_stats(),
            "elementArenaBytes":window.element_arena_memory_bytes(),
            "layoutNodeHighWater":window.layout_memory_peak_nodes(),
        })))?;
        #[cfg(not(target_os = "macos"))]
        Err(Error::from_reason("Memory counters are currently macOS-only"))
    }

    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')
