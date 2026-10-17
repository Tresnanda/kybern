edit("lib.rs", "mod cache_island;", "mod cache_island;\nmod clipboard;")
edit("renderer.rs", "    pub fn zoom_window(&self) -> Result<()> {", '''    pub fn read_clipboard_image(&self) -> Result<Option<crate::clipboard::ClipboardImage>> {
        let image = update_window_without_view(|_, cx| {
            cx.read_from_clipboard().and_then(|item| item.into_entries().find_map(|entry| {
                if let gpui::ClipboardEntry::Image(image) = entry {
                    Some((image.bytes().to_vec(), image.format().mime_type().to_owned(), format!("clipboard.{}", image.format().extension())))
                } else { None }
            }))
        })?;
        Ok(image.map(|(bytes, media_type, name)| crate::clipboard::ClipboardImage { data: bytes.into(), media_type, name }))
    }
    #[napi]
    pub fn read_clipboard_paths(&self) -> Result<Vec<String>> {
        update_window_without_view(|_, cx| {
            cx.read_from_clipboard().map(|item| item.into_entries().flat_map(|entry| {
                if let gpui::ClipboardEntry::ExternalPaths(paths) = entry {
                    paths.paths().iter().filter_map(|path| path.to_str().map(str::to_owned)).collect::<Vec<_>>()
                } else { Vec::new() }
            }).collect()).unwrap_or_default()
        })
    }
    #[napi]
    pub fn simulate_file_drop(&self, x: f64, y: f64, paths: Vec<String>) -> Result<()> {
        if !x.is_finite() || !y.is_finite() || paths.is_empty() { return Err(Error::from_reason("Expected a finite position and nonempty paths")); }
        update_window_without_view(move |window, cx| {
            use gpui::InputEvent;
            let position=gpui::point(gpui::px(x as f32),gpui::px(y as f32));
            let paths=gpui::ExternalPaths(paths.into_iter().map(std::path::PathBuf::from).collect());
            window.dispatch_event(gpui::FileDropEvent::Entered { position, paths }.to_platform_input(),cx);
            window.dispatch_event(gpui::FileDropEvent::Pending { position }.to_platform_input(),cx);
            window.dispatch_event(gpui::FileDropEvent::Submit { position }.to_platform_input(),cx);
            window.dispatch_event(gpui::FileDropEvent::Ended.to_platform_input(),cx);
        })
    }
    #[napi]
    pub fn zoom_window(&self) -> Result<()> {''')
