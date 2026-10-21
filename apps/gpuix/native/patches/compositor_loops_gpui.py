# Compositor loops (motion/fps): hand stable passive loops (matrix/breathe fills; breathe/shimmer/rotate
# single-colour sprites) to Core Animation.
#
# A native paint loop otherwise asks for a frame at display rate and presents the whole window each
# time (scene replay + full-drawable GPU work + present). A matrix-loader dot or a breathing fill is a
# solid rounded rect whose alpha follows a fixed keyframe curve, which is exactly what a CALayer with a
# CAKeyframeAnimation on `opacity` does inside WindowServer, the way WebKit runs CSS keyframes. Once such
# a leaf has the same bounds on two consecutive presents, is unclipped, outside any subtree transform or
# translation, and nothing painted after it overlaps it, the scene draws it transparent and the renderer
# shows a sublayer of the Metal layer with the same color, radius and curve, phase-aligned to the
# leaf's clock. The window then presents nothing until the scene changes. Any change that moves,
# clips or covers it hands it back to scene painting in the same CA transaction as that Metal frame.
# Screenshots rebuild the scene (refresh), so they paint the leaf themselves. A paused automation clock,
# `KYBERN_PAINT_PHASE_MS`, `KYBERN_SCOPED_BUFFERS=0` and `KYBERN_COMPOSITOR_LOOPS=0` keep scene painting.
s = 'crates/gpui/src/scene.rs'
w = 'crates/gpui/src/window.rs'
m = 'crates/gpui_apple/src/metal_renderer.rs'

edit(s, '    pub passive_paint_regions: std::collections::HashMap<u64, Bounds<ScaledPixels>>,', '''    pub passive_paint_regions: std::collections::HashMap<u64, Bounds<ScaledPixels>>,
    /// Leaves Core Animation is running for this scene (drawn transparent here).
    pub compositor_loops: Vec<CompositorLoop>,
    pub(crate) compositor_ids: std::collections::HashSet<u64>,
    compositor_pending: Vec<CompositorLoop>,
    compositor_checked: u64,''')
edit(s, '        self.repaint_tags.clear();\n        self.repaint_slots.clear();', '''        self.repaint_tags.clear();
        self.repaint_slots.clear();
        self.compositor_loops.clear();
        self.compositor_ids.clear();
        self.compositor_pending.clear();
        self.compositor_checked = 0;''')
# Promoted leaves are skipped by the per-frame loop and by passive-region damage.
edit(s, "            if animation.is_none() || animation.is_some_and(|a| a.pop && a.pop_done(paint_animation_clock(a))) || !seen.insert(id) { return None; }",
     "            if animation.is_none() || animation.is_some_and(|a| a.pop && a.pop_done(paint_animation_clock(a))) || self.compositor_ids.contains(&id) || !seen.insert(id) { return None; }")
edit(s, "        self.repaint_tags.values().any(|(_,_,_,animation,_)| animation.is_some_and(|a| !(a.pop && a.pop_done(paint_animation_clock(a)))))",
     "        self.repaint_tags.values().any(|(id,_,_,animation,_)| !self.compositor_ids.contains(id) && animation.is_some_and(|a| !(a.pop && a.pop_done(paint_animation_clock(a)))))")
