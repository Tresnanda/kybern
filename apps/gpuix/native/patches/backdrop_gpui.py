"""Reconstruct GPUI backdrop support from the pinned submodule source."""
from pathlib import Path
import subprocess, sys
import hook_check
root = Path(sys.argv[1]); here = Path(__file__).parent
pending = {}
def edit(name, old, new, count=1):
    text = pending.get(name)
    if text is None:
        text = subprocess.check_output(['git', '-C', str(root), 'show', f'HEAD:{name}'], text=True)
    if text.count(old) != count:
        hook_check.missing(f'{name}: expected {count} anchors for {old!r}, got {text.count(old)}')
        pending[name] = text
        return
    pending[name] = text.replace(old, new)

def run_hook(file):
    hook_check.run(file, here, globals())
s = 'crates/gpui/src/scene.rs'
edit(s, '    pub shadows: Vec<Shadow>,', '    pub backdrops: Vec<Backdrop>,\n    backdrop_order_offset: u32,\n    maximum_order: u32,\n    pub shadows: Vec<Shadow>,')
edit(s, '        self.shadows.clear();', '        self.backdrops.clear(); self.backdrop_order_offset=0; self.maximum_order=0;\n        self.shadows.clear();')
edit(s, '        match &mut primitive {', '''        // Filtering is an ordering barrier, including inside paint_layer.
        // Offset subsequent natural bounds-tree orders; clamping loses ordering.
        let order = if matches!(&primitive, Primitive::Backdrop(_)) { self.maximum_order + 1 } else { order + self.backdrop_order_offset };
        self.maximum_order = self.maximum_order.max(order);
        if matches!(&primitive, Primitive::Backdrop(_)) { self.backdrop_order_offset = order + 1; }
        match &mut primitive {
            Primitive::Backdrop(b) => { b.order=order; self.backdrops.push(*b); },''')
edit(s, '        self.shadows.sort_by_key(|shadow| shadow.order);', '        self.backdrops.sort_by_key(|b| b.order);\n        self.shadows.sort_by_key(|shadow| shadow.order);')
edit(s, '            shadows_start: 0,', '            backdrops_start: 0, backdrops_iter: self.backdrops.iter().peekable(),\n            shadows_start: 0,')
edit(s, 'pub(crate) enum PrimitiveKind {', 'pub(crate) enum PrimitiveKind {\n    Backdrop,')
edit(s, 'pub enum Primitive {', 'pub enum Primitive {\n    Backdrop(Backdrop),')
edit(s, '            Primitive::Shadow(shadow) => &shadow.bounds,', '            Primitive::Backdrop(b) => &b.bounds,\n            Primitive::Shadow(shadow) => &shadow.bounds,')
edit(s, '            Primitive::Shadow(shadow) => &shadow.content_mask,', '            Primitive::Backdrop(b) => &b.content_mask,\n            Primitive::Shadow(shadow) => &shadow.content_mask,')
edit(s, "struct BatchIterator<'a> {", "struct BatchIterator<'a> {\n    backdrops_start: usize, backdrops_iter: Peekable<slice::Iter<'a, Backdrop>>,")
edit(s, '        let mut orders_and_kinds = [', '        let mut orders_and_kinds = [\n            (self.backdrops_iter.peek().map(|b|b.order),PrimitiveKind::Backdrop),')
edit(s, '        match batch_kind {', '        match batch_kind {\n            PrimitiveKind::Backdrop => { let i=self.backdrops_start; self.backdrops_start+=1; self.backdrops_iter.next(); Some(PrimitiveBatch::Backdrop(i)) },')
edit(s, 'pub enum PrimitiveBatch {', 'pub enum PrimitiveBatch {\n    Backdrop(usize),')
edit(s, '            Self::Shadows(range) => format!("shadows ({})", range.len()),', '            Self::Backdrop(_) => "backdrop".into(),\n            Self::Shadows(range) => format!("shadows ({})", range.len()),')
pending[s] += '''
/// A scene-local backdrop filter. Only the Metal backend implements it.
#[derive(Clone,Copy,Debug)]
#[allow(missing_docs)]
pub struct Backdrop {
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub blur: ScaledPixels,
    pub radius: ScaledPixels,
    pub saturation: f32,
    pub opacity: f32,
    pub fade_top: f32,
}
impl From<Backdrop> for Primitive { fn from(b:Backdrop)->Self {Self::Backdrop(b)} }
'''
w = 'crates/gpui/src/window.rs'
edit(w, '    pub fn paint_quad(&mut self, quad: PaintQuad) {', '''    /// Filter earlier scene content within these bounds before painting children.
    pub fn paint_backdrop(&mut self, bounds: Bounds<Pixels>, blur: Pixels, saturation:f32, radius:Pixels, opacity:f32, fade_top:f32) {
        self.invalidator.debug_assert_paint();
        if self.element_opacity() * opacity <= 0.0 { return; }
        let primitive=crate::Backdrop {
            order:0, bounds:bounds.scale(self.scale_factor()), content_mask:self.snapped_content_mask(),
            blur:blur.scale(self.scale_factor()), radius:radius.scale(self.scale_factor()), saturation,
            opacity:self.element_opacity() * opacity.clamp(0.0,1.0), fade_top,
        };
        self.next_frame.scene.insert_primitive(primitive);
    }
    /// Paint a filled or bordered quad.
    pub fn paint_quad(&mut self, quad: PaintQuad) {''')
