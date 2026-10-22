# Executed by backdrop_gpui.py in its atomic, pinned-source edit table.
w = 'crates/gpui/src/window.rs'
edit(w, '    pub(crate) content_mask_stack: Vec<ContentMask<Pixels>>,', '    pub(crate) content_mask_stack: Vec<ContentMask<Pixels>>,\n    rounded_clip_pool: RoundedClipPool,')
edit(w, '            content_mask_stack: Vec::new(),', '            content_mask_stack: Vec::new(),\n            rounded_clip_pool: Default::default(),')
edit(w, '    /// The bounds\n    pub bounds: Bounds<P>,\n}', '    /// The bounds\n    pub bounds: Bounds<P>,\n    /// Immutable rounded clip chain, zero for a rectangle.\n    pub rounded_clip: u32,\n    /// Cache-key generation for a recycled clip slot.\n    pub clip_generation: u32,\n}')
edit(w, '            bounds: self.bounds.scale(factor),\n        }\n    }\n\n    /// Intersect the content mask', '            bounds: self.bounds.scale(factor),\n            rounded_clip: self.rounded_clip, clip_generation: self.clip_generation,\n        }\n    }\n\n    /// Intersect the content mask')
edit(w, '        ContentMask { bounds }', '        // A style-created rounded chain already includes its inherited mask.\n        let rounded = if self.rounded_clip != 0 { self } else { other };\n        ContentMask { bounds, rounded_clip: rounded.rounded_clip, clip_generation: rounded.clip_generation }')
edit(w, '            bounds: self.cover_bounds(self.content_mask().bounds),', '            bounds: self.cover_bounds(self.content_mask().bounds),\n            rounded_clip: self.content_mask().rounded_clip, clip_generation: self.content_mask().clip_generation,')
edit(w, '            .unwrap_or_else(|| ContentMask {\n                bounds:', '            .unwrap_or_else(|| ContentMask {\n                rounded_clip: 0, clip_generation: 0,\n                bounds:')
edit(w, '                        bounds: content_mask_bounds,', '                        bounds: content_mask_bounds,\n                        ..quad.content_mask')
edit(w, '            if bounds.contains(&position) {', '            if bounds.contains(&position) && self.scene.rounded_contains(hitbox.content_mask.rounded_clip, position) {')
edit(w, '        self.next_frame.finish(&mut self.rendered_frame);', '        self.next_frame.finish(&mut self.rendered_frame);\n        self.rounded_clip_pool.snapshot(&mut self.next_frame, self.scale_factor());')
edit(w, '            self.draw_roots(cx);', '            let clip_scale=self.scale_factor();\n            self.rounded_clip_pool.seed(&mut self.next_frame.scene,clip_scale);\n            self.draw_roots(cx);')
pending[w] += '\ninclude!("rounded_clip.rs");\n'
d = 'crates/gpui/src/elements/div.rs'
edit(d, '                    window.with_content_mask(\n                        style.overflow_mask(bounds, window.rem_size()),', '                    let overflow_mask = window.rounded_overflow_mask(&style, bounds);\n                    window.with_content_mask(\n                        overflow_mask,')
edit(d, '                            window.with_content_mask(\n                                style.overflow_mask(bounds, window.rem_size()),', '                            let overflow_mask = window.rounded_overflow_mask(&style, bounds);\n                            window.with_content_mask(\n                                overflow_mask,')
for name in ['style.rs', 'elements/uniform_list.rs', 'elements/list.rs']:
    path='crates/gpui/src/'+name
    text=pending.get(path) or subprocess.check_output(['git','-C',str(root),'show',f'HEAD:{path}'],text=True)
    count=text.count('ContentMask { bounds }')
    edit(path,'ContentMask { bounds }','ContentMask { bounds, ..Default::default() }',count)
