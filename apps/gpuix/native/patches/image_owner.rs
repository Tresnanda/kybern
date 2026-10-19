// Derived editor geometry must not own decoded pixels. The document cache
// protects mounted documents and undo/redo sources; detached GPUI input/layout
// state may outlive its host and can retain only a non-owning image reference.
enum EditorLayoutImage {
    Borrowed(std::sync::Weak<gpui::RenderImage>),
    LegacyOwned(Arc<gpui::RenderImage>),
}

fn editor_layout_image_memory_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("KYBERN_EDITOR_LAYOUT_IMAGE_MEMORY").as_deref() != Ok("0"))
}

impl EditorLayoutImage {
    fn new(image: &Arc<gpui::RenderImage>) -> Self {
        if editor_layout_image_memory_enabled() {
            Self::Borrowed(Arc::downgrade(image))
        } else {
            Self::LegacyOwned(image.clone())
        }
    }

    fn get(&self) -> Option<Arc<gpui::RenderImage>> {
        match self {
            Self::Borrowed(image) => image.upgrade(),
            Self::LegacyOwned(image) => Some(image.clone()),
        }
    }
}

// Darwin caches freed large allocations as dirty resident pages. A detached
// image-heavy document is a natural trim boundary; never purge per paint,
// per decode, while another document owns images, or for small releases.
thread_local! {
    static EDITOR_IMAGE_RELIEF: std::cell::Cell<(usize, usize, u128, u128)> = const { std::cell::Cell::new((0, 0, 0, 0)) };
}

fn editor_image_relief_stats() -> serde_json::Value {
    EDITOR_IMAGE_RELIEF.with(|stats| {
        let (calls, bytes, total_us, max_us) = stats.get();
        serde_json::json!({"calls":calls,"releasedBytes":bytes,"totalUs":total_us,"maxUs":max_us})
    })
}

fn release_editor_image_pages(released_pixels: usize) {
    if released_pixels < 8 * 1024 * 1024
        || std::env::var("KYBERN_EDITOR_IMAGE_RELIEF").as_deref() == Ok("0") { return; }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // Bound the requested relief to this batch (allowing allocator size
        // class rounding), capped at 256 MiB. All batch Arcs are already gone.
        let goal = released_pixels.saturating_mul(2).min(256 * 1024 * 1024);
        let started = std::time::Instant::now();
        let bytes = unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), goal) };
        let elapsed = started.elapsed().as_micros();
        EDITOR_IMAGE_RELIEF.with(|stats| {
            let (calls, released, total, max) = stats.get();
            stats.set((calls + 1, released.saturating_add(bytes), total + elapsed, max.max(elapsed)));
        });
    }
}
