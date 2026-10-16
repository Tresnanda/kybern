# Executed at the end of backdrop_gpui.py, sharing its pinned-source edit table.
s = 'crates/gpui/src/scene.rs'
edit(s, '    pub(crate) paint_operations: Vec<PaintOperation>,', '''    pub(crate) paint_operations: Vec<PaintOperation>,
    // A tag identifies a passive fixed-geometry leaf, never a scene position.
    // Kept outside GPU structs; shader layouts and primitive ordering are unchanged.
    pub(crate) active_repaint_tag: Option<(u64, u8, f32)>,
    repaint_tags: std::collections::HashMap<usize, (u64, u8, f32)>,''')
edit(s, '        self.paint_operations.clear();', '        self.paint_operations.clear();\n        self.repaint_tags.clear();\n        self.active_repaint_tag = None;')
edit(s, '        self.paint_operations\n            .push(PaintOperation::Primitive(primitive));', '''        if let Some(tag) = self.active_repaint_tag {
            self.repaint_tags.insert(self.paint_operations.len(), tag);
        }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));''')
edit(s, '        for operation in &prev_scene.paint_operations[range] {', '''        let previous_tag = self.active_repaint_tag;
        for index in range {
            self.active_repaint_tag = prev_scene.repaint_tags.get(&index).copied();
            let operation = &prev_scene.paint_operations[index];''')
edit(s, '                PaintOperation::EndLayer => self.pop_layer(),\n            }\n        }\n    }', '                PaintOperation::EndLayer => self.pop_layer(),\n            }\n        }\n        self.active_repaint_tag = previous_tag;\n    }')
edit(s, '    pub fn finish(&mut self) {', '''    /// Replace only recorded quad fills / monochrome tint, preserving geometry,
    /// clipping, layer order and hit testing. All tags validate before mutation.
    pub(crate) fn repaint_tagged(&mut self, updates: &[(u64, Hsla)]) -> bool {
        let colors: std::collections::HashMap<_, _> = updates.iter().copied().collect();
        let mut found = std::collections::HashSet::new();
        for (&index, &(id, kind, _)) in &self.repaint_tags {
            if !colors.contains_key(&id) { continue; }
            let valid = matches!((&self.paint_operations[index], kind),
                (PaintOperation::Primitive(Primitive::Quad(_)), 0) |
                (PaintOperation::Primitive(Primitive::MonochromeSprite(_)), 1));
            if !valid { return false; }
            found.insert(id);
        }
        if found.len() != colors.len() { return false; }
        for (&index, &(id, kind, inherited_opacity)) in &self.repaint_tags {
            let Some(color) = colors.get(&id) else { continue; };
            let color = color.opacity(inherited_opacity);
            match (&mut self.paint_operations[index], kind) {
                (PaintOperation::Primitive(Primitive::Quad(quad)), 0) => quad.background = color.into(),
                (PaintOperation::Primitive(Primitive::MonochromeSprite(sprite)), 1) => sprite.color = color,
                _ => unreachable!("validated above"),
            }
        }
        // Rebuild only the typed scene arrays / bounds ordering. Replaying the
        // operation log preserves cached view ranges, atlas tiles and backdrop
        // barriers. No element render, layout or prepaint runs here.
        let previous = std::mem::take(self);
        self.replay(0..previous.len(), &previous);
        self.finish();
        true
    }

    pub fn finish(&mut self) {''')
w = 'crates/gpui/src/window.rs'
edit(w, '    pub fn refresh(&mut self) {', '''    /// Tag passive leaf paint for a subsequent geometry-preserving update.
    pub fn with_repaint_tag<R>(&mut self, id: u64, kind: u8, paint: impl FnOnce(&mut Self) -> R) -> R {
        let tag = (id, kind, self.element_opacity());
        let previous = self.next_frame.scene.active_repaint_tag.replace(tag);
        let result = paint(self);
        self.next_frame.scene.active_repaint_tag = previous;
        result
    }

    /// Present updated leaf paint without invalidating view/layout caches.
    /// Returns false for missing, clipped or unsupported paint, so callers can
    /// use their normal full invalidation path. Metal still presents the scene.
    pub fn repaint_tagged(&mut self, updates: &[(u64, crate::Hsla)]) -> bool {
        if !self.invalidator.not_drawing() || !self.rendered_frame.scene.repaint_tagged(updates) { return false; }
        self.needs_present.set(true);
        // Demand-driven platforms stop their display source when there are no
        // dirty views or frame callbacks. Keep one callback pending so a paint-
        // only request cannot be dropped as the previous frame goes idle.
        self.on_next_frame(|window, _| window.needs_present.set(true));
        true
    }

    /// Mark the window dirty and bypass view caches on the next frame.
    pub fn refresh(&mut self) {''')
