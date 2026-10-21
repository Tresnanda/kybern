# Text inside a retained translation keeps the glyphs a pan will bring into view (lane polish1). Executed from
# backdrop_gpui.py after the subtree translation patch.
#
# `paint_line` skips every glyph whose box misses the content mask. A retained translation (`paintTranslate`) then moves
# only what was painted: a sidebar title's marquee panned the glyphs that fit the row's clip out of view and never showed
# its tail, so the title emptied. Inside a translation scope glyphs are culled against the mask widened sideways by
# `KYBERN_TRANSLATED_TEXT_REACH` (a pan's reach); the mask still clips them in the shader, and text elsewhere is unchanged.
edit('crates/gpui/src/text_system/line.rs', 'if max_glyph_bounds.intersects(&content_mask.bounds) {', 'if max_glyph_bounds.intersects(&window.kybern_glyph_cull_bounds(content_mask.bounds)) {')
pending['crates/gpui/src/window.rs'] += '''
/// How far past the content mask (logical px, sideways) a translated line keeps its glyphs.
const KYBERN_TRANSLATED_TEXT_REACH: f32 = 2048.0;
impl Window {
    /// The bounds a glyph must reach to be painted: the content mask, widened sideways inside a retained translation.
    pub(crate) fn kybern_glyph_cull_bounds(&self, mask: Bounds<Pixels>) -> Bounds<Pixels> {
        if self.subtree_tags.is_empty() {
            return mask;
        }
        Bounds::new(point(mask.origin.x - px(KYBERN_TRANSLATED_TEXT_REACH), mask.origin.y), size(mask.size.width + px(2.0 * KYBERN_TRANSLATED_TEXT_REACH), mask.size.height))
    }
}
'''
(root / 'crates/gpui/src/text_system/line.rs').write_text(pending['crates/gpui/src/text_system/line.rs'])
(root / 'crates/gpui/src/window.rs').write_text(pending['crates/gpui/src/window.rs'])