pending[s] += '''
/// A passive loop part (a fill, or one single-colour glyph/SVG sprite) that Core Animation animates instead of the scene.
#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(missing_docs)]
pub struct CompositorLoop {
    pub id: u64,
    /// Ordinal of this primitive within its leaf (a label has one sprite per glyph).
    pub part: u32,
    pub bounds: Bounds<ScaledPixels>,
    pub radius: f32,
    /// Fill or tint with inherited opacity, before the curve.
    pub color: Hsla,
    /// The sprite's coverage tile; `None` for a fill.
    pub tile: Option<AtlasTile>,
    pub cycle_ms: f64,
    pub delay_ms: f64,
    pub breathe: bool,
    pub shimmer: bool,
    pub rotate: bool,
    pub started: std::time::Instant,
}
/// Whether stable passive loops may run in the compositor (`KYBERN_COMPOSITOR_LOOPS=0` disables).
pub fn compositor_loops_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("KYBERN_COMPOSITOR_LOOPS").as_deref() != Ok("0")
        && std::env::var("KYBERN_SCOPED_BUFFERS").as_deref() != Ok("0")
        && std::env::var_os("KYBERN_PAINT_PHASE_MS").is_none())
}
fn compositor_debug() -> bool {
    static DEBUG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var_os("KYBERN_DEBUG_COMPOSITOR").is_some())
}
fn compositor_rect_inside(b: Bounds<ScaledPixels>, clip: [f32; 4], radii: [f32; 4]) -> bool {
    // Same conservative containment as gpu_clip_bounds.rs: a pixel of margin on every edge.
    let [x, y, w, h] = [b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0];
    let [left, top, width, height] = clip;
    if [x, y, w, h, left, top, width, height].iter().any(|v| !v.is_finite()) || w <= 0. || h <= 0. { return false; }
    let (right, bottom) = (x + w, y + h);
    if x < left + 1. || y < top + 1. || right > left + width - 1. || bottom > top + height - 1. { return false; }
    let radius = radii.into_iter().fold(0f32, f32::max) + 1.;
    (x >= left + radius && right <= left + width - radius) || (y >= top + radius && bottom <= top + height - radius)
}
impl Scene {
    /// One candidate per primitive of an eligible leaf; a leaf with any ineligible primitive stays in the scene.
    fn compositor_part(&self, index: usize, kind: u8, a: crate::PaintAnimation) -> Result<(Bounds<ScaledPixels>, ContentMask<ScaledPixels>, f32, Option<AtlasTile>), &'static str> {
        if a.pop { return Err("pop"); }
        if self.stroke_tags.contains_key(&index) || self.fade_tags.contains_key(&index) { return Err("stroke or fade"); }
        // A resting press/pop scope (identity paint, opacity 1, no blur) and a translation scope are fine:
        // any movement changes the leaf's bounds, which hands it back to the scene.
        if self.transform_bases.get(&index).is_some_and(|(_, context)| !context.kybern_paint_neutral()) { return Err("transformed"); }
        match (self.paint_operations.get(index), kind) {
            (Some(PaintOperation::Primitive(Primitive::Quad(q))), 0) => {
                if a.shimmer || a.rotate { return Err("fill kind"); }
                if q.background.tag != crate::color::BackgroundTag::Solid { return Err("gradient"); }
                let w = q.border_widths;
                if w.top.0 != 0. || w.right.0 != 0. || w.bottom.0 != 0. || w.left.0 != 0. { return Err("border"); }
                let r = q.corner_radii;
                Ok((q.bounds, q.content_mask, r.top_left.0.max(r.top_right.0).max(r.bottom_left.0).max(r.bottom_right.0), None))
            }
            (Some(PaintOperation::Primitive(Primitive::MonochromeSprite(sprite))), 1 | 2) => Ok((sprite.bounds, sprite.content_mask, 0., Some(sprite.tile))),
            _ => Err("paint kind"),
        }
    }
    fn compositor_candidates(&self) -> Vec<CompositorLoop> {
        let debug = compositor_debug();
        let mut parts: std::collections::BTreeMap<u64, Vec<(usize, CompositorLoop)>> = Default::default();
        let mut rejected = std::collections::HashSet::new();
        for (&index, &(id, kind, inherited, animation, color)) in &self.repaint_tags {
            let Some(a) = animation else { continue };
            if rejected.contains(&id) { continue; }
            let part = self.compositor_part(index, kind, a).and_then(|(b, mask, radius, tile)| {
                // A spinning glyph turns about its centre inside its own square; spinner ink stays within the
                // inscribed circle, so the square itself must be unclipped (a cached island clips to exactly it).
                let reach = b;
                if b.size.width.0 <= 0. || b.size.height.0 <= 0. || reach.intersect(&mask.bounds) != reach { return Err("clipped"); }
                let mut clip = mask.rounded_clip;
                while clip != 0 {
                    let Some(node) = self.rounded_clips.get(clip as usize) else { return Err("rounded clip") };
                    if !compositor_rect_inside(reach, node.bounds, node.radii) { return Err("rounded clip"); }
                    clip = node.parent;
                }
                Ok(CompositorLoop { id, part: 0, bounds: b, radius, color: color.opacity(inherited), tile, cycle_ms: a.cycle_ms, delay_ms: a.delay_ms,
                    breathe: a.breathe, shimmer: a.shimmer, rotate: a.rotate, started: a.started })
            });
            match part {
                Ok(l) => parts.entry(id).or_default().push((index, l)),
                Err(reason) => { if debug { eprintln!("[compositor-loops] reject {id}: {reason}"); } rejected.insert(id); parts.remove(&id); }
            }
        }
        let mut found: Vec<(usize, CompositorLoop)> = Vec::new();
        for (_, mut leaf) in parts {
            leaf.sort_by_key(|(index, _)| *index);
            for (n, (index, mut l)) in leaf.into_iter().enumerate() { l.part = n as u32; found.push((index, l)); }
        }
        if debug { eprintln!("[compositor-loops] tagged={} candidates={}", self.repaint_tags.values().filter(|t| t.3.is_some()).count(), found.len()); }
        if found.is_empty() { return Vec::new(); }
        // Anything painted after a leaf that reaches its bounds (including blur and shadow halos) would
        // sit under a sublayer of the Metal layer, so such a leaf stays in the scene. Its own glyphs may touch.
        let first = found.iter().map(|(index, _)| *index).min().unwrap_or(0);
        let union = found.iter().skip(1).fold(found[0].1.bounds, |u, (_, l)| u.union(&l.bounds));
        let mut covers: Vec<(usize, Option<u64>, Bounds<ScaledPixels>)> = Vec::new();
        for (index, operation) in self.paint_operations.iter().enumerate().skip(first + 1) {
            let PaintOperation::Primitive(p) = operation else { continue };
            let halo = match p {
                Primitive::Backdrop(b) => b.blur.0 * 3. + 1.,
                Primitive::Shadow(s) => s.blur_radius.0 * 2. + 1.,
                Primitive::MonochromeSprite(s) if s.transformation != TransformationMatrix::unit() => s.bounds.size.width.0.max(s.bounds.size.height.0) * 0.5,
                Primitive::SubpixelSprite(s) if s.transformation != TransformationMatrix::unit() => s.bounds.size.width.0.max(s.bounds.size.height.0) * 0.5,
                _ => 0.,
            };
            let mut b = *p.bounds();
            if !matches!(p, Primitive::Backdrop(_) | Primitive::Shadow(_)) { b = b.intersect(&p.content_mask().bounds); }
            let b = b.dilate(ScaledPixels(halo));
            if b.size.width.0 > 0. && b.size.height.0 > 0. && b.intersects(&union) { covers.push((index, self.repaint_tags.get(&index).map(|t| t.0), b)); }
        }
        let covered: std::collections::HashSet<u64> = found.iter().filter(|(index, l)| covers.iter().any(|(i, owner, b)| i > index && *owner != Some(l.id) && b.intersects(&l.bounds))).map(|(_, l)| l.id).collect();
        let kept: Vec<_> = found.into_iter().filter(|(_, l)| !covered.contains(&l.id)).map(|(_, l)| l).collect();
        if debug { eprintln!("[compositor-loops] unoccluded={} covers={}", kept.len(), covers.len()); }
        kept
    }
    /// Promote leaves whose parts all have the bounds of the previous present; returns whether the set changed.
    pub(crate) fn promote_compositor(&mut self, stable: &mut std::collections::HashMap<(u64, u32), Bounds<ScaledPixels>>, enabled: bool) -> bool {
        if !enabled {
            stable.clear();
            return false;
        }
        if self.compositor_checked != self.paint_generation {
            self.compositor_pending = self.compositor_candidates();
            self.compositor_checked = self.paint_generation;
        }
        let mut next = std::collections::HashMap::new();
        let mut moved = std::collections::HashSet::new();
        for l in &self.compositor_pending {
            next.insert((l.id, l.part), l.bounds);
            if stable.get(&(l.id, l.part)) != Some(&l.bounds) { moved.insert(l.id); }
        }
        *stable = next;
        let promote: Vec<CompositorLoop> = self.compositor_pending.iter().filter(|l| !moved.contains(&l.id) && !self.compositor_ids.contains(&l.id)).copied().collect();
        if promote.is_empty() { return false; }
        let mut ids: Vec<u64> = promote.iter().map(|l| l.id).collect();
        ids.dedup();
        let clear: Vec<_> = ids.iter().map(|id| (*id, crate::transparent_black())).collect();
        if !self.repaint_tagged_inner(&clear, false) { return false; }
        self.compositor_ids.extend(ids);
        self.compositor_loops.extend(promote);
        true
    }
}
'''
pending[w] += '''
impl SubtreeTransformContext {
    /// Opacity 1 and no blur: what the subtree paints keeps its own alpha (compositor loops).
    pub(crate) fn kybern_paint_neutral(&self) -> bool { (self.opacity - 1.).abs() < 1e-4 && self.blur == 0. }
}
'''
edit(w, '    paint_animation_scheduled: bool,', '    paint_animation_scheduled: bool,\n    compositor_stable: std::collections::HashMap<(u64, u32), Bounds<ScaledPixels>>,')
edit(w, '            paint_animation_scheduled: false,', '            paint_animation_scheduled: false,\n            compositor_stable: std::collections::HashMap::new(),')
edit(w, '        let animated = self.rendered_frame.scene.animate_tagged();', '''        let compositor = crate::scene::compositor_loops_enabled() && !self.kybern_test_clock_paused();
        self.rendered_frame.scene.promote_compositor(&mut self.compositor_stable, compositor);
        let animated = self.rendered_frame.scene.animate_tagged();''')

