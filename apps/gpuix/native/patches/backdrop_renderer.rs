// Included in gpui_apple::metal_renderer. Scratch texture is reused across
// surfaces/frames; one ordered command queue prevents concurrent use hazards.
#[repr(C)]
struct BackdropParams { crop:[f32;4], bounds:[f32;4], clip:[f32;4], values:[f32;4], viewport:[f32;4], rounded_clip:u32 }
struct BackdropResources {
    horizontal: metal::RenderPipelineState,
    vertical: metal::RenderPipelineState,
    scratch: Option<metal::Texture>,
}
impl BackdropResources {
    fn new(device:&metal::Device, format:metal::MTLPixelFormat)->Result<Self> {
        let lib=device.new_library_with_source(include_str!("backdrop.metal"),&metal::CompileOptions::new()).map_err(|e|anyhow::anyhow!(e))?;
        let pipeline=|blend:bool|->Result<metal::RenderPipelineState>{
            let d=metal::RenderPipelineDescriptor::new();
            let vertex=lib.get_function("backdrop_vertex",None).map_err(|e|anyhow::anyhow!(e))?; d.set_vertex_function(Some(&vertex));
            let fragment=lib.get_function("backdrop_fragment",None).map_err(|e|anyhow::anyhow!(e))?; d.set_fragment_function(Some(&fragment));
            let a=d.color_attachments().object_at(0).unwrap();a.set_pixel_format(format);
            if blend {a.set_blending_enabled(true);a.set_source_rgb_blend_factor(metal::MTLBlendFactor::SourceAlpha);a.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);a.set_source_alpha_blend_factor(metal::MTLBlendFactor::Zero);a.set_destination_alpha_blend_factor(metal::MTLBlendFactor::One);}
            device.new_render_pipeline_state(&d).map_err(|e|anyhow::anyhow!(e))
        };
        Ok(Self{horizontal:pipeline(false)?,vertical:pipeline(true)?,scratch:None})
    }
}
impl MetalRenderer {
    fn draw_backdrop(&mut self, b:&gpui::Backdrop, target:&metal::TextureRef, viewport:Size<DevicePixels>, command:&metal::CommandBufferRef, rounded_clips:&InstanceBinding)->Result<()> {
        let bounds=b.bounds;let clip=bounds.intersect(&b.content_mask.bounds);
        if clip.is_empty()||b.opacity<=0.0{return Ok(())}
        let sigma=b.blur.as_f32().max(0.01);let halo=(sigma*3.0).ceil();
        let x=(clip.origin.x.as_f32()-halo).floor().max(0.0);let y=(clip.origin.y.as_f32()-halo).floor().max(0.0);
        let right=(clip.right().as_f32()+halo).ceil().min(target.width() as f32);let bottom=(clip.bottom().as_f32()+halo).ceil().min(target.height() as f32);
        let w=(right-x).max(1.0) as u64;let h=(bottom-y).max(1.0) as u64;
        if self.backdrop_resources.is_none(){self.backdrop_resources=Some(BackdropResources::new(&self.device,target.pixel_format())?);}
        let r=self.backdrop_resources.as_mut().unwrap();
        if r.scratch.as_ref().is_none_or(|t|t.width()<w||t.height()<h){
            let w=r.scratch.as_ref().map_or(w,|t|w.max(t.width()));let h=r.scratch.as_ref().map_or(h,|t|h.max(t.height()));
            let d=metal::TextureDescriptor::new();d.set_texture_type(metal::MTLTextureType::D2);d.set_pixel_format(target.pixel_format());d.set_width(w);d.set_height(h);d.set_usage(metal::MTLTextureUsage::RenderTarget|metal::MTLTextureUsage::ShaderRead);d.set_storage_mode(metal::MTLStorageMode::Private);
            r.scratch=Some(self.device.new_texture(&d));
        }
        let scratch=r.scratch.as_ref().unwrap();
        let mut p=BackdropParams{crop:[x,y,w as f32,h as f32],bounds:[bounds.origin.x.as_f32(),bounds.origin.y.as_f32(),bounds.size.width.as_f32(),bounds.size.height.as_f32()],clip:[clip.origin.x.as_f32(),clip.origin.y.as_f32(),clip.size.width.as_f32(),clip.size.height.as_f32()],values:[sigma,b.saturation,b.radius.as_f32(),0.0],viewport:[scratch.width() as f32,scratch.height() as f32,b.opacity,b.fade_top],rounded_clip:b.content_mask.rounded_clip};
        let encode=|e:&metal::RenderCommandEncoderRef,p:&BackdropParams,pipeline:&metal::RenderPipelineState,source:&metal::TextureRef|{
            e.set_fragment_buffer(7,Some(&rounded_clips.buffer),rounded_clips.offset as u64);
            e.set_render_pipeline_state(pipeline);e.set_vertex_bytes(0,mem::size_of::<BackdropParams>() as u64,p as *const _ as *const c_void);e.set_fragment_bytes(0,mem::size_of::<BackdropParams>() as u64,p as *const _ as *const c_void);e.set_fragment_texture(0,Some(source));e.draw_primitives(metal::MTLPrimitiveType::TriangleStrip,0,4);e.end_encoding();
        };
        let e=new_command_encoder_for_texture(command,scratch,size(gpui::DevicePixels(scratch.width() as i32),gpui::DevicePixels(scratch.height() as i32)),Some(metal::MTLClearColor::new(0.,0.,0.,0.)));
        encode(e,&p,&r.horizontal,target);
        p.values[3]=1.0;p.viewport[0]=target.width() as f32;p.viewport[1]=target.height() as f32;
        let e=new_command_encoder_for_texture(command,target,viewport,None);encode(e,&p,&r.vertical,scratch);
        Ok(())
    }
}