m = 'crates/gpui_apple/src/metal_renderer.rs'
edit(m, '    path_intermediate_texture: Option<metal::Texture>,', '    backdrop_resources: Option<BackdropResources>,\n    path_intermediate_texture: Option<metal::Texture>,')
edit(m, '            path_intermediate_texture: None,', '            backdrop_resources: None,\n            path_intermediate_texture: None,')
edit(m, '        for batch in scene.batches() {', '        if let Some(r)=&mut self.backdrop_resources { r.begin_frame(!scene.backdrops.is_empty()); }\n        for batch in scene.batches() {')
edit(m, '            match batch {', '''            match batch {
                PrimitiveBatch::Backdrop(index) => {
                    command_encoder.end_encoding();
                    self.draw_backdrop(&scene.backdrops[index],texture,viewport_size,command_buffer)?;
                    command_encoder=new_command_encoder_for_texture(command_buffer,texture,viewport_size,None);
                },''')
pending[m] += '\ninclude!("backdrop_renderer.rs");\n'
run_hook("paint_gpui.py")
run_hook("frame_gpui.py")
run_hook("paint_buffers_gpui.py")
run_hook("frame_drawable_gpui.py")
run_hook("paint_region_gpui.py")
run_hook("paint_text_gpui.py")
run_hook("markdown_gpui.py")
run_hook("rotate_gpui.py")
run_hook("pop_gpui.py")
run_hook("frame_cost_gpui.py")
run_hook("pointer_gpui.py")
run_hook("rounded_clip_gpui.py")
run_hook("subtree_translation_gpui.py")
run_hook("paint_region_crop_gpui.py")

run_hook("scroll_gpui.py")
run_hook("text_scale_gpui.py")
run_hook("font_weight_gpui.py")
run_hook("subtree_transform_gpui.py")
run_hook("stream_fade_gpui.py")
run_hook("stroke_draw_gpui.py")

run_hook("sparse_list_gpui.py")

run_hook("motion_frame_gpui.py")
run_hook("cache_frame_gpui.py")

run_hook("image_memory_gpui.py")
run_hook("memory_counters_gpui.py")
run_hook("frame_memory_gpui.py")

run_hook("gpu_clip_gpui.py")
run_hook("gpu_telemetry_gpui.py")
run_hook("flick_frame_gpui.py")

run_hook("image_frames_gpui.py")

exec((here / "alpha_blend_gpui.py").read_text())

for name, text in pending.items():
    if (root/name).read_text()!=text: (root/name).write_text(text)
for name in ['backdrop_renderer.rs', 'backdrop.metal']:
    dest=root/'crates/gpui_apple/src'/name; text=(here/name).read_text()
    if not dest.exists() or dest.read_text()!=text:dest.write_text(text)
dest=root/'crates/gpui/src/rounded_clip.rs'
text=(here/'rounded_clip.rs').read_text()
if not dest.exists() or dest.read_text()!=text:dest.write_text(text)
print('GPUI backdrop hooks applied')

run_hook("backdrop_kernel_gpui.py")

run_hook("code_memory_gpui.py")

run_hook("code_frame_gpui.py")
run_hook("code_collect_gpui.py")
run_hook("hover_reconcile_gpui.py")
run_hook("hover_owner_gpui.py")
run_hook("snapshot_strokes_gpui.py")
run_hook("compositor_loops_gpui.py")
run_hook("compositor_covers_gpui.py")
run_hook("translate_text_gpui.py")
run_hook("shimmer_band_gpui.py")
run_hook("hover_fade_gpui.py")
run_hook("motion_trace_gpui.py")
run_hook("image_load_gpui.py")

run_hook("idle_memory_gpui.py")
run_hook("platforms_gpui.py")

hook_check.finish("GPUI hooks applied")
