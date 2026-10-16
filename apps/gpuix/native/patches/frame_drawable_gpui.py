# The embedded AppKit pump drains many events under one outer autorelease pool.
# Drain frame-local Metal objects before the next draw asks for another drawable.
m = 'crates/gpui_apple/src/metal_renderer.rs'
edit(m, '    pub fn draw(&mut self, scene: &Scene) {', '''    pub fn draw(&mut self, scene: &Scene) {
        static FRAME_POOL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *FRAME_POOL.get_or_init(|| std::env::var("KYBERN_FRAME_POOL").as_deref() != Ok("0")) {
            objc::rc::autoreleasepool(|| self.draw_with_frame_pool(scene));
        } else { self.draw_with_frame_pool(scene); }
    }

    fn draw_with_frame_pool(&mut self, scene: &Scene) {''')
edit(m, '    pub fn render_to_image(&mut self, scene: &Scene) -> Result<RgbaImage> {', '''    pub fn render_to_image(&mut self, scene: &Scene) -> Result<RgbaImage> {
        objc::rc::autoreleasepool(|| self.render_to_image_with_frame_pool(scene))
    }

    #[cfg(any(test, feature = "test-support"))]
    fn render_to_image_with_frame_pool(&mut self, scene: &Scene) -> Result<RgbaImage> {''')
edit(m, '        let drawable = if let Some(drawable) = layer.next_drawable() {', '''        let drawable_started = std::time::Instant::now();
        let drawable = if let Some(drawable) = layer.next_drawable() {''')
edit(m, '        let command_buffer = match self.render_frame(scene, drawable.texture(), viewport_size) {', '''        if drawable_started.elapsed().as_millis() > 100 && std::env::var_os("KYBERN_DRAWABLE_TIMES").is_some() {
            eprintln!("[frame-drawable] {:.3} ms transaction={}", drawable_started.elapsed().as_secs_f64()*1000.0, self.presents_with_transaction);
        }
        let command_buffer = match self.render_frame(scene, drawable.texture(), viewport_size) {''')
