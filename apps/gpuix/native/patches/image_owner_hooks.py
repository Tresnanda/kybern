# The only owning decoded editor cache is IMAGES. Lay is derived geometry,
# and can outlive a detached editor through GPUI input/layout frame references.
r = 'rich_editor.rs'
edit(r, '    image: Option<Arc<gpui::RenderImage>>,', '    image: Option<EditorLayoutImage>,')
edit(r, '                    image = Some(img);', '                    image = Some(EditorLayoutImage::new(&img));')
edit(r, '                if let Some(image) = &lay.image {', '                if let Some(image) = lay.image.as_ref().and_then(EditorLayoutImage::get) {')
edit(r, 'window.paint_image(b, b, Corners::all(px(8.0)), image.clone(), 0, false)',
     'window.paint_image(b, b, Corners::all(px(8.0)), image, 0, false)')
edit(r, 'serde_json::json!({"entries":cache.0.len(),"cpuAndGpuPixelBytesEstimate":',
     'serde_json::json!({"entries":cache.0.len(),"allocatorRelief":editor_image_relief_stats(),"layoutImagesRetainPixels":!editor_layout_image_memory_enabled(),"cacheStrongReferences":cache.0.values().map(|entry| match entry { ImageEntry::Ready(image) => Arc::strong_count(image), ImageEntry::Failed => 0 }).sum::<usize>(),"cpuAndGpuPixelBytesEstimate":')
pending[r] += '\ninclude!("image_owner.rs");\n'

# Purge only after a large batch loses its last CPU owner on document detach.
edit(r, """    for image in drops {
        window.drop_image(image).ok();
    }
}""", """    let released_pixels: usize = drops.iter().filter(|image| Arc::strong_count(image) == 1)
        .map(|image| (0..image.frame_count()).map(|frame| image.as_bytes(frame).map_or(0, <[u8]>::len)).sum::<usize>()).sum();
    for image in drops {
        window.drop_image(image).ok();
    }
    if IMAGES.with(|cache| cache.borrow().0.is_empty()) {
        release_editor_image_pages(released_pixels);
    }
}""")
