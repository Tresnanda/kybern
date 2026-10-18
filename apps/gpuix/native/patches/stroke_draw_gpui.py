# Paint-only stroke draw-in (motion10): `paintAnimation: {kind: 'stroke'}` on an SVG (`t-check-draw` / `t-success path`).
# Executed at the end of backdrop_gpui.py, after stream_fade_gpui.py (anchors include lines it, frame_gpui.py and
# subtree_transform_gpui.py write). Code: stroke_draw_scene.rs (scene) and stroke_draw_window.rs (window).
s = 'crates/gpui/src/scene.rs'
w = 'crates/gpui/src/window.rs'
edit(s, '    pending_fade: Option<FadeTag>,', '''    pending_fade: Option<FadeTag>,
    pub(crate) active_stroke: Option<std::sync::Arc<StrokeDraw>>,
    pub(crate) stroke_tags: std::collections::HashMap<usize, std::sync::Arc<StrokeDraw>>,
    stroke_slots: std::collections::HashMap<usize, usize>,
    pending_stroke: Option<std::sync::Arc<StrokeDraw>>,''')
edit(s, '        self.fade_slots.clear();\n        self.pending_fade = None;', '        self.fade_slots.clear();\n        self.pending_fade = None;\n        self.active_stroke = None;\n        self.stroke_tags.clear();\n        self.stroke_slots.clear();\n        self.pending_stroke = None;')
edit(s, '        let fade_tag = self.fade_tag_for(&mut primitive);', '        let fade_tag = self.fade_tag_for(&mut primitive);\n        let stroke_tag = self.stroke_tag_for(&primitive);')
edit(s, '        if let Some(tag) = fade_tag { self.fade_tags.insert(self.paint_operations.len(), tag); }', '        if let Some(tag) = fade_tag { self.fade_tags.insert(self.paint_operations.len(), tag); }\n        if let Some(tag) = stroke_tag { self.stroke_tags.insert(self.paint_operations.len(), tag); }')
edit(s, '            self.pending_fade = prev_scene.fade_tags.get(&index).copied();', '            self.pending_fade = prev_scene.fade_tags.get(&index).copied();\n            self.pending_stroke = prev_scene.stroke_tags.get(&index).cloned();')
edit(s, '        self.pending_transform_base = None;\n        self.pending_fade = None;', '        self.pending_transform_base = None;\n        self.pending_fade = None;\n        self.pending_stroke = None;')
edit(s, '    pub fn finish(&mut self) {\n        self.fade_slots_update();', '    pub fn finish(&mut self) {\n        self.fade_slots_update();\n        self.stroke_slots_update();')
pending[s] += '\ninclude!("stroke_draw_scene.rs");\n'
edit(w, '    paint_animation_scheduled: bool,', '    paint_animation_scheduled: bool,\n    stroke_draws: std::collections::HashMap<u64, std::sync::Arc<crate::scene::StrokeDraw>>,\n    stroke_svg_renderer: Option<crate::SvgRenderer>,')
edit(w, '            paint_animation_scheduled: false,', '            paint_animation_scheduled: false,\n            stroke_draws: Default::default(),\n            stroke_svg_renderer: None,')
edit(w, '        let animated = self.rendered_frame.scene.animate_fades() | animated;', '        let animated = self.rendered_frame.scene.animate_fades() | animated;\n        let animated = self.animate_strokes() | animated;')
pending[w] += '\ninclude!("stroke_draw_window.rs");\n'
for name in ['stroke_draw_scene.rs', 'stroke_draw_window.rs']:
    dest = root / 'crates/gpui/src' / name
    text = (here / name).read_text()
    if not dest.exists() or dest.read_text() != text: dest.write_text(text)
