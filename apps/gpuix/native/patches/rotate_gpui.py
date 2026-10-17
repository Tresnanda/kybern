# Continuous rotation as a declarative paint animation (`paintAnimation: {kind: 'rotate', cycleMs}`) on a
# passive fixed-size SVG leaf. Executed at the end of backdrop_gpui.py, after paint_gpui.py and
# paint_text_gpui.py, so it edits their output (anchors below are lines those patches write).
#
# The scene already re-evaluates tagged leaves at every presented frame without element render, layout or
# prepaint (`animate_tagged` -> `repaint_tagged_inner`), which is what makes a matrix loader cheap. A rotating
# glyph only needs one more per-frame update on that path: the monochrome sprite's `transformation`, a
# rotation about the sprite's centre (the same matrix `Svg::paint` builds for a static rotation). Colour and
# opacity are untouched. Nothing in a GPU struct layout changes.
s = 'crates/gpui/src/scene.rs'
edit(s, '    pub shimmer: bool,', '    pub shimmer: bool,\n    pub rotate: bool,')
edit(s, 'self.breathe == other.breathe && self.shimmer == other.shimmer', 'self.breathe == other.breathe && self.shimmer == other.shimmer && self.rotate == other.rotate')
edit(s, '''    fn opacity(self, now: std::time::Instant) -> f32 {
''', '''    fn opacity(self, now: std::time::Instant) -> f32 {
        if self.rotate { return 1.0; }
''')
edit(s, 'impl Scene {\n    pub(crate) fn animation_for', '''impl PaintAnimation {
    /// Clockwise radians of a rotating glyph: one linear turn per `cycle_ms`.
    pub(crate) fn angle(self, at: std::time::Instant) -> f32 {
        let elapsed = at.saturating_duration_since(self.started).as_secs_f64() * 1000.0;
        ((elapsed % self.cycle_ms) / self.cycle_ms * std::f64::consts::TAU) as f32
    }
}
/// The animation clock, frozen by `KYBERN_PAINT_PHASE_MS` for pixel comparisons (as `animate_tagged` does).
fn paint_animation_clock(animation: PaintAnimation) -> std::time::Instant {
    static PHASE: std::sync::OnceLock<Option<f64>> = std::sync::OnceLock::new();
    let phase = *PHASE.get_or_init(|| std::env::var("KYBERN_PAINT_PHASE_MS").ok().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v >= 0.0));
    phase.map_or_else(std::time::Instant::now, |ms| animation.started + std::time::Duration::from_secs_f64(ms / 1000.0))
}
impl Scene {
    pub(crate) fn animation_for''')
edit(s, 'for (&index, &(id, kind, inherited_opacity, _, _)) in &self.repaint_tags {', 'for (&index, &(id, kind, inherited_opacity, animation, _)) in &self.repaint_tags {')
edit(s, '''                    sprite.color = color;
                    self.monochrome_sprites[self.repaint_slots[&index].1].color = color;''', '''                    sprite.color = color;
                    self.monochrome_sprites[self.repaint_slots[&index].1].color = color;
                    if let Some(animation) = animation.filter(|animation| animation.rotate) {
                        let centre = Point::new(ScaledPixels(sprite.bounds.origin.x.0 + sprite.bounds.size.width.0 / 2.0), ScaledPixels(sprite.bounds.origin.y.0 + sprite.bounds.size.height.0 / 2.0));
                        let turn = TransformationMatrix::unit().translate(centre).rotate(Radians(animation.angle(paint_animation_clock(animation)))).translate(Point::new(ScaledPixels(-centre.x.0), ScaledPixels(-centre.y.0)));
                        sprite.transformation = turn;
                        self.monochrome_sprites[self.repaint_slots[&index].1].transformation = turn;
                    }''')
