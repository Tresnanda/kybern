# Paint-only streaming fade (render9) and two pop fixes. Executed at the end of backdrop_gpui.py, after
# subtree_transform_gpui.py (anchors include lines that patch, paint_gpui.py, pop_gpui.py and
# paint_region_gpui.py write). Code: stream_fade.rs (scene) and stream_fade_window.rs (window).
s = 'crates/gpui/src/scene.rs'
w = 'crates/gpui/src/window.rs'
edit(s, '    pending_transform_base: Option<(Primitive, std::sync::Arc<crate::window::SubtreeTransformContext>)>,', '''    pending_transform_base: Option<(Primitive, std::sync::Arc<crate::window::SubtreeTransformContext>)>,
    pub(crate) active_fade: Option<Vec<FadeWord>>,
    pub(crate) fade_tags: std::collections::HashMap<usize, FadeTag>,
    fade_slots: std::collections::HashMap<usize, (u8, usize)>,
    pending_fade: Option<FadeTag>,''')
edit(s, '        self.transform_bases.clear();\n        self.active_transform = None;\n        self.pending_transform_base = None;', '        self.transform_bases.clear();\n        self.active_transform = None;\n        self.pending_transform_base = None;\n        self.active_fade = None;\n        self.fade_tags.clear();\n        self.fade_slots.clear();\n        self.pending_fade = None;')
edit(s, '        match &mut primitive {\n            Primitive::Backdrop(b) => { b.order=order; self.backdrops.push(*b); },', '        let fade_tag = self.fade_tag_for(&mut primitive);\n        match &mut primitive {\n            Primitive::Backdrop(b) => { b.order=order; self.backdrops.push(*b); },')
edit(s, '        if let Some(base) = transform_base { self.transform_bases.insert(self.paint_operations.len(), base); }', '        if let Some(base) = transform_base { self.transform_bases.insert(self.paint_operations.len(), base); }\n        if let Some(tag) = fade_tag { self.fade_tags.insert(self.paint_operations.len(), tag); }')
edit(s, '            self.pending_transform_base = prev_scene.transform_bases.get(&index).cloned();', '            self.pending_transform_base = prev_scene.transform_bases.get(&index).cloned();\n            self.pending_fade = prev_scene.fade_tags.get(&index).copied();')
edit(s, '        self.active_subtree_geometry = previous_geometry;\n        self.pending_transform_base = None;', '        self.active_subtree_geometry = previous_geometry;\n        self.pending_transform_base = None;\n        self.pending_fade = None;')
edit(s, '    pub fn finish(&mut self) {', '    pub fn finish(&mut self) {\n        self.fade_slots_update();')
edit(s, '    pub(crate) fn animate_tagged(&mut self) -> bool {\n', '    pub(crate) fn animate_tagged(&mut self) -> bool {\n        self.finish_pops();\n')
# A finished pop no longer counts as a running loop, so region layers can park.
edit(s, "self.repaint_tags.values().any(|(_,_,_,animation,_)| animation.is_some())", "self.repaint_tags.values().any(|(_,_,_,animation,_)| animation.is_some_and(|a| !(a.pop && a.pop_done(paint_animation_clock(a)))))")
pending[s] += '\ninclude!("stream_fade.rs");\n'
edit(w, '        let animated = self.rendered_frame.scene.animate_tagged();', '        let animated = self.rendered_frame.scene.animate_tagged();\n        let animated = self.rendered_frame.scene.animate_fades() | animated;')
pending[w] += '\ninclude!("stream_fade_window.rs");\n'
for name in ['stream_fade.rs', 'stream_fade_window.rs']:
    dest = root / 'crates/gpui/src' / name
    text = (here / name).read_text()
    if not dest.exists() or dest.read_text() != text: dest.write_text(text)
