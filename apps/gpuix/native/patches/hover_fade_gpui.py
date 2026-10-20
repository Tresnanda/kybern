# Paint-only hover/active colour transitions (N1, lane gpuix-native): `InteractiveElement::color_transition` eases an
# element's background and border colours across hover flips and press releases; frames after the flip re-tint the
# tagged quads in place. Executed from backdrop_gpui.py after compositor_loops_gpui.py (anchors include lines written by
# paint_gpui.py, subtree_transform_gpui.py, stroke_draw_gpui.py and compositor_loops_gpui.py).
s = 'crates/gpui/src/scene.rs'
w = 'crates/gpui/src/window.rs'
d = 'crates/gpui/src/elements/div.rs'
# Scene: quads painted under an active fade keep its tag; replay carries it like the other tags.
edit(s, '    pending_stroke: Option<std::sync::Arc<StrokeDraw>>,', '''    pending_stroke: Option<std::sync::Arc<StrokeDraw>>,
    pub(crate) active_color_fade: Option<(std::sync::Arc<crate::window::ColorFadeTag>, u8)>,
    pub(crate) color_fades: std::collections::HashMap<usize, (std::sync::Arc<crate::window::ColorFadeTag>, u8)>,
    color_fade_slots: std::collections::HashMap<usize, usize>,''')
edit(s, '        self.stroke_slots.clear();\n        self.pending_stroke = None;\n', '        self.stroke_slots.clear();\n        self.pending_stroke = None;\n        self.active_color_fade = None;\n        self.color_fades.clear();\n        self.color_fade_slots.clear();\n')
edit(s, '        if let Some(tag) = stroke_tag { self.stroke_tags.insert(self.paint_operations.len(), tag); }', '''        if let Some(tag) = stroke_tag { self.stroke_tags.insert(self.paint_operations.len(), tag); }
        if let (Some(tag), Primitive::Quad(_)) = (&self.active_color_fade, &primitive) { self.color_fades.insert(self.paint_operations.len(), tag.clone()); }''')
edit(s, '        let previous_tag = self.active_repaint_tag;\n        for index in range {\n', '        let previous_tag = self.active_repaint_tag;\n        let previous_color_fade = self.active_color_fade.take();\n        for index in range {\n            self.active_color_fade = prev_scene.color_fades.get(&index).cloned();\n')
edit(s, '        self.pending_fade = None;\n        self.pending_stroke = None;\n    }', '        self.pending_fade = None;\n        self.pending_stroke = None;\n        self.active_color_fade = previous_color_fade;\n    }')
edit(s, '        self.fade_slots_update();\n        self.stroke_slots_update();', '        self.fade_slots_update();\n        self.stroke_slots_update();\n        self.color_fade_slots_update();')
pending[s] += '\ninclude!("hover_fade_scene.rs");\n'
# Window: fades advance before every present, and keep frames coming while one runs.
edit(w, '        let animated = self.animate_strokes() | animated;', '        let animated = self.animate_strokes() | animated;\n        let animated = self.rendered_frame.scene.animate_color_fades() | animated;')
pending[w] += '\ninclude!("hover_fade_window.rs");\n'
# Div: the declaration, the per-element state, and the paint that decides the colour shown.
edit(d, '    pub(crate) group_active_style: Option<GroupStyle>,\n', '    pub(crate) group_active_style: Option<GroupStyle>,\n    pub(crate) color_transition: Option<crate::ColorTransition>,\n')
edit(d, '    pub(crate) active_tooltip: Option<Rc<RefCell<Option<ActiveTooltip>>>>,\n}', '    pub(crate) active_tooltip: Option<Rc<RefCell<Option<ActiveTooltip>>>>,\n    pub(crate) color_fade: Option<crate::window::ColorFadeState>,\n}')
edit(d, '    /// Apply the given style to this element when the mouse hovers over it\n    fn hover(', '''    /// Ease background and border colour changes caused by hover and press release (Kybern).
    fn color_transition(mut self, transition: crate::ColorTransition) -> Self {
        self.interactivity().color_transition = Some(transition);
        self
    }

    /// Apply the given style to this element when the mouse hovers over it
    fn hover(''')
edit(d, '                let style = self.compute_style_internal(hitbox, element_state.as_mut(), window, cx);\n\n                #[cfg(any(feature = "test-support", test))]', '''                let mut style = self.compute_style_internal(hitbox, element_state.as_mut(), window, cx);
                let kybern_fade = self.color_transition.and_then(|transition| {
                    let hovered = self.hover_style.is_some() && !cx.has_active_drag() && hitbox.is_some_and(|hitbox| hitbox.is_hovered(window));
                    let pressed = self.active_style.is_some()
                        && element_state.as_ref().and_then(|state| state.clicked_state.as_ref()).is_some_and(|state| state.borrow().element);
                    let state = element_state.as_mut()?;
                    crate::window::kybern_color_fade(transition, &mut state.color_fade, &mut style, &self.base_style, hovered, pressed)
                });

                #[cfg(any(feature = "test-support", test))]''')
edit(d, '                window.with_element_opacity(style.opacity, |window| {\n                    style.paint(bounds, window, cx, |window: &mut Window, cx: &mut App| {', '                window.with_element_opacity(style.opacity, |window| {\n                    window.kybern_paint_style_with_fade(&style, kybern_fade, bounds, cx, |window: &mut Window, cx: &mut App| {')
for name in ['hover_fade_window.rs', 'hover_fade_scene.rs']:
    dest = root / 'crates/gpui/src' / name
    text = (here / name).read_text()
    if not dest.exists() or dest.read_text() != text: dest.write_text(text)
for name in [s, w, d]:
    (root / name).write_text(pending[name])
