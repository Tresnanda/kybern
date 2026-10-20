# N4 (lane gpuix-native): the desktop's true `t-shimmer` and a hue loop as declarative paint animations.
# - `paintAnimation: { kind: 'shimmer', cycleMs, highlight }` on a `Label`: the base text stays in its colour and a soft
#   highlight band (`linear-gradient(90deg, transparent 40%, highlight 50%, transparent 60%)` at `background-size: 400%`,
#   `background-position: 100% -> 0%` linear) sweeps across it once per cycle, left to right. Each glyph sprite takes
#   `mix(base, highlight, w)` for its own centre, so the band crosses the word glyph by glyph. Without `highlight` the
#   shimmer keeps its brightness pulse. In Core Animation each glyph layer animates its colour with keyframes sampled
#   at its own position.
# - `paintAnimation: { kind: 'hue', cycleMs }` on a fill or single-colour leaf: `filter: hue-rotate(0 -> 360deg)
#   saturate(1.2)` (`.ultrathink-chroma`), in the scene only.
# Executed from backdrop_gpui.py after compositor_loops_gpui.py; anchors are lines paint_text_gpui.py, rotate_gpui.py,
# pop_gpui.py and compositor_loops_gpui.py write.
s = 'crates/gpui/src/scene.rs'
m = 'crates/gpui_apple/src/metal_renderer.rs'
edit(s, '    pub pop: bool,\n    pub started: std::time::Instant,\n}', '''    pub pop: bool,
    /// A true shimmer: the highlight band's colour (with `shimmer`).
    pub band: Option<Hsla>,
    /// A hue loop: one turn of the colour wheel per cycle, saturated 1.2.
    pub hue: bool,
    pub started: std::time::Instant,
}''')
edit(s, '&& self.rotate == other.rotate && self.pop == other.pop\n    }', '&& self.rotate == other.rotate && self.pop == other.pop && self.band == other.band && self.hue == other.hue\n    }')
edit(s, '        if self.rotate { return 1.0; }\n', '        if self.rotate || self.band.is_some() || self.hue { return 1.0; }\n')
edit(s, '''                let mut next = color;
                next.a = (color.a * animation.opacity(at)).clamp(0.0,1.0);
                (id,next)''', '''                let mut next = color;
                next.a = (color.a * animation.opacity(at)).clamp(0.0,1.0);
                if animation.hue {
                    next.h = (next.h + animation.phase(at) as f32).fract();
                    next.s = (next.s * 1.2).min(1.0);
                }
                (id,next)''')
