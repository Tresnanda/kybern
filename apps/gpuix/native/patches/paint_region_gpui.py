# Region submission for passive native loops; no geometry, layout or hit changes.
s='crates/gpui/src/scene.rs'
edit(s, '    repaint_slots:', '''    /// Identity of the last ordinary scene reconstruction.
    pub paint_generation: u64,
    /// Union of passive leaf geometry touched since that reconstruction.
    pub passive_paint_bounds: Option<Bounds<ScaledPixels>>,
    /// Separate leaf regions avoid repainting the empty space between loaders.
    pub passive_paint_regions: std::collections::HashMap<u64, Bounds<ScaledPixels>>,
    repaint_slots:''')
edit(s, '        self.repaint_slots.clear();', '        self.repaint_slots.clear();\n        self.passive_paint_bounds = None;\n        self.passive_paint_regions.clear();', count=2)
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
            self.passive_paint_regions.entry(id).and_modify(|old| *old = old.union(&bounds)).or_insert(bounds);
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
for name in ['paint_region_renderer.rs','paint_region_present.rs','paint_region_cull.rs','paint_region_atlas.rs','paint_region.metal']:
    dest=root/'crates/gpui_apple/src'/name
    text=(here/name).read_text()
    if not dest.exists() or dest.read_text()!=text: dest.write_text(text)

# Bounded per-command GPU timings. No wait, counter sampling or callback exists
# unless diagnostics are explicitly enabled.
edit(m, '        self.paint_region_scissor = None;\n        if retained.is_some()', '''        self.trace_paint_region(&command_buffer, scene, viewport_size, retained.is_some(), if std::env::var("KYBERN_GPU_TRACE_SPLIT").as_deref() == Ok("1") { "scene" } else { "frame" });
        self.paint_region_scissor = None;
        if retained.is_some()''')

# Keep one render pass, but replay into disjoint damage rectangles. A single
# union spanning sidebar and transcript redraws most of the window for 2 dots.
edit(m, '        self.clear_paint_region(command_encoder,alpha as f32);', '')
edit(m, '        for batch in scene.batches() {', '''        let damage = self.paint_region_scissor;
        let regions = self.paint_region_rectangles(scene, viewport_size);
        for region in regions {
            self.paint_region_scissor = region;
            if let Some(rect) = region { command_encoder.set_scissor_rect(rect); }
            self.clear_paint_region(command_encoder, alpha as f32);
        for batch in scene.batches() {''')
edit(m, '        command_encoder.end_encoding();\n\n        // Dynamic atlas', '''        }
        self.paint_region_scissor = damage;
        command_encoder.end_encoding();

        // Dynamic atlas''')

# Diagnostic split isolates the scene and full-window copy on the same serial
# queue. Production submission remains a single command buffer.
edit(m, '        if let Some(target) = retained.as_ref() { self.copy_paint_region(&command_buffer,target,drawable.texture(),viewport_size); }', '''        let command_buffer = if let Some(target) = retained.as_ref() {
            if std::env::var("KYBERN_GPU_TRACE_SPLIT").as_deref() == Ok("1") {
                command_buffer.commit();
                let copy = self.command_queue.new_command_buffer().to_owned();
                self.copy_paint_region(&copy, target, drawable.texture(), viewport_size);
                self.trace_paint_region(&copy, scene, viewport_size, true, "copy");
                copy
            } else {
                self.copy_paint_region(&command_buffer, target, drawable.texture(), viewport_size);
                command_buffer
            }
        } else { command_buffer };''')

# The base layer is only presented for ordinary scene generations. Passive
# ticks may present cropped child Metal layers, avoiding a full-window copy.
edit(m, '        let drawable_started = std::time::Instant::now();', """        if self.present_passive_regions(scene, viewport_size) { return; }
        self.clear_passive_region_layers();
        let drawable_started = std::time::Instant::now();""")
pending[m] += '\ninclude!("paint_region_present.rs");\n'

