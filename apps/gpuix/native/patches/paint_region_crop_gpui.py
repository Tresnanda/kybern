# Applied after analytic rounded clips. Cropped passes retain full-window
# primitive, mask, gradient and SDF coordinates; only the raster viewport moves.
m='crates/gpui_apple/src/metal_renderer.rs'
anchor='command_encoder.set_fragment_buffer(7, Some(&rounded_clips.buffer), rounded_clips.offset as u64);'
edit(m,anchor,anchor+'''
        let paint_origin=self.paint_region_origin.map_or([0f32;2],|(x,y)|[x as f32,y as f32]);
        command_encoder.set_fragment_bytes(8,mem::size_of_val(&paint_origin) as u64,paint_origin.as_ptr() as *const _);''',count=2)
shader='crates/gpui_apple/src/shaders.metal'
edit(shader,'device const RoundedClipNode *clips [[buffer(7)]]) {',
     'device const RoundedClipNode *clips [[buffer(7)]], constant float2 &paint_origin [[buffer(8)]]) {',count=7)
edit(shader,'  float clip_alpha=rounded_clip_alpha(input.position.xy,',
     '  input.position.xy+=paint_origin;\n  float clip_alpha=rounded_clip_alpha(input.position.xy,',count=7)

# Cull before making Metal bindings/draw calls, with no per-batch allocation.
edit(m,'        for batch in scene.batches() {','        for batch in scene.batches() {\n        for batch in Self::paint_region_batches(scene,batch,self.paint_region_scissor) {')
edit(m,'        }\n\n        }\n        self.paint_region_origin=saved_origin;', '        }\n        }\n\n        }\n        self.paint_region_origin=saved_origin;')
