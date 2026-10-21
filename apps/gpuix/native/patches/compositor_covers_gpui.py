# Compositor loops: exact covers for border rings and clipped shadows (lane trayidle). Executed right after
# compositor_loops_gpui.py from backdrop_gpui.py.
#
# A loop leaf stays in the scene while anything painted after it reaches its bounds. Two of those covers were
# conservative where the pixels are known exactly, and kept every loader inside a bordered card at display rate:
# - A border painted after its children (a stacked panel's outline is a transparent quad with only borders) was
#   taken as its whole strip mask; the strip beside a rounded corner is ~37 px wide, so every loader in the
#   panel's glyph column was "covered" by a 1 px line. Such a quad only paints its ring: a leaf inside the inner
#   rounded rect (inset by the border widths, radii shrunk by them, a pixel of margin) is not covered.
# - A shadow's halo ignored its content mask. Shadows are clipped to it in the shader (`shadow_vertex`
#   `clip_distance`), so the halo is now intersected with the mask too, like every other primitive.
s = 'crates/gpui/src/scene.rs'
edit(s, '''            let mut b = *p.bounds();
            if !matches!(p, Primitive::Backdrop(_) | Primitive::Shadow(_)) { b = b.intersect(&p.content_mask().bounds); }
            let b = b.dilate(ScaledPixels(halo));
            if b.size.width.0 > 0. && b.size.height.0 > 0. && b.intersects(&union) { covers.push((index, self.repaint_tags.get(&index).map(|t| t.0), b)); }''', '''            let mut b = *p.bounds();
            if !matches!(p, Primitive::Backdrop(_) | Primitive::Shadow(_)) { b = b.intersect(&p.content_mask().bounds); }
            let mut b = b.dilate(ScaledPixels(halo));
            if matches!(p, Primitive::Shadow(_)) { b = b.intersect(&p.content_mask().bounds); }
            let ring = match p { Primitive::Quad(q) if q.background.is_transparent() => Some(compositor_inner_ring(q)), _ => None };
            if b.size.width.0 > 0. && b.size.height.0 > 0. && b.intersects(&union) { covers.push((index, self.repaint_tags.get(&index).map(|t| t.0), b, ring)); }''')
edit(s, '        let mut covers: Vec<(usize, Option<u64>, Bounds<ScaledPixels>)> = Vec::new();',
     '        let mut covers: Vec<(usize, Option<u64>, Bounds<ScaledPixels>, Option<([f32; 4], [f32; 4])>)> = Vec::new();')
edit(s, '        let covered: std::collections::HashSet<u64> = found.iter().filter(|(index, l)| covers.iter().any(|(i, owner, b)| i > index && *owner != Some(l.id) && b.intersects(&l.bounds))).map(|(_, l)| l.id).collect();',
     '''        let covered: std::collections::HashSet<u64> = found.iter().filter(|(index, l)| covers.iter().any(|(i, owner, b, ring)| i > index && *owner != Some(l.id) && b.intersects(&l.bounds)
            && !ring.is_some_and(|(inner, radii)| compositor_rect_in_rounded(l.bounds, inner, radii)))).map(|(_, l)| l.id).collect();
        // Which primitive keeps a leaf in the scene (`KYBERN_DEBUG_COMPOSITOR=1`): once per covered leaf.
        if debug { for (index, l) in &found { if let Some((i, _, b, _)) = covers.iter().find(|(i, owner, b, ring)| i > index && *owner != Some(l.id) && b.intersects(&l.bounds) && !ring.is_some_and(|(inner, radii)| compositor_rect_in_rounded(l.bounds, inner, radii))) {
            let kind = match &self.paint_operations[*i] { PaintOperation::Primitive(Primitive::Shadow(_)) => "shadow", PaintOperation::Primitive(Primitive::Quad(_)) => "quad", PaintOperation::Primitive(Primitive::Backdrop(_)) => "backdrop", PaintOperation::Primitive(Primitive::MonochromeSprite(_) | Primitive::SubpixelSprite(_)) => "sprite", _ => "other" };
            eprintln!("[compositor-loops] covered {} at {:?} by {kind} {:?}", l.id, l.bounds, b);
        } } }''')
edit(s, 'fn compositor_rect_inside(b: Bounds<ScaledPixels>, clip: [f32; 4], radii: [f32; 4]) -> bool {', '''/// The hole of a transparent quad's border ring: its bounds inset by the border widths (and a pixel of antialiasing),
/// with corner radii shrunk by the larger adjacent border ([top-left, top-right, bottom-right, bottom-left]).
fn compositor_inner_ring(q: &Quad) -> ([f32; 4], [f32; 4]) {
    let (w, b, r) = (q.border_widths, q.bounds, q.corner_radii);
    let (top, right, bottom, left) = (w.top.0 + 1., w.right.0 + 1., w.bottom.0 + 1., w.left.0 + 1.);
    let inner = [b.origin.x.0 + left, b.origin.y.0 + top, b.size.width.0 - left - right, b.size.height.0 - top - bottom];
    let radii = [r.top_left.0 - top.max(left), r.top_right.0 - top.max(right), r.bottom_right.0 - bottom.max(right), r.bottom_left.0 - bottom.max(left)].map(|v| v.max(0.));
    (inner, radii)
}
/// Whether all of `b` lies inside the rounded rect (`rect` = [x, y, w, h], `radii` clockwise from top-left).
fn compositor_rect_in_rounded(b: Bounds<ScaledPixels>, rect: [f32; 4], radii: [f32; 4]) -> bool {
    let [x, y, w, h] = rect;
    let (left, top, right, bottom) = (b.origin.x.0, b.origin.y.0, b.origin.x.0 + b.size.width.0, b.origin.y.0 + b.size.height.0);
    if w <= 0. || h <= 0. || left < x || top < y || right > x + w || bottom > y + h { return false; }
    // Each corner of the leaf must be inside the arc of the rect's corner it falls in (a convex shape holds the rest).
    let corner = |px: f32, py: f32| {
        for (i, &r) in radii.iter().enumerate() {
            if r <= 0. { continue; }
            let (cx, cy) = match i { 0 => (x + r, y + r), 1 => (x + w - r, y + r), 2 => (x + w - r, y + h - r), _ => (x + r, y + h - r) };
            let beyond_x = if i == 0 || i == 3 { px < cx } else { px > cx };
            let beyond_y = if i < 2 { py < cy } else { py > cy };
            if beyond_x && beyond_y && (px - cx).hypot(py - cy) > r { return false; }
        }
        true
    };
    corner(left, top) && corner(right, top) && corner(right, bottom) && corner(left, bottom)
}
fn compositor_rect_inside(b: Bounds<ScaledPixels>, clip: [f32; 4], radii: [f32; 4]) -> bool {''')
(root / s).write_text(pending[s])
