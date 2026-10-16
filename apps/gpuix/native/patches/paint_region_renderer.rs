// A retained color target is used only while a native passive-paint loop is
// visible. Ordinary scenes keep the original direct-to-drawable path.
struct PaintRegionResources {
    target: metal::Texture,
    generation: u64,
    clear: metal::RenderPipelineState,
    copy: metal::RenderPipelineState,
}
impl MetalRenderer {
    /// Parked windows retain no passive-animation color target. The next draw
    /// reconstructs it from the complete scene before applying any damage.
    pub fn release_passive_region_target(&mut self) {
        if self.paint_region_resources.is_some() && std::env::var_os("KYBERN_DEBUG_REGION").is_some() { eprintln!("[paint-region] release"); }
        self.paint_region_scissor = None;
        self.paint_region_resources = None;
    }
    fn paint_region_target(&mut self, scene: &Scene, viewport: Size<DevicePixels>) -> Result<Option<metal::Texture>> {
        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let enabled = *ENABLED.get_or_init(|| std::env::var("KYBERN_REGION_PAINT").as_deref() == Ok("1"));
        // Paths use a second full-size render pass. Filters sample surrounding
        // pixels. Keep those scenes on their established full-render path.
        if !enabled || !scene.has_native_paint_animation() || !scene.paths.is_empty() || !scene.backdrops.is_empty() {
            self.release_passive_region_target();
            return Ok(None);
        }
        let width = i32::from(viewport.width).max(1) as u64;
        let height = i32::from(viewport.height).max(1) as u64;
        if self.paint_region_resources.as_ref().is_none_or(|r| r.target.width()!=width || r.target.height()!=height) {
            if std::env::var_os("KYBERN_DEBUG_REGION").is_some() { eprintln!("[paint-region] allocate {width}x{height}"); }
            let library = self.device.new_library_with_source(include_str!("paint_region.metal"), &metal::CompileOptions::new()).map_err(anyhow::Error::msg)?;
            let vertex = library.get_function("region_vertex",None).map_err(anyhow::Error::msg)?;
            let pipeline = |name: &str| -> Result<metal::RenderPipelineState> {
                let fragment = library.get_function(name,None).map_err(anyhow::Error::msg)?;
                let desc = metal::RenderPipelineDescriptor::new();
                desc.set_vertex_function(Some(&vertex)); desc.set_fragment_function(Some(&fragment));
                let attachment = desc.color_attachments().object_at(0).unwrap();
                attachment.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
                attachment.set_blending_enabled(false);
                self.device.new_render_pipeline_state(&desc).map_err(anyhow::Error::msg)
            };
            let desc = metal::TextureDescriptor::new();
            desc.set_width(width); desc.set_height(height); desc.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
            desc.set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
            desc.set_storage_mode(metal::MTLStorageMode::Private);
            self.paint_region_resources = Some(PaintRegionResources { target: self.device.new_texture(&desc), generation: 0, clear: pipeline("region_clear")?, copy: pipeline("region_copy")? });
        }
        let resources = self.paint_region_resources.as_mut().unwrap();
        self.paint_region_scissor = if resources.generation == scene.paint_generation {
            scene.passive_paint_bounds.map(|bounds| {
                let left = bounds.origin.x.0.floor().max(0.0).min(width as f32) as u64;
                let top = bounds.origin.y.0.floor().max(0.0).min(height as f32) as u64;
                let right = (bounds.origin.x.0+bounds.size.width.0).ceil().max(left as f32).min(width as f32) as u64;
                let bottom = (bounds.origin.y.0+bounds.size.height.0).ceil().max(top as f32).min(height as f32) as u64;
                metal::MTLScissorRect { x:left, y:top, width:right-left, height:bottom-top }
            }).filter(|r| r.width>0 && r.height>0)
        } else { None };
        static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if self.paint_region_scissor.is_some() && std::env::var_os("KYBERN_DEBUG_REGION").is_some() && !REPORTED.swap(true,std::sync::atomic::Ordering::Relaxed) {
            let r=self.paint_region_scissor.unwrap();eprintln!("[paint-region] scissor {},{} {}x{}",r.x,r.y,r.width,r.height);
        }
        Ok(Some(resources.target.clone()))
    }

    fn clear_paint_region(&self, encoder: &metal::RenderCommandEncoderRef, alpha: f32) {
        let Some(scissor) = self.paint_region_scissor else {return;};
        let Some(resources) = self.paint_region_resources.as_ref() else {return;};
        encoder.set_scissor_rect(scissor);
        encoder.set_render_pipeline_state(&resources.clear);
        encoder.set_fragment_bytes(0, mem::size_of_val(&alpha) as u64, &alpha as *const f32 as *const _);
        encoder.draw_primitives(metal::MTLPrimitiveType::Triangle,0,3);
    }

    fn copy_paint_region(&self, command: &metal::CommandBufferRef, target: &metal::TextureRef, destination: &metal::TextureRef, viewport: Size<DevicePixels>) {
        let resources = self.paint_region_resources.as_ref().unwrap();
        let encoder = new_command_encoder_for_texture(command,destination,viewport,None);
        encoder.set_render_pipeline_state(&resources.copy);
        encoder.set_fragment_texture(0,Some(target));
        encoder.draw_primitives(metal::MTLPrimitiveType::Triangle,0,3);
        encoder.end_encoding();
    }
}
