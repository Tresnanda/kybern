# Region submission for passive native loops; no geometry, layout or hit changes.
s='crates/gpui/src/scene.rs'
edit(s, '    repaint_slots:', '''    /// Identity of the last ordinary scene reconstruction.
    pub paint_generation: u64,
    /// Union of passive leaf geometry touched since that reconstruction.
    pub passive_paint_bounds: Option<Bounds<ScaledPixels>>,
    repaint_slots:''')
edit(s, '        self.repaint_slots.clear();', '        self.repaint_slots.clear();\n        self.passive_paint_bounds = None;', count=2)
edit(s, '    pub fn finish(&mut self) {', '''    /// Whether this scene contains a visible declarative passive-paint loop.
    pub fn has_native_paint_animation(&self) -> bool {
        self.repaint_tags.values().any(|(_,_,_,animation,_)| animation.is_some())
    }

    pub fn finish(&mut self) {
        static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        self.paint_generation = GENERATION.fetch_add(1,std::sync::atomic::Ordering::Relaxed);''')
edit(s, '            let color = color.opacity(inherited_opacity);', '''            let color = color.opacity(inherited_opacity);
            let bounds = match &self.paint_operations[index] {
                PaintOperation::Primitive(primitive) => primitive.bounds().intersect(&primitive.content_mask().bounds),
                _ => unreachable!("validated paint primitive"),
            };
            self.passive_paint_bounds = Some(self.passive_paint_bounds.map_or(bounds, |old| old.union(&bounds)));''')
m='crates/gpui_apple/src/metal_renderer.rs'
edit(m, '    pub fn update_drawable_size(&mut self, size: Size<DevicePixels>) {', '''    pub fn update_drawable_size(&mut self, size: Size<DevicePixels>) {
        self.release_passive_region_target();''')
edit('crates/gpui_macos/src/window.rs', '''        } else {
            lock.stop_display_link();
        }
    }
}

extern "C" fn window_did_resize''', '''        } else {
            lock.stop_display_link();
            lock.renderer.release_passive_region_target();
        }
    }
}

extern "C" fn window_did_resize''')
edit(m, '    backdrop_resources: Option<BackdropResources>,', '    paint_region_resources: Option<PaintRegionResources>,\n    paint_region_scissor: Option<metal::MTLScissorRect>,\n    backdrop_resources: Option<BackdropResources>,')
edit(m, '            backdrop_resources: None,', '            paint_region_resources: None,\n            paint_region_scissor: None,\n            backdrop_resources: None,')
edit(m, '        let command_buffer = match self.render_frame(scene, drawable.texture(), viewport_size) {', '''        let retained = match self.paint_region_target(scene,viewport_size) {
            Ok(value) => value,
            Err(error) => { log::error!("passive region setup: {error:#}"); self.paint_region_scissor=None; None },
        };
        let target = retained.as_deref().unwrap_or(drawable.texture());
        let command_buffer = match self.render_frame(scene, target, viewport_size) {''')
edit(m, '        if self.presents_with_transaction {', '''        self.paint_region_scissor = None;
        if retained.is_some() { self.paint_region_resources.as_mut().unwrap().generation = scene.paint_generation; }
        if let Some(target) = retained.as_ref() { self.copy_paint_region(&command_buffer,target,drawable.texture(),viewport_size); }
        if self.presents_with_transaction {''')
edit(m, '                log::error!("failed to render: {error:#}");', '                self.paint_region_scissor = None;\n                log::error!("failed to render: {error:#}");')
edit(m, '            Some(metal::MTLClearColor::new(0., 0., 0., alpha)),', '''            if self.paint_region_scissor.is_some() { None } else { Some(metal::MTLClearColor::new(0., 0., 0., alpha)) },''')
edit(m, '        if scene.backdrops.is_empty()', '        self.clear_paint_region(command_encoder,alpha as f32);\n        if scene.backdrops.is_empty()')
pending[m] += '\ninclude!("paint_region_renderer.rs");\n'
for name in ['paint_region_renderer.rs','paint_region.metal']:
    dest=root/'crates/gpui_apple/src'/name
    text=(here/name).read_text()
    if not dest.exists() or dest.read_text()!=text: dest.write_text(text)
