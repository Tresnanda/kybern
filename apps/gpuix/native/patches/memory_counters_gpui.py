# Diagnostic gauges only. Measurements distinguish driver allocations from
# physical footprint and pixel ownership from allocated atlas texture capacity.
a = 'crates/gpui/src/assets.rs'
edit(a, '/// A source of assets for this app to use.', '''static MEMORY_GPU: [std::sync::atomic::AtomicU64; 6] = [const { std::sync::atomic::AtomicU64::new(0) }; 6];
/// Diagnostic gauges: Metal allocated bytes, instance target/cached bytes,
/// atlas textures, path intermediate and backdrop scratch.
pub fn memory_debug_stats() -> [u64; 6] {
    let mut values = [0; 6];
    for (value, gauge) in values.iter_mut().zip(MEMORY_GPU.iter()) { *value = gauge.load(std::sync::atomic::Ordering::Relaxed); }
    values
}
/// Record renderer diagnostics only when KYBERN_MEMORY_COUNTERS is enabled.
pub fn record_memory_gpu(values: [u64; 6]) {
    for (gauge, value) in MEMORY_GPU.iter().zip(values) { gauge.store(value, std::sync::atomic::Ordering::Relaxed); }
}

/// A source of assets for this app to use.''')
edit('crates/gpui/src/window.rs', '    /// Removes an image from the sprite atlas.', '''    /// Retained frame arena allocation capacity, after its last safe reset.
    pub fn element_arena_memory_bytes(&self) -> usize {
        ELEMENT_ARENA.with(|arena| arena.borrow().capacity())
    }

    /// Removes an image from the sprite atlas.''')
m = 'crates/gpui_apple/src/metal_atlas.rs'
edit(m, '    pub(crate) fn metal_texture(&self, id: AtlasTextureId)', '''    pub(crate) fn allocated_bytes(&self) -> u64 {
        let lock = self.state.lock();
        lock.monochrome_textures.textures.iter().chain(lock.polychrome_textures.textures.iter()).filter_map(Option::as_ref)
            .map(|texture| texture.metal_texture.width() * texture.metal_texture.height() * texture.bytes_per_pixel() as u64).sum()
    }

    pub(crate) fn metal_texture(&self, id: AtlasTextureId)''')
m = 'crates/gpui_apple/src/metal_renderer.rs'
edit(m, '        let instance_buffer_pool = self.instance_buffer_pool.clone();\n        let instance_buffer = Cell::new(Some(writer.finish()));', '''        static MEMORY_COUNTERS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *MEMORY_COUNTERS.get_or_init(|| std::env::var("KYBERN_MEMORY_COUNTERS").as_deref() == Ok("1")) {
            let pool = self.instance_buffer_pool.lock();
            let texture_bytes = |texture: &Option<metal::Texture>| texture.as_ref().map_or(0, |t| t.width() * t.height() * 4);
            gpui::record_memory_gpu([self.device.current_allocated_size(), pool.buffer_size as u64,
                pool.buffers.iter().map(|buffer| buffer.length()).sum(), self.sprite_atlas.allocated_bytes(),
                texture_bytes(&self.path_intermediate_texture), self.backdrop_resources.as_ref().map_or(0, |r| texture_bytes(&r.scratch))]);
        }
        let instance_buffer_pool = self.instance_buffer_pool.clone();
        let instance_buffer = Cell::new(Some(writer.finish()));''')
