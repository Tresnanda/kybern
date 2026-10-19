# The only owning decoded editor cache is IMAGES. Lay is derived geometry,
# and can outlive a detached editor through GPUI input/layout frame references.
r = 'rich_editor.rs'
edit(r, '    image: Option<Arc<gpui::RenderImage>>,', '    image: Option<EditorLayoutImage>,')
edit(r, '                    image = Some(img);', '                    image = Some(EditorLayoutImage::new(&img));')
edit(r, '                if let Some(image) = &lay.image {', '                if let Some(image) = lay.image.as_ref().and_then(EditorLayoutImage::get) {')
edit(r, 'window.paint_image(b, b, Corners::all(px(8.0)), image.clone(), 0, false)',
     'window.paint_image(b, b, Corners::all(px(8.0)), image, 0, false)')
edit(r, 'serde_json::json!({"entries":cache.0.len(),"cpuAndGpuPixelBytesEstimate":',
     'serde_json::json!({"entries":cache.0.len(),"layoutImagesRetainPixels":!editor_layout_image_memory_enabled(),"cacheStrongReferences":cache.0.values().map(|entry| match entry { ImageEntry::Ready(image) => Arc::strong_count(image), ImageEntry::Failed => 0 }).sum::<usize>(),"cpuAndGpuPixelBytesEstimate":')
pending[r] += '\ninclude!("image_owner.rs");\n'
