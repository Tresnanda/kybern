# Native-crate half of image_load_gpui.py: `<img onLoad>` fires once per source, after the frame in which its bitmap
# first became available (or failed), so a fresh image can start its reveal on decode instead of on mount.
c = 'custom_elements/img.rs'
edit(c, '    dropped: Option<std::sync::Arc<gpui::RenderImage>>,\n    image_lease: Option<String>,\n}', '    dropped: Option<std::sync::Arc<gpui::RenderImage>>,\n    image_lease: Option<String>,\n    /// `load` was sent for the current source.\n    load_reported: bool,\n}')
edit(c, '        if self.image_lease.as_deref() == Some(src) { return; }\n', '        if self.image_lease.as_deref() == Some(src) { return; }\n        self.load_reported = false;\n')
edit(c, '        &["click", "mouseEnter", "mouseLeave", "fileDrop"]\n    }\n\n    fn destroy(&mut self) {}\n\n    fn live_image', '        &["click", "mouseEnter", "mouseLeave", "fileDrop", "load"]\n    }\n\n    fn destroy(&mut self) {}\n\n    fn live_image')
edit(c, '''        let mut el =
            crate::accessibility::apply_accessibility(el, ctx.props, Some(gpui::Role::Image));
        el = crate::accessibility::apply_image_label(el, ctx.props, &self.alt);''', '''        if ctx.events.contains("load") && !self.load_reported {
            if let Some(loaded) = image_source(&self.source).and_then(|source| source.kybern_loaded(window, _cx)) {
                self.load_reported = true;
                let (callback, id) = (ctx.event_callback.clone(), ctx.id);
                // After this frame: the handler may set state, which must not re-enter this build.
                window.on_next_frame(move |_, _| crate::renderer::emit_event_full(&callback, id, "load", |payload| payload.value = Some(if loaded { "loaded" } else { "failed" }.into())));
            }
        }
        let mut el =
            crate::accessibility::apply_accessibility(el, ctx.props, Some(gpui::Role::Image));
        el = crate::accessibility::apply_image_label(el, ctx.props, &self.alt);''')
(src / c).write_text(pending[c])