pending[s] += '''
impl PaintAnimation {
    /// Fraction of the current cycle at `at` (0 during the delay).
    pub(crate) fn phase(self, at: std::time::Instant) -> f64 {
        let elapsed = at.saturating_duration_since(self.started).as_secs_f64() * 1000.0 - self.delay_ms;
        if elapsed <= 0.0 || self.cycle_ms <= 0.0 { 0.0 } else { (elapsed % self.cycle_ms) / self.cycle_ms }
    }
}
/// The shimmer band's weight at `u` (0 at the label's left edge, 1 at its right) and cycle `phase`: the band's centre
/// travels from one label width left of it to two widths right (`background-position: 100% -> 0%` of a 400% gradient),
/// fading linearly over 0.4 widths each side of the centre.
pub fn shimmer_band_weight(u: f32, phase: f64) -> f32 {
    let centre = -1.0 + 3.0 * phase as f32;
    (1.0 - (u - centre).abs() / 0.4).max(0.0)
}
/// The base text with the band's highlight over it at `weight` (source-over of an opaque highlight at that alpha).
pub fn shimmer_band_mix(base: Hsla, highlight: Hsla, weight: f32) -> Hsla {
    let (b, h) = (crate::Rgba::from(base), crate::Rgba::from(highlight));
    let w = (weight * h.a).clamp(0.0, 1.0);
    let a = w + b.a * (1.0 - w);
    if a <= 0.0 { return base; }
    let mix = |x: f32, y: f32| (y * w + x * b.a * (1.0 - w)) / a;
    Hsla::from(crate::Rgba { r: mix(b.r, h.r), g: mix(b.g, h.g), b: mix(b.b, h.b), a })
}
impl Scene {
    /// The horizontal extent of every banded shimmer leaf: the union of its glyph sprites.
    fn band_spans(&self) -> std::collections::HashMap<u64, (f32, f32)> {
        let mut spans: std::collections::HashMap<u64, (f32, f32)> = std::collections::HashMap::new();
        for (&index, &(id, _, _, animation, _)) in &self.repaint_tags {
            if !animation.is_some_and(|a| a.band.is_some()) { continue; }
            let b = match &self.paint_operations[index] {
                PaintOperation::Primitive(Primitive::MonochromeSprite(p)) => p.bounds,
                PaintOperation::Primitive(Primitive::SubpixelSprite(p)) => p.bounds,
                _ => continue,
            };
            let e = spans.entry(id).or_insert((b.origin.x.0, b.origin.x.0 + b.size.width.0));
            e.0 = e.0.min(b.origin.x.0); e.1 = e.1.max(b.origin.x.0 + b.size.width.0);
        }
        spans
    }
}
'''
edit(s, 'let pop_centres = self.pop_centres();\n', 'let pop_centres = self.pop_centres();\n        let band_spans = self.band_spans();\n')
band = '''                    if let (Some(animation), Some(highlight)) = (animation, animation.and_then(|a| a.band)) {
                        if let Some(&(x0, x1)) = band_spans.get(&id) {
                            let u = (sprite.bounds.origin.x.0 + sprite.bounds.size.width.0 / 2.0 - x0) / (x1 - x0).max(1.0);
                            let tint = shimmer_band_mix(color, highlight.opacity(inherited_opacity), shimmer_band_weight(u, animation.phase(paint_animation_clock(animation))));
                            sprite.color = tint;
                            %s
                        }
                    }
'''
edit(s, '                    if let Some(animation) = animation.filter(|animation| animation.rotate) {', band % 'self.monochrome_sprites[self.repaint_slots[&index].1].color = tint;' + '                    if let Some(animation) = animation.filter(|animation| animation.rotate) {')
edit(s, '''                    sprite.color=color;
                    self.subpixel_sprites[self.repaint_slots[&index].1].color=color;
''', '''                    sprite.color=color;
                    self.subpixel_sprites[self.repaint_slots[&index].1].color=color;
''' + band % 'self.subpixel_sprites[self.repaint_slots[&index].1].color = tint;')
# Core Animation: a banded glyph layer animates its colour with keyframes sampled at its own position; hue stays in the scene.
edit(s, '    pub rotate: bool,\n    pub started: std::time::Instant,\n}\n/// Whether stable passive loops', '''    pub rotate: bool,
    /// A banded shimmer's highlight and this glyph's position across its label (0..1).
    pub band: Option<Hsla>,
    pub band_u: f32,
    pub started: std::time::Instant,
}
/// Whether stable passive loops''')
edit(s, '        if a.pop { return Err("pop"); }', '        if a.pop { return Err("pop"); }\n        if a.hue { return Err("hue"); }')
edit(s, '''                    breathe: a.breathe, shimmer: a.shimmer, rotate: a.rotate, started: a.started })''', '''                    breathe: a.breathe, shimmer: a.shimmer, rotate: a.rotate, band: a.band.map(|h| h.opacity(inherited)), band_u: 0., started: a.started })''')
edit(s, '''        for (_, mut leaf) in parts {
            leaf.sort_by_key(|(index, _)| *index);''', '''        for (_, mut leaf) in parts {
            leaf.sort_by_key(|(index, _)| *index);
            if leaf.first().is_some_and(|(_, l)| l.band.is_some()) {
                let (x0, x1) = leaf.iter().fold((f32::MAX, f32::MIN), |(a, b), (_, l)| (a.min(l.bounds.origin.x.0), b.max(l.bounds.origin.x.0 + l.bounds.size.width.0)));
                for (_, l) in &mut leaf { l.band_u = (l.bounds.origin.x.0 + l.bounds.size.width.0 / 2.0 - x0) / (x1 - x0).max(1.0); }
            }''')
for name in [s]:
    (root / name).write_text(pending[name])
