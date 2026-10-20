# Paint-only subtree transform (render9): scale / rotate / translate / opacity / blur about an origin.
# Executed at the end of backdrop_gpui.py, after subtree_translation_gpui.py: several anchors below are
# lines that translation patch writes. Code lives in subtree_transform_window.rs (window) and
# subtree_transform_a11y.rs (window/a11y.rs).
w = 'crates/gpui/src/window.rs'
s = 'crates/gpui/src/scene.rs'
edit(w, '    rounded_clip_pool: RoundedClipPool,', '    rounded_clip_pool: RoundedClipPool,\n    subtree_transform: SubtreeTransformState,')
edit(w, '            rounded_clip_pool: Default::default(),', '            rounded_clip_pool: Default::default(),\n            subtree_transform: Default::default(),')
edit(w, '            self.push_subtree_mask(mask);\n', '            self.push_subtree_mask(mask);\n            self.push_transform_mask(mask);\n')
edit(w, '            self.pop_subtree_mask();\n', '            self.pop_subtree_mask();\n            self.pop_transform_mask();\n')
edit(w, '    subtree_geometry: Option<SubtreeGeometry>,\n}', '    subtree_geometry: Option<SubtreeGeometry>,\n    transform_base: Option<(Bounds<Pixels>, std::sync::Arc<SubtreeTransformContext>)>,\n}')
edit(w, '            subtree_geometry: self.subtree_geometry(),\n        };\n        self.next_frame.hitboxes.push(hitbox.clone());', '            subtree_geometry: self.subtree_geometry(),\n            transform_base: None,\n        };\n        let hitbox = self.transform_hitbox(hitbox);\n        self.next_frame.hitboxes.push(hitbox.clone());')
pending[w] += '\ninclude!("subtree_transform_window.rs");\n'
edit('crates/gpui/src/element.rs', '                            window.record_subtree_a11y(node_id);', '                            window.record_subtree_a11y(node_id);\n                            window.transform_a11y_node(node_id, &mut node);')
a = 'crates/gpui/src/window/a11y.rs'
pending[a] += '\ninclude!("../subtree_transform_a11y.rs");\n'
# Scene: transformed primitives keep their untransformed base beside them; replay carries it.
edit(s, '    pub(crate) paint_operations: Vec<PaintOperation>,', '    pub(crate) paint_operations: Vec<PaintOperation>,\n    pub(crate) active_transform: Option<std::sync::Arc<crate::window::SubtreeTransformContext>>,\n    pub(crate) transform_bases: std::collections::HashMap<usize, (Primitive, std::sync::Arc<crate::window::SubtreeTransformContext>)>,\n    pending_transform_base: Option<(Primitive, std::sync::Arc<crate::window::SubtreeTransformContext>)>,\n    /// Every scope painted into this scene, including ones that drew nothing (an empty glyph slot fading back in).\n    pub(crate) transform_scopes: std::collections::HashSet<u64>,')
edit(s, '        self.paint_operations.clear();', '        self.paint_operations.clear();\n        self.transform_scopes.clear();\n        self.transform_bases.clear();\n        self.active_transform = None;\n        self.pending_transform_base = None;')
edit(s, '        let mut primitive = primitive.into();\n', '''        let mut primitive = primitive.into();
        let transform_base = match (self.pending_transform_base.take(), self.active_transform.clone()) {
            // Painted (or a cached range replayed) inside an active scope: map the untransformed base.
            (pending, Some(context)) => {
                let base = pending.map_or_else(|| primitive.clone(), |(base, _)| base);
                primitive = base.clone();
                primitive.transform_subtree(&context);
                Some((base, context))
            }
            // Replayed outside any scope (a retained update, an island holding its own scope): as recorded.
            (pending, None) => pending,
        };
''')
# A full replay (a retained update, a whole-scene cache hit) keeps the painted scopes; a partial one re-enters its own.
edit(s, '    pub fn replay(&mut self, range: Range<usize>, prev_scene: &Scene) {\n', '    pub fn replay(&mut self, range: Range<usize>, prev_scene: &Scene) {\n        if range.start == 0 && range.end == prev_scene.paint_operations.len() { self.transform_scopes.extend(prev_scene.transform_scopes.iter().copied()); }\n')
edit(s, 'if clipped_bounds.is_empty() && self.active_subtree_geometry.is_none() {', 'if clipped_bounds.is_empty() && self.active_subtree_geometry.is_none() && transform_base.is_none() {')
edit(s, '''        if let Some(geometry) = &self.active_subtree_geometry { self.subtree_geometries.insert(self.paint_operations.len(),geometry.clone()); }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));''', '''        if let Some(base) = transform_base { self.transform_bases.insert(self.paint_operations.len(), base); }
        if let Some(geometry) = &self.active_subtree_geometry { self.subtree_geometries.insert(self.paint_operations.len(),geometry.clone()); }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));''')
edit(s, '            let operation = &prev_scene.paint_operations[index];', '            self.pending_transform_base = prev_scene.transform_bases.get(&index).cloned();\n            let operation = &prev_scene.paint_operations[index];')
edit(s, '        self.active_repaint_tag = previous_tag;\n        self.active_subtree_geometry = previous_geometry;', '        self.active_repaint_tag = previous_tag;\n        self.active_subtree_geometry = previous_geometry;\n        self.pending_transform_base = None;')
for name, rel in [('subtree_transform_window.rs', 'crates/gpui/src/subtree_transform_window.rs'), ('subtree_transform_a11y.rs', 'crates/gpui/src/subtree_transform_a11y.rs')]:
    dest = root / rel
    text = (here / name).read_text()
    if not dest.exists() or dest.read_text() != text: dest.write_text(text)
