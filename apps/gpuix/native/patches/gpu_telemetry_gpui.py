# Opt-in bounded scene/atlas diagnostics. No timer or frame request.
a='crates/gpui_apple/src/metal_atlas.rs'
edit(a, 'pub struct MetalAtlas {', '''static GPU_UPLOADS: [std::sync::atomic::AtomicU64; 3] = [const { std::sync::atomic::AtomicU64::new(0) }; 3];
fn gpu_atlas_trace() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| std::env::var("KYBERN_GPU_TRACE").as_deref() == Ok("1"))
}
pub(crate) fn take_gpu_uploads() -> [u64;3] {
    std::array::from_fn(|i| GPU_UPLOADS[i].swap(0,std::sync::atomic::Ordering::Relaxed))
}
pub struct MetalAtlas {''')
edit(a, '    fn upload(&self, bounds: Bounds<DevicePixels>, bytes: &[u8]) {', '''    fn upload(&self, bounds: Bounds<DevicePixels>, bytes: &[u8]) {
        if gpu_atlas_trace() {
            GPU_UPLOADS[0].fetch_add(1,std::sync::atomic::Ordering::Relaxed);
            GPU_UPLOADS[1].fetch_add(bytes.len() as u64,std::sync::atomic::Ordering::Relaxed);
        }''')
edit(a, '        let id = tile.texture_id;', '''        if gpu_atlas_trace() { GPU_UPLOADS[2].fetch_add(1,std::sync::atomic::Ordering::Relaxed); }
        let id = tile.texture_id;''')
m='crates/gpui_apple/src/metal_renderer.rs'
text=pending[m]
import re
text,draw_hooks=re.subn(r'(?m)^(\s*)command_encoder\.draw_primitives',r'\1gpu_record_draw();\n\1command_encoder.draw_primitives',text)
if draw_hooks != 8: raise SystemExit(f"GPU telemetry: expected 8 draw anchors, got {draw_hooks}")
pending[m]=text
edit(m, '        let instance_buffer_pool = self.instance_buffer_pool.clone();\n        let instance_buffer = Cell::new(Some(writer.finish()));', '''        gpu_trace_scene(scene, viewport_size);
        let instance_buffer_pool = self.instance_buffer_pool.clone();
        let instance_buffer = Cell::new(Some(writer.finish()));''')
pending[m] += '''
static GPU_DRAWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn gpu_trace_enabled() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| std::env::var("KYBERN_GPU_TRACE").as_deref() == Ok("1"))
}
fn gpu_record_draw() {
    if gpu_trace_enabled() { GPU_DRAWS.fetch_add(1,std::sync::atomic::Ordering::Relaxed); }
}
fn gpu_trace_scene(scene: &Scene, viewport: Size<DevicePixels>) {
    if !gpu_trace_enabled() { return; }
    let [uploads,bytes,evictions]=crate::metal_atlas::take_gpu_uploads();
    let draws=GPU_DRAWS.swap(0,std::sync::atomic::Ordering::Relaxed);
    let clipped=scene.monochrome_sprites.iter().filter(|s|s.content_mask.rounded_clip!=0).count();
    let pruned=scene.monochrome_sprites.iter().filter(|s|s.content_mask.rounded_clip!=0 && s.transformation==gpui::TransformationMatrix::unit() && gpu_clip_prune(scene,s.content_mask,s.bounds).rounded_clip==0).count();
    let area=|b:Bounds<ScaledPixels>,m:ContentMask<ScaledPixels>| { let b=b.intersect(&m.bounds); (b.size.width.0.max(0.)*b.size.height.0.max(0.)) as u64 };
    let raster_area:u64=scene.quads.iter().map(|v|area(v.bounds,v.content_mask)).chain(scene.monochrome_sprites.iter().map(|v|area(v.bounds,v.content_mask))).chain(scene.polychrome_sprites.iter().map(|v|area(v.bounds,v.content_mask))).sum();
    let instance_bytes=scene.quads.len()*mem::size_of::<gpui::Quad>()+scene.monochrome_sprites.len()*mem::size_of::<gpui::MonochromeSprite>()+scene.polychrome_sprites.len()*mem::size_of::<gpui::PolychromeSprite>()+scene.shadows.len()*mem::size_of::<gpui::Shadow>()+scene.underlines.len()*mem::size_of::<gpui::Underline>()+scene.surfaces.len()*mem::size_of::<SurfaceBounds>()+scene.rounded_clips.len()*mem::size_of::<gpui::RoundedClip>();
    eprintln!("[gpu-scene] generation={} draws={} backdropDraws={} batches={} quads={} glyphs={} colorSprites={} shadows={} paths={} pathVertices={} backdrops={} roundedGlyphs={} prunedGlyphs={} atlasUploads={} atlasBytes={} atlasEvictions={} instanceBytes={} rasterArea={} viewport={}x{}",scene.paint_generation,draws,2*scene.backdrops.iter().filter(|b|b.opacity>0. && !b.bounds.intersect(&b.content_mask.bounds).is_empty()).count(),scene.batches().count(),scene.quads.len(),scene.monochrome_sprites.len(),scene.polychrome_sprites.len(),scene.shadows.len(),scene.paths.len(),scene.paths.iter().map(|p|p.vertices.len()).sum::<usize>(),scene.backdrops.len(),clipped,pruned,uploads,bytes,evictions,instance_bytes,raster_area,i32::from(viewport.width),i32::from(viewport.height));
}
'''
