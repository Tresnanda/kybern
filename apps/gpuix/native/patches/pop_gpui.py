# Attention pop (`t-pop`, styles/motion.css: 250 ms `--ease-bounce` cubic-bezier(0.34,1.36,0.64,1), `both`: scale 0.85 -> 1 and
# opacity 0.4 -> 1) as a declarative paint animation (`paintAnimation: {kind: 'pop', cycleMs, delayMs?}`) on a passive text or SVG
# leaf. Executed after rotate_gpui.py in backdrop_gpui.py, so it edits the output of paint_gpui.py, paint_text_gpui.py and
# rotate_gpui.py. It rides the same per-frame path as the rotating glyph: `animate_tagged` -> `repaint_tagged_inner` re-evaluates
# tagged leaves at every presented frame without element render, layout or prepaint. Per frame it sets each sprite's colour
# alpha (opacity) and its `transformation` (a scale about the centre of the whole leaf, i.e. the union of its glyph sprites), and
# once the curve has ended (plus 100 ms of margin, so the last frames land exactly on scale 1 / opacity 1) the leaf stops asking
# for frames. Geometry, layout, hit testing and clipping are untouched (the scale is paint-only, like the desktop's transform).
s = 'crates/gpui/src/scene.rs'
edit(s, '    pub rotate: bool,', '    pub rotate: bool,\n    pub pop: bool,')
edit(s, 'self.shimmer == other.shimmer && self.rotate == other.rotate', 'self.shimmer == other.shimmer && self.rotate == other.rotate && self.pop == other.pop')
edit(s, '        if self.rotate { return 1.0; }\n', '        if self.rotate { return 1.0; }\n        if self.pop { return self.pop_state(now).0; }\n')
edit(s, 'fn paint_animation_clock(animation: PaintAnimation) -> std::time::Instant {', '''impl PaintAnimation {
    /// `t-pop` at `at`: (opacity, scale). `both` fill: the first keyframe during the delay, the last after the end.
    pub(crate) fn pop_state(self, at: std::time::Instant) -> (f32, f32) {
        let elapsed = at.saturating_duration_since(self.started).as_secs_f64() * 1000.0 - self.delay_ms;
        let x = (elapsed / self.cycle_ms).clamp(0.0, 1.0);
        // `--ease-bounce`: y(t) of cubic-bezier(0.34, 1.36, 0.64, 1) at the t whose x(t) is `x`.
        let (x1, y1, x2, y2) = (0.34f64, 1.36f64, 0.64f64, 1.0f64);
        let bez = |t: f64, a: f64, b: f64| 3.0 * a * t * (1.0 - t).powi(2) + 3.0 * b * t * t * (1.0 - t) + t * t * t;
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..24 { let mid = (lo + hi) * 0.5; if bez(mid, x1, x2) < x { lo = mid; } else { hi = mid; } }
        let e = bez((lo + hi) * 0.5, y1, y2);
        ((0.4 + 0.6 * e).clamp(0.0, 1.0) as f32, (0.85 + 0.15 * e) as f32)
    }
    /// The curve has ended and the last frames (100 ms of margin) have been painted.
    pub(crate) fn pop_done(self, now: std::time::Instant) -> bool {
        now.saturating_duration_since(self.started).as_secs_f64() * 1000.0 >= self.delay_ms + self.cycle_ms + 100.0
    }
}
fn paint_animation_clock(animation: PaintAnimation) -> std::time::Instant {''')
# The leaf centre of every popping tag: the union of the bounds of its glyph / icon sprites.
edit(s, '    pub(crate) fn animation_for(&self, id: u64) -> Option<PaintAnimation> {', '''    fn pop_centres(&self) -> std::collections::HashMap<u64, (f32, f32)> {
        let mut boxes: std::collections::HashMap<u64, [f32; 4]> = std::collections::HashMap::new();
        for (&index, &(id, _, _, animation, _)) in &self.repaint_tags {
            if !animation.is_some_and(|a| a.pop) { continue; }
            let b = match &self.paint_operations[index] {
                PaintOperation::Primitive(Primitive::MonochromeSprite(p)) => p.bounds,
                PaintOperation::Primitive(Primitive::SubpixelSprite(p)) => p.bounds,
                _ => continue,
            };
            let (x0, y0, x1, y1) = (b.origin.x.0, b.origin.y.0, b.origin.x.0 + b.size.width.0, b.origin.y.0 + b.size.height.0);
            let e = boxes.entry(id).or_insert([x0, y0, x1, y1]);
            e[0] = e[0].min(x0); e[1] = e[1].min(y0); e[2] = e[2].max(x1); e[3] = e[3].max(y1);
        }
        boxes.into_iter().map(|(id, b)| (id, ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5))).collect()
    }
    pub(crate) fn animation_for(&self, id: u64) -> Option<PaintAnimation> {''')
edit(s, 'if animation.is_none() || !seen.insert(id) { return None; }', 'if animation.is_none() || animation.is_some_and(|a| a.pop && a.pop_done(paint_animation_clock(a))) || !seen.insert(id) { return None; }')
edit(s, 'for (&index, &(id, kind, inherited_opacity, animation, _)) in &self.repaint_tags {', 'let pop_centres = self.pop_centres();\n        for (&index, &(id, kind, inherited_opacity, animation, _)) in &self.repaint_tags {')
pop_matrix = '''                    if let Some(animation) = animation.filter(|animation| animation.pop) {
                        if let Some(&(cx, cy)) = pop_centres.get(&id) {
                            let scale = animation.pop_state(paint_animation_clock(animation)).1;
                            let grow = TransformationMatrix::unit().translate(Point::new(ScaledPixels(cx), ScaledPixels(cy))).scale(crate::Size { width: scale, height: scale }).translate(Point::new(ScaledPixels(-cx), ScaledPixels(-cy)));
                            %s
                        }
                    }
'''
edit(s, '                    if let Some(animation) = animation.filter(|animation| animation.rotate) {', pop_matrix % '''sprite.transformation = grow;
                            self.monochrome_sprites[self.repaint_slots[&index].1].transformation = grow;''' + '                    if let Some(animation) = animation.filter(|animation| animation.rotate) {')
edit(s, '''                    sprite.color=color;
                    self.subpixel_sprites[self.repaint_slots[&index].1].color=color;''', '''                    sprite.color=color;
                    self.subpixel_sprites[self.repaint_slots[&index].1].color=color;
''' + (pop_matrix % '''sprite.transformation = grow;
                            self.subpixel_sprites[self.repaint_slots[&index].1].transformation = grow;'''))
# Debug aid (`KYBERN_DEBUG_PAINT_ANIMATION=1`): say why a paint animation stopped asking for frames (a tagged leaf lost its paint).
edit(s, '        !updates.is_empty() && self.repaint_tagged_inner(&updates, false)', '''        if updates.is_empty() { return false; }
        let ok = self.repaint_tagged_inner(&updates, false);
        if !ok && std::env::var_os("KYBERN_DEBUG_PAINT_ANIMATION").is_some() {
            let present: std::collections::HashSet<u64> = self.repaint_tags.values().map(|t| t.0).collect();
            eprintln!("[paint-animation] stopped: {} tagged leaves, ids without paint: {:?}", updates.len(), updates.iter().filter(|(id, _)| !present.contains(id)).map(|(id, _)| *id).collect::<Vec<_>>());
        }
        ok''')
