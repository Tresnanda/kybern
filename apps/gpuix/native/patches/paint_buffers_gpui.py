# Executed after paint_gpui.py. Keep the operation log and sorted GPU buffers in
# sync without replaying every unrelated primitive for a passive leaf tint.
s = 'crates/gpui/src/scene.rs'
edit(s, '    pub(crate) active_repaint_tag:', '    repaint_slots: std::collections::HashMap<usize, (u8, usize)>,\n    pub(crate) active_repaint_tag:')
edit(s, '        self.repaint_tags.clear();', '        self.repaint_tags.clear();\n        self.repaint_slots.clear();')
edit(s, '''            if !valid { return false; }
            found.insert(id);''', '''            let Some(&(slot_kind, slot)) = self.repaint_slots.get(&index) else { return false; };
            if !valid || slot_kind != kind || match kind {
                0 => slot >= self.quads.len(),
                1 => slot >= self.monochrome_sprites.len(),
                _ => true,
            } { return false; }
            found.insert(id);''')
edit(s, '''                (PaintOperation::Primitive(Primitive::Quad(quad)), 0) => quad.background = color.into(),
                (PaintOperation::Primitive(Primitive::MonochromeSprite(sprite)), 1) => sprite.color = color,''', '''                (PaintOperation::Primitive(Primitive::Quad(quad)), 0) => {
                    quad.background = color.into();
                    self.quads[self.repaint_slots[&index].1].background = quad.background;
                },
                (PaintOperation::Primitive(Primitive::MonochromeSprite(sprite)), 1) => {
                    sprite.color = color;
                    self.monochrome_sprites[self.repaint_slots[&index].1].color = color;
                },''')
edit(s, '''        // Rebuild only the typed scene arrays / bounds ordering. Replaying the
        // operation log preserves cached view ranges, atlas tiles and backdrop
        // barriers. No element render, layout or prepaint runs here.
        let previous = std::mem::take(self);
        self.replay(0..previous.len(), &previous);
        self.finish();''', '''        // Geometry and sort keys did not change. Preserve the scene's existing
        // buffers, bounds tree, atlas tiles, cached ranges and backdrop barriers.
        // Keep the previous algorithm selectable for same-binary measurements.
        static DIRECT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if !*DIRECT.get_or_init(|| std::env::var("KYBERN_SCOPED_BUFFERS").as_deref() != Ok("0")) {
            let previous = std::mem::take(self);
            self.replay(0..previous.len(), &previous);
            self.finish();
        }''')
edit(s, '    pub fn finish(&mut self) {', '''    pub fn finish(&mut self) {
        // Stable sorts below retain insertion order among equal keys. Derive
        // slots from the same operation order, including untagged primitives.
        // This work happens only after an ordinary scene rebuild, never per tint.
        self.repaint_slots.clear();
        if !self.repaint_tags.is_empty() {
            let mut quads = Vec::new();
            let mut sprites = Vec::new();
            for (index, operation) in self.paint_operations.iter().enumerate() {
                match operation {
                    PaintOperation::Primitive(Primitive::Quad(q)) => quads.push((index, q.order)),
                    PaintOperation::Primitive(Primitive::MonochromeSprite(p)) => sprites.push((index, (p.order, p.tile.tile_id))),
                    _ => {},
                }
            }
            quads.sort_by_key(|(_, order)| *order);
            sprites.sort_by_key(|(_, order)| *order);
            for (slot, (index, _)) in quads.into_iter().enumerate() {
                if self.repaint_tags.contains_key(&index) { self.repaint_slots.insert(index, (0, slot)); }
            }
            for (slot, (index, _)) in sprites.into_iter().enumerate() {
                if self.repaint_tags.contains_key(&index) { self.repaint_slots.insert(index, (1, slot)); }
            }
        }''')