edit('crates/gpui/src/debug_overlay.rs', '        let content_mask = ContentMask {\n            bounds:', '        let content_mask = ContentMask {\n            rounded_clip: 0, clip_generation: 0,\n            bounds:')
edit('crates/gpui/src/elements/surface.rs', '                content_mask: ContentMask {\n                    bounds:', '                content_mask: ContentMask {\n                    rounded_clip: 0, clip_generation: 0,\n                    bounds:')
s='crates/gpui/src/scene.rs'
edit(s,'    pub shadows: Vec<Shadow>,','    /// Rounded masks shared by all primitive types, in device pixels.\n    pub rounded_clips: Vec<RoundedClip>,\n    pub(crate) rounded_clip_scale: f32,\n    pub shadows: Vec<Shadow>,')
edit(s,'        self.shadows.clear();','        self.rounded_clips.clear();\n        self.shadows.clear();')
edit(s,'        self.replay(0..previous.len(), &previous);','        self.replay(0..previous.len(), &previous);\n        self.rounded_clips = previous.rounded_clips.clone();\n        self.rounded_clip_scale = previous.rounded_clip_scale;')
pending[s] += '''
/// One immutable link of an arbitrarily nested rounded content mask. `kind` 1
/// is an edge fade (N3): `radii` then hold the top, right, bottom and left ramps.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
#[allow(missing_docs)]
pub struct RoundedClip { pub bounds: [f32;4], pub radii: [f32;4], pub parent: u32, pub kind: u32 }
impl Scene {
    pub(crate) fn rounded_contains(&self, mut id:u32, point:Point<Pixels>) -> bool {
        let x=point.x.as_f32()*self.rounded_clip_scale; let y=point.y.as_f32()*self.rounded_clip_scale;
        while id!=0 {
            let Some(n)=self.rounded_clips.get(id as usize) else {return false;};
            // Hit testing ignores edge fades.
            if n.kind!=0 { id=n.parent; continue; }
            let [left,top,width,height]=n.bounds;
            if x<left || y<top || x>=left+width || y>=top+height { return false; }
            let right=x>=left+width/2.; let bottom=y>=top+height/2.;
            let radius=n.radii[match(right,bottom){(false,false)=>0,(true,false)=>1,(true,true)=>2,(false,true)=>3}];
            let cx=if right {left+width-radius} else {left+radius};
            let cy=if bottom {top+height-radius} else {top+radius};
            let dx=if right {(x-cx).max(0.)} else {(cx-x).max(0.)};
            let dy=if bottom {(y-cy).max(0.)} else {(cy-y).max(0.)};
            if dx*dx+dy*dy>radius*radius { return false; }
            id=n.parent;
        }
        true
    }
}
'''
# Put the new source in cbindgen's existing input list, without a build.rs hook.
pending[w] = pending[w].replace('self.rounded_clip_pool.snapshot(&mut self.next_frame, self.scale_factor());','let clip_scale = self.scale_factor();\n        self.rounded_clip_pool.snapshot(&mut self.next_frame, clip_scale);')

m='crates/gpui_apple/src/metal_renderer.rs'
edit(m,'    pub bounds: Bounds<ScaledPixels>,\n}\n\nimpl MetalRenderer', '    pub bounds: Bounds<ScaledPixels>,\n    pub rounded_clip: u32,\n}\n\nimpl MetalRenderer')
edit(m,'                bounds: path.bounds.intersect(&path.content_mask.bounds),','                bounds: path.bounds.intersect(&path.content_mask.bounds),\n                rounded_clip: path.content_mask.rounded_clip,')
edit(m,'        for batch in scene.batches() {','        let rounded_clips = writer.write(&scene.rounded_clips)?;\n        for batch in scene.batches() {\n            command_encoder.set_fragment_buffer(7, Some(&rounded_clips.buffer), rounded_clips.offset as u64);')
# Paths have their own intermediate encoder; pass the same buffer into it.
edit(m,'                        paths,\n                        writer,','                        paths,\n                        &rounded_clips,\n                        writer,')
edit(m,'        paths: &[Path<ScaledPixels>],\n        writer: &mut InstanceBufferWriter,\n        viewport_size: Size<DevicePixels>,\n        command_buffer:', '        paths: &[Path<ScaledPixels>],\n        rounded_clips: &InstanceBinding,\n        writer: &mut InstanceBufferWriter,\n        viewport_size: Size<DevicePixels>,\n        command_buffer:')
edit(m,'        command_encoder.set_render_pipeline_state(&self.paths_rasterization_pipeline_state);', '        command_encoder.set_fragment_buffer(7, Some(&rounded_clips.buffer), rounded_clips.offset as u64);\n        command_encoder.set_render_pipeline_state(&self.paths_rasterization_pipeline_state);')

