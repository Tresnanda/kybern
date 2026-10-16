# Only declarative simple-text pulses use this path. Text edits, geometry,
# selection and input still use ordinary layout/invalidation.
s='crates/gpui/src/scene.rs'
edit(s, '    pub breathe: bool,', '    pub breathe: bool,\n    pub shimmer: bool,')
edit(s, 'self.breathe == other.breathe', 'self.breathe == other.breathe && self.shimmer == other.shimmer')
edit(s, '(if self.breathe { 1.0 - 0.55*ease(', '(if self.shimmer { 1.0 + 0.6*ease(if phase<0.5 {phase*2.0} else {2.0-phase*2.0}) }\n        else if self.breathe { 1.0 - 0.55*ease(')
edit(s, 'animation.map(|animation| (id, color.opacity(animation.opacity(now))))', '''animation.map(|animation| {
                // Freeze only when explicitly requested by pixel comparisons.
                static PHASE: std::sync::OnceLock<Option<f64>> = std::sync::OnceLock::new();
                let phase = *PHASE.get_or_init(|| std::env::var("KYBERN_PAINT_PHASE_MS").ok().and_then(|v|v.parse::<f64>().ok()).filter(|v|v.is_finite() && *v>=0.0));
                let at = phase.map_or(now, |ms|animation.started + std::time::Duration::from_secs_f64(ms/1000.0));
                let mut next = color;
                next.a = (color.a * animation.opacity(at)).clamp(0.0,1.0);
                (id,next)
            })''')
edit(s, '''            self.repaint_tags.insert(self.paint_operations.len(), tag);''', '''            // Selection washes and other decoration keep their own colors.
            if tag.1 != 2 || matches!(&primitive, Primitive::MonochromeSprite(_) | Primitive::SubpixelSprite(_)) {
                self.repaint_tags.insert(self.paint_operations.len(), tag);
            }''')
edit(s, '''                (PaintOperation::Primitive(Primitive::MonochromeSprite(_)), 1));''', '''                (PaintOperation::Primitive(Primitive::MonochromeSprite(_)), 1 | 2) |
                (PaintOperation::Primitive(Primitive::SubpixelSprite(_)), 2));''')
edit(s, 'slot_kind != kind || match kind {', '(slot_kind != kind && !(kind == 2 && slot_kind == 3)) || match slot_kind {')
edit(s, '                1 => slot >= self.monochrome_sprites.len(),', '                1 | 2 => slot >= self.monochrome_sprites.len(),\n                3 => slot >= self.subpixel_sprites.len(),')
edit(s, '(PaintOperation::Primitive(Primitive::MonochromeSprite(sprite)), 1) => {', '(PaintOperation::Primitive(Primitive::MonochromeSprite(sprite)), 1 | 2) => {')
edit(s, '''                _ => unreachable!("validated above"),''', '''                (PaintOperation::Primitive(Primitive::SubpixelSprite(sprite)), 2) => {
                    sprite.color=color;
                    self.subpixel_sprites[self.repaint_slots[&index].1].color=color;
                },
                _ => unreachable!("validated above"),''')
edit(s, '            let mut sprites = Vec::new();', '            let mut sprites = Vec::new();\n            let mut subpixel = Vec::new();')
edit(s, '                    _ => {},\n                }\n            }\n            quads.sort_by_key', '                    PaintOperation::Primitive(Primitive::SubpixelSprite(p)) => subpixel.push((index,(p.order,p.tile.tile_id))),\n                    _ => {},\n                }\n            }\n            quads.sort_by_key')
edit(s, '            sprites.sort_by_key(|(_, order)| *order);', '            sprites.sort_by_key(|(_, order)| *order);\n            subpixel.sort_by_key(|(_, order)| *order);')
edit(s, 'self.repaint_slots.insert(index, (1, slot));', 'self.repaint_slots.insert(index, (self.repaint_tags[&index].1, slot));')
edit(s, '''        }
        self.backdrops.sort_by_key''', '''            for (slot,(index,_)) in subpixel.into_iter().enumerate() {
                if self.repaint_tags.contains_key(&index) { self.repaint_slots.insert(index,(3,slot)); }
            }
        }
        self.backdrops.sort_by_key''')