# Group base holes, cropped drawables and layer-tree changes in one CA commit.
# Full redraw/filter/park fallback also restores the base in this transaction.
edit(m, '    fn draw_with_frame_pool(&mut self, scene: &Scene) {', """    fn draw_with_frame_pool(&mut self, scene: &Scene) {
        static REGION_LAYERS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *REGION_LAYERS.get_or_init(||std::env::var("KYBERN_REGION_LAYERS").as_deref()==Ok("1")) && (self.has_passive_region_layers() || (Self::passive_region_enabled() && scene.has_native_paint_animation() && scene.paths.is_empty() && scene.backdrops.is_empty() && scene.surfaces.is_empty())) {
            unsafe {let _: ()=msg_send![objc::class!(CATransaction),begin];let _: ()=msg_send![objc::class!(CATransaction),setDisableActions:YES];}
            let transaction=self.presents_with_transaction;
            self.presents_with_transaction=true;
            if let Some(layer)=self.layer.as_ref(){let mode:bool=unsafe {msg_send![&**layer,presentsWithTransaction]};if !mode {layer.set_presents_with_transaction(true);}}
            self.draw_with_region_transaction(scene);
            unsafe {let _: ()=msg_send![objc::class!(CATransaction),commit];}
            self.presents_with_transaction=transaction;
            if let Some(layer)=self.layer.as_ref(){let wanted=transaction||self.has_passive_region_layers();let mode:bool=unsafe {msg_send![&**layer,presentsWithTransaction]};if mode!=wanted {layer.set_presents_with_transaction(wanted);}}
        } else {self.draw_with_region_transaction(scene);}
    }
    fn draw_with_region_transaction(&mut self, scene: &Scene) {""")

# Direct region passes share one instance upload/command buffer. Fragment
# coordinates remain in full-window space while the viewport/scissor is local.
edit(m, '    paint_region_scissor: Option<metal::MTLScissorRect>,', '    paint_region_scissor: Option<metal::MTLScissorRect>,\n    paint_region_origin: Option<(i64,i64)>,\n    paint_region_command: Option<metal::CommandBuffer>,\n    paint_region_crops: Vec<metal::MTLScissorRect>,\n    paint_region_packed: Vec<(i64,i64)>,\n    paint_region_base_holes: Vec<metal::MTLScissorRect>,')
edit(m, '            paint_region_scissor: None,', '            paint_region_scissor: None,\n            paint_region_origin: None,\n            paint_region_command: None,\n            paint_region_crops: Vec::new(),\n            paint_region_packed: Vec::new(),\n            paint_region_base_holes: Vec::new(),')
edit(m, '        let command_buffer = command_queue.new_command_buffer();', '        let shared_command=self.paint_region_command.clone();\n        let command_buffer=shared_command.as_deref().unwrap_or_else(||command_queue.new_command_buffer());')
edit(m, 'if self.paint_region_scissor.is_some() { None }', 'if self.paint_region_scissor.is_some() && self.paint_region_origin.is_none() { None }')
edit(m, '        let damage = self.paint_region_scissor;', """        let damage = self.paint_region_scissor;""")
edit(m, '        for region in regions {', '        let saved_origin=self.paint_region_origin;\n        for (region_index,region) in regions.into_iter().enumerate() {\n            if let Some(origin)=self.paint_region_packed.get(region_index){self.paint_region_origin=Some(*origin); }\n            if let Some((x,y))=self.paint_region_origin {command_encoder.set_viewport(metal::MTLViewport {originX:-(x as f64),originY:-(y as f64),width:i32::from(viewport_size.width) as f64,height:i32::from(viewport_size.height) as f64,znear:0.,zfar:1.});}')
edit(m, 'if let Some(rect) = region { command_encoder.set_scissor_rect(rect); }', 'if let Some(mut rect) = region { if let Some((x,y))=self.paint_region_origin {rect.x=(rect.x as i64-x).max(0) as u64;rect.y=(rect.y as i64-y).max(0) as u64;} command_encoder.set_scissor_rect(rect); }')
edit(m, '        self.paint_region_scissor = damage;\n        command_encoder.end_encoding();', '        self.paint_region_origin=saved_origin;\n        self.paint_region_scissor = damage;\n        if !self.paint_region_base_holes.is_empty(){\n            self.clear_base_holes(command_encoder);\n        }\n        command_encoder.end_encoding();')

edit(m, '        let alpha = if self.opaque { 1. } else { 0. };', '        let alpha = if self.paint_region_origin.is_some() {0.} else if self.opaque { 1. } else { 0. };')

pending[m] += '\ninclude!("paint_region_cull.rs");\n'

pending[m] += '\ninclude!("paint_region_atlas.rs");\n'