shader='crates/gpui_apple/src/shaders.metal'
edit(shader,'using namespace metal;', '''using namespace metal;
struct RoundedClipNode { float bounds[4]; float radii[4]; uint parent; uint kind; };
// Edge fade link (N3): ramps are top, right, bottom, left; 0 leaves that edge alone.
float edge_fade_alpha(float2 p, float2 lo, float2 size, float4 band) {
  float4 d=float4(p.y-lo.y, lo.x+size.x-p.x, lo.y+size.y-p.y, p.x-lo.x);
  float4 r=select(float4(1.), saturate(d/max(band,float4(1e-4))), band>0.);
  float m=min(min(r.x,r.y),min(r.z,r.w));
  return m*m;
}
// All scene primitives share this analytic intersection. Interior fragments take
// cheap comparisons; only corner pixels evaluate a circle distance. Edge fades
// multiply, so nested scopes compound.
float rounded_clip_alpha(float2 p, uint id, device const RoundedClipNode *clips) {
  float coverage=1., fade=1.;
  while(id!=0) {
    RoundedClipNode n=clips[id];
    float2 lo=float2(n.bounds[0],n.bounds[1]), size=float2(n.bounds[2],n.bounds[3]);
    if(n.kind!=0) {
      fade*=edge_fade_alpha(p,lo,size,float4(n.radii[0],n.radii[1],n.radii[2],n.radii[3]));
      id=n.parent;
      continue;
    }
    bool right=p.x>=lo.x+size.x/2., bottom=p.y>=lo.y+size.y/2.;
    float r=n.radii[bottom?(right?2:3):(right?1:0)];
    float2 c=lo+float2(right?size.x-r:r,bottom?size.y-r:r);
    float2 q=float2(right?p.x-c.x:c.x-p.x,bottom?p.y-c.y:c.y-p.y);
    float distance=length(max(q,0.))+min(max(q.x,q.y),0.)-r;
    if(any(p<lo)||any(p>=lo+size)||distance>=0.5) discard_fragment();
    coverage=min(coverage,saturate(0.5-distance));
    id=n.parent;
  }
  if(fade<=0.) discard_fragment();
  return coverage*fade;
}
''')
# Apply coverage to every return, including original fast paths, preserving each
# primitive's straight/premultiplied blending convention.
text=pending[shader]
specs={'quad_fragment':'quads[input.quad_id].content_mask.rounded_clip','shadow_fragment':'shadows[input.shadow_id].content_mask.rounded_clip',
 'underline_fragment':'underlines[input.underline_id].content_mask.rounded_clip','monochrome_sprite_fragment':'input.rounded_clip',
 'polychrome_sprite_fragment':'sprites[input.sprite_id].content_mask.rounded_clip','path_rasterization_fragment':'vertices[input.vertex_id].rounded_clip',
 'surface_fragment':'input.rounded_clip'}
import re
for function, handle in specs.items():
    start=text.index('fragment float4 '+function+'('); body=text.index(') {',start)+3
    depth=1; end=body
    while depth:
        end+=1
        if text[end]=='{': depth+=1
        elif text[end]=='}': depth-=1
    content=text[body:end]
    prefix='\n  float clip_alpha=rounded_clip_alpha(input.position.xy, '+handle+', clips);\n'
    premult=function=='path_rasterization_fragment'
    coverage='clip_alpha' if premult else 'float4(1.,1.,1.,clip_alpha)'
    wrapped=prefix+re.sub(r'\breturn\s+(.+?);',lambda match:'return ('+match.group(1)+') * '+coverage+';',content,flags=re.S)
    signature=text[start:body].replace(') {',', device const RoundedClipNode *clips [[buffer(7)]]) {')
    text=text[:start]+signature+wrapped+text[end:]
# Carry clip handles through vertices that have no fragment primitive ID.
for name in ['MonochromeSpriteVertexOutput','MonochromeSpriteFragmentInput','SurfaceVertexOutput','SurfaceFragmentInput']:
    anchor='struct '+name+' {\n'
    text=text.replace(anchor,anchor+'  uint rounded_clip [[flat]];\n')
text=text.replace('return MonochromeSpriteVertexOutput{\n      device_position,','return MonochromeSpriteVertexOutput{\n      sprite.content_mask.rounded_clip,\n      device_position,')
text=text.replace('return SurfaceVertexOutput{\n      device_position,','return SurfaceVertexOutput{\n      surface.content_mask.rounded_clip,\n      device_position,')
pending[shader]=text
# The scene-local backdrop has its own shader/encoder and obeys the same chain.
edit(m,'self.draw_backdrop(&scene.backdrops[index],texture,viewport_size,command_buffer)?;', 'self.draw_backdrop(&scene.backdrops[index],texture,viewport_size,command_buffer,&rounded_clips)?;')