edit(m, '    backdrop_resources: Option<BackdropResources>,', '    backdrop_resources: Option<BackdropResources>,\n    compositor_layers: std::collections::HashMap<(u64, u32), (gpui::CompositorLoop, *mut objc::runtime::Object)>,')
edit(m, '            backdrop_resources: None,', '            backdrop_resources: None,\n            compositor_layers: std::collections::HashMap::new(),')
edit(m, '''    fn draw_with_frame_pool(&mut self, scene: &Scene) {
        static REGION_LAYERS''', '''    fn draw_with_frame_pool(&mut self, scene: &Scene) {
        // A changed compositor-loop set commits in the same CA transaction as this Metal frame, so a
        // leaf never shows twice or not at all while it moves between the scene and its sublayer.
        if !self.compositor_in_sync(scene) {
            unsafe { let _: () = msg_send![objc::class!(CATransaction), begin]; let _: () = msg_send![objc::class!(CATransaction), setDisableActions: YES]; }
            let transaction = self.presents_with_transaction;
            self.presents_with_transaction = true;
            if let Some(layer) = self.layer.as_ref() { let mode: bool = unsafe { msg_send![&**layer, presentsWithTransaction] }; if !mode { layer.set_presents_with_transaction(true); } }
            self.sync_compositor_layers(scene);
            self.draw_with_frame_pool_inner(scene);
            unsafe { let _: () = msg_send![objc::class!(CATransaction), commit]; }
            self.presents_with_transaction = transaction;
            if let Some(layer) = self.layer.as_ref() { let mode: bool = unsafe { msg_send![&**layer, presentsWithTransaction] }; if mode != transaction { layer.set_presents_with_transaction(transaction); } }
        } else { self.draw_with_frame_pool_inner(scene); }
    }
    fn draw_with_frame_pool_inner(&mut self, scene: &Scene) {
        static REGION_LAYERS''')
pending[m] += '\ninclude!("compositor_loops_renderer.rs");\n'

for name in [s, w, m]:
    (root / name).write_text(pending[name])
dest = root / 'crates/gpui_apple/src/compositor_loops_renderer.rs'
text = (here / 'compositor_loops_renderer.rs').read_text()
if not dest.exists() or dest.read_text() != text: dest.write_text(text)
